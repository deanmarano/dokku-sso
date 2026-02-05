import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import {
  USE_SUDO,
  dokku,
  getContainerIp,
  getLdapCredentials,
  createLdapUser,
} from './helpers';

/**
 * Grafana LDAP Integration E2E Test
 *
 * Tests the integration of Grafana with LLDAP:
 * 1. Creating an LLDAP directory service
 * 2. Deploying Grafana container with LDAP config
 * 3. Verifying LDAP login works via Grafana HTTP API
 *
 * Note: This test uses docker exec curl (API-based) instead of browser tests.
 * The host cannot reach Docker internal IPs, so all HTTP calls go through
 * docker exec.
 */

const SERVICE_NAME = 'grafana-ldap-test';
const TEST_USER = 'grafuser';
const TEST_PASSWORD = 'GrafPass123!';
const TEST_EMAIL = 'grafuser@test.local';
const GRAFANA_CONTAINER = 'grafana-ldap-test';

let LDAP_CONTAINER_IP: string;

test.describe('Grafana LDAP Integration', () => {
  test.beforeAll(async () => {
    console.log('=== Setting up Grafana LDAP test ===');

    // 1. Create LLDAP directory service
    console.log('Creating LLDAP directory service...');
    try {
      dokku(`auth:create ${SERVICE_NAME}`);
    } catch (e: any) {
      if (!e.stderr?.includes('already exists')) {
        throw e;
      }
    }

    // Wait for LLDAP to be healthy
    let healthy = false;
    for (let i = 0; i < 30; i++) {
      try {
        const statusCmd = USE_SUDO
          ? `sudo dokku auth:status ${SERVICE_NAME}`
          : `dokku auth:status ${SERVICE_NAME}`;
        const status = execSync(statusCmd, { encoding: 'utf-8' });
        if (status.includes('healthy')) {
          healthy = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!healthy) {
      throw new Error('LLDAP service not healthy');
    }

    LDAP_CONTAINER_IP = getContainerIp(`dokku.auth.directory.${SERVICE_NAME}`);
    console.log(`LLDAP container IP: ${LDAP_CONTAINER_IP}`);

    // 2. Get credentials
    const creds = getLdapCredentials(SERVICE_NAME);

    // 3. Write ldap.toml config for Grafana
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
    fs.writeFileSync('/tmp/grafana-ldap.toml', ldapToml);
    console.log('Wrote /tmp/grafana-ldap.toml');

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

    // Get the auth network from the LLDAP container
    const authNetwork = execSync(
      `docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' dokku.auth.directory.${SERVICE_NAME}`,
      { encoding: 'utf-8' }
    ).trim().split(' ')[0];

    execSync(
      `docker run -d --name ${GRAFANA_CONTAINER} ` +
        `--network ${authNetwork} ` +
        `-v /tmp/grafana-ldap.toml:/etc/grafana/ldap.toml:ro ` +
        `-e GF_AUTH_LDAP_ENABLED=true ` +
        `-e GF_AUTH_LDAP_CONFIG_FILE=/etc/grafana/ldap.toml ` +
        `-e GF_AUTH_LDAP_ALLOW_SIGN_UP=true ` +
        `-e GF_SERVER_HTTP_PORT=3000 ` +
        `grafana/grafana-oss:latest`,
      { encoding: 'utf-8' }
    );

    // Wait for Grafana to be ready via docker exec curl
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
    const lldapContainer = `dokku.auth.directory.${SERVICE_NAME}`;
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
    console.log('=== Cleaning up Grafana LDAP test ===');
    try {
      execSync(`docker rm -f ${GRAFANA_CONTAINER}`, { encoding: 'utf-8', stdio: 'pipe' });
    } catch (e: any) {
      if (!e.stderr?.includes('No such container')) {
        console.log('[cleanup]', e.stderr?.trim() || e.message);
      }
    }
    try {
      dokku(`auth:destroy ${SERVICE_NAME} -f`, { quiet: true });
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

  test('LDAP admin reload succeeds', async () => {
    const statusCode = execSync(
      `docker exec ${GRAFANA_CONTAINER} curl -s -o /dev/null -w "%{http_code}" ` +
        `-X POST -u admin:admin http://localhost:3000/api/admin/ldap/reload`,
      { encoding: 'utf-8' }
    ).trim();
    console.log(`LDAP reload response status: ${statusCode}`);
    expect(statusCode).toBe('200');
  });
});
