import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import {
  dokku,
  getContainerIp,
  getLdapCredentials,
  createLdapUser,
  waitForHealthy,
} from './helpers';

/**
 * Authentik + Grafana LDAP Integration E2E Test
 *
 * Tests the full stack with Authentik as the frontend provider:
 * 1. Create LLDAP directory service
 * 2. Create Authentik frontend (with bootstrap credentials)
 * 3. Deploy Grafana with LDAP config pointing to LLDAP
 * 4. Verify LDAP login works via Grafana HTTP API
 *
 * Note: This test uses LLDAP directly for LDAP authentication.
 * Authentik is present as the frontend but Grafana talks directly to LLDAP.
 * For OIDC-based auth through Authentik, see authentik-grafana-oidc.spec.ts.
 *
 * Requires: dokku postgres and redis plugins installed
 */

const DIRECTORY_SERVICE = 'ak-graf-ldap-dir';
const FRONTEND_SERVICE = 'ak-graf-ldap-fe';
const TEST_USER = 'akgrafuser';
const TEST_PASSWORD = 'AkGrafPass123!';
const TEST_EMAIL = 'akgrafuser@test.local';
const GRAFANA_CONTAINER = 'authentik-grafana-ldap-test';

let LDAP_CONTAINER_IP: string;
let AUTH_NETWORK: string;

test.describe('Authentik + Grafana LDAP Integration', () => {
  test.beforeAll(async () => {
    console.log('=== Setting up Authentik + Grafana LDAP test ===');

    // 1. Create LLDAP directory service
    console.log('Creating LLDAP directory service...');
    try {
      dokku(`auth:create ${DIRECTORY_SERVICE}`);
    } catch (e: any) {
      if (!e.stderr?.includes('already exists')) {
        throw e;
      }
    }

    // Wait for LLDAP to be healthy
    const ldapHealthy = await waitForHealthy(DIRECTORY_SERVICE, 'directory');
    if (!ldapHealthy) {
      throw new Error('LLDAP service not healthy');
    }

    LDAP_CONTAINER_IP = getContainerIp(`dokku.auth.directory.${DIRECTORY_SERVICE}`);
    console.log(`LLDAP container IP: ${LDAP_CONTAINER_IP}`);

    // Determine the auth network
    AUTH_NETWORK = execSync(
      `docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' dokku.auth.directory.${DIRECTORY_SERVICE}`,
      { encoding: 'utf-8' }
    ).trim().split(' ')[0];
    console.log(`Auth network: ${AUTH_NETWORK}`);

    // 2. Create Authentik frontend service
    console.log('Creating Authentik frontend service...');
    try {
      dokku(`auth:frontend:create ${FRONTEND_SERVICE} --provider authentik`);
    } catch (e: any) {
      if (!e.stderr?.includes('already exists')) {
        throw e;
      }
    }

    // Wait for Authentik to be healthy (this can take a while)
    console.log('Waiting for Authentik to be ready...');
    const authentikHealthy = await waitForHealthy(FRONTEND_SERVICE, 'frontend', 180000);
    if (!authentikHealthy) {
      try {
        const logs = dokku(`auth:frontend:logs ${FRONTEND_SERVICE} -n 50`);
        console.log('Authentik logs:', logs);
      } catch {}
      throw new Error('Authentik not healthy');
    }
    console.log('Authentik is ready');

    // 3. Get LDAP credentials and write Grafana ldap.toml
    const creds = getLdapCredentials(DIRECTORY_SERVICE);

    const ldapToml = `[[servers]]
host = "${LDAP_CONTAINER_IP}"
port = 3890
use_ssl = false
start_tls = false
bind_dn = "uid=admin,ou=people,${creds.BASE_DN}"
bind_password = "${creds.ADMIN_PASSWORD}"
search_filter = "(uid=%s)"
search_base_dns = ["ou=people,${creds.BASE_DN}"]

[servers.attributes]
username = "uid"
email = "mail"
name = "cn"
`;
    fs.writeFileSync('/tmp/authentik-grafana-ldap.toml', ldapToml);
    console.log('Wrote /tmp/authentik-grafana-ldap.toml');

    // 4. Deploy Grafana container
    console.log('Deploying Grafana container...');

    // Remove existing container if present
    try {
      execSync(`docker rm -f ${GRAFANA_CONTAINER}`, { encoding: 'utf-8', stdio: 'pipe' });
    } catch (e: any) {
      if (!e.stderr?.includes('No such container')) {
        console.log('[cleanup]', e.stderr?.trim() || e.message);
      }
    }

    execSync(
      `docker run -d --name ${GRAFANA_CONTAINER} ` +
        `--network ${AUTH_NETWORK} ` +
        `-v /tmp/authentik-grafana-ldap.toml:/etc/grafana/ldap.toml:ro ` +
        `-e GF_AUTH_LDAP_ENABLED=true ` +
        `-e GF_AUTH_LDAP_CONFIG_FILE=/etc/grafana/ldap.toml ` +
        `-e GF_AUTH_LDAP_ALLOW_SIGN_UP=true ` +
        `-e GF_SERVER_HTTP_PORT=3000 ` +
        `grafana/grafana-oss:latest`,
      { encoding: 'utf-8' }
    );

    // Wait for Grafana to be ready
    console.log('Waiting for Grafana to be ready...');
    let grafanaReady = false;
    for (let i = 0; i < 60; i++) {
      try {
        const result = execSync(
          `docker exec ${GRAFANA_CONTAINER} curl -sf http://localhost:3000/api/health`,
          { encoding: 'utf-8', timeout: 5000 }
        );
        const health = JSON.parse(result);
        if (health.database === 'ok') {
          grafanaReady = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!grafanaReady) {
      const logs = execSync(`docker logs ${GRAFANA_CONTAINER} 2>&1`, { encoding: 'utf-8' });
      console.log('Grafana logs:', logs);
      throw new Error('Grafana not ready');
    }
    console.log('Grafana is ready');

    // 5. Create test user in LLDAP
    const lldapContainer = `dokku.auth.directory.${DIRECTORY_SERVICE}`;
    createLdapUser(
      lldapContainer,
      creds.ADMIN_PASSWORD,
      TEST_USER,
      TEST_EMAIL,
      TEST_PASSWORD
    );

    // Small delay to ensure LDAP sync
    await new Promise((r) => setTimeout(r, 2000));

    console.log('=== Setup complete ===');
  }, 600000); // 10 minute timeout

  test.afterAll(async () => {
    console.log('=== Cleaning up Authentik + Grafana LDAP test ===');
    try {
      execSync(`docker rm -f ${GRAFANA_CONTAINER}`, { encoding: 'utf-8', stdio: 'pipe' });
    } catch (e: any) {
      if (!e.stderr?.includes('No such container')) {
        console.log('[cleanup]', e.stderr?.trim() || e.message);
      }
    }
    try {
      dokku(`auth:frontend:destroy ${FRONTEND_SERVICE} -f`, { quiet: true });
    } catch (e: any) {
      console.log('[cleanup] frontend:destroy:', e.stderr?.trim() || e.message);
    }
    try {
      dokku(`auth:destroy ${DIRECTORY_SERVICE} -f`, { quiet: true });
    } catch (e: any) {
      console.log('[cleanup] auth:destroy:', e.stderr?.trim() || e.message);
    }
  });

  test('Grafana health check returns ok', async () => {
    const result = execSync(
      `docker exec ${GRAFANA_CONTAINER} curl -sf http://localhost:3000/api/health`,
      { encoding: 'utf-8' }
    );
    const health = JSON.parse(result);
    expect(health.database).toBe('ok');
  });

  test('Authentik is running alongside LLDAP', async () => {
    const status = dokku(`auth:frontend:status ${FRONTEND_SERVICE}`);
    expect(status.toLowerCase()).toMatch(/healthy|running/);
  });

  test('LDAP login via API returns user info', async () => {
    const result = execSync(
      `docker exec ${GRAFANA_CONTAINER} curl -sf -u ${TEST_USER}:${TEST_PASSWORD} http://localhost:3000/api/user`,
      { encoding: 'utf-8' }
    );
    console.log('Grafana user API response:', result);
    const user = JSON.parse(result);
    expect(user.login).toBe(TEST_USER);
  });

  test('LDAP login returns email', async () => {
    const result = execSync(
      `docker exec ${GRAFANA_CONTAINER} curl -sf -u ${TEST_USER}:${TEST_PASSWORD} http://localhost:3000/api/user`,
      { encoding: 'utf-8' }
    );
    const user = JSON.parse(result);
    expect(user.email).toBe(TEST_EMAIL);
  });

  test('Bad password returns 401', async () => {
    const statusCode = execSync(
      `docker exec ${GRAFANA_CONTAINER} curl -s -o /dev/null -w "%{http_code}" ` +
        `-u ${TEST_USER}:wrongpassword http://localhost:3000/api/user`,
      { encoding: 'utf-8' }
    ).trim();
    console.log(`Bad password response status: ${statusCode}`);
    expect(statusCode).toBe('401');
  });

  test('LDAP status check succeeds', async () => {
    const result = execSync(
      `docker exec ${GRAFANA_CONTAINER} curl -sf -u admin:admin http://localhost:3000/api/admin/ldap/status`,
      { encoding: 'utf-8' }
    );
    console.log('LDAP status:', result);
    const status = JSON.parse(result);
    expect(Array.isArray(status)).toBe(true);
    expect(status.length).toBeGreaterThan(0);
  });
});
