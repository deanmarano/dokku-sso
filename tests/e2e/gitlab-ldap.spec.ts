import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import {
  USE_SUDO,
  dokku,
  getContainerIp,
  getLdapCredentials,
  createLdapUser,
  generateGitlabLdapConfig,
} from './helpers';

/**
 * GitLab LDAP Integration E2E Test
 *
 * Tests the integration of GitLab CE with LLDAP:
 * 1. Creating an LLDAP directory service
 * 2. Deploying GitLab container with LDAP config from preset
 * 3. Verifying LDAP login works via GitLab API
 *
 * Note: GitLab takes 5-10 minutes to start up. This test has long timeouts.
 * Uses docker exec curl for API calls since host can't reach Docker IPs.
 */

const SERVICE_NAME = 'gitlab-ldap-test';
const TEST_USER = 'gitlabuser';
const TEST_PASSWORD = 'GitLab123!';
const TEST_EMAIL = 'gitlabuser@test.local';
const GITLAB_CONTAINER = 'gitlab-ldap-test';

let LDAP_CONTAINER_IP: string;

test.describe('GitLab LDAP Integration', () => {
  test.beforeAll(async () => {
    console.log('=== Setting up GitLab LDAP test ===');

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

    // 3. Generate GitLab LDAP config using preset
    const bindDn = `uid=admin,ou=people,${creds.BASE_DN}`;
    const ldapConfig = generateGitlabLdapConfig(
      LDAP_CONTAINER_IP,
      3890,
      creds.BASE_DN,
      bindDn,
      creds.ADMIN_PASSWORD,
    );

    // Create full gitlab.rb with LDAP config and required settings
    // Note: GitLab rejects common passwords, so use a random-looking one
    const gitlabRb = `
external_url 'http://localhost'
gitlab_rails['initial_root_password'] = 'xK9#mP2$vL7nQ4wR'
${ldapConfig}
`;
    fs.writeFileSync('/tmp/gitlab-ldap.rb', gitlabRb);
    console.log('Wrote /tmp/gitlab-ldap.rb (using gitlab preset)');

    // 4. Deploy GitLab container
    console.log('Deploying GitLab container (this takes several minutes)...');

    // Remove existing container if present
    try {
      execSync(`docker rm -f ${GITLAB_CONTAINER}`, { encoding: 'utf-8', stdio: 'pipe' });
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
      `docker run -d --name ${GITLAB_CONTAINER} ` +
        `--network ${authNetwork} ` +
        `--hostname gitlab.local ` +
        `-v /tmp/gitlab-ldap.rb:/etc/gitlab/gitlab.rb:ro ` +
        `-e GITLAB_OMNIBUS_CONFIG="from_file('/etc/gitlab/gitlab.rb')" ` +
        `--shm-size 256m ` +
        `gitlab/gitlab-ce:latest`,
      { encoding: 'utf-8' }
    );

    // Wait for GitLab to be ready (this takes a while)
    console.log('Waiting for GitLab to be ready (up to 10 minutes)...');
    let gitlabReady = false;
    for (let i = 0; i < 120; i++) { // 10 minutes with 5 second intervals
      try {
        const result = execSync(
          `docker exec ${GITLAB_CONTAINER} curl -sf http://localhost/-/health 2>/dev/null || echo "not ready"`,
          { encoding: 'utf-8', timeout: 10000 }
        );
        if (result.includes('GitLab OK') || result.trim() === 'GitLab OK') {
          gitlabReady = true;
          break;
        }
        // Also check if reconfigure is done
        const logs = execSync(`docker logs ${GITLAB_CONTAINER} 2>&1 | tail -5`, { encoding: 'utf-8' });
        if (logs.includes('gitlab Reconfigured!')) {
          // Give it a bit more time after reconfigure
          await new Promise((r) => setTimeout(r, 30000));
          gitlabReady = true;
          break;
        }
      } catch {}
      if (i % 12 === 0) {
        console.log(`Still waiting for GitLab... (${i * 5}s elapsed)`);
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (!gitlabReady) {
      const logs = execSync(`docker logs ${GITLAB_CONTAINER} 2>&1 | tail -50`, { encoding: 'utf-8' });
      console.log('GitLab logs:', logs);
      throw new Error('GitLab not ready after 10 minutes');
    }
    console.log('GitLab is ready');

    // 5. Create test user in LLDAP
    const lldapContainer = `dokku.auth.directory.${SERVICE_NAME}`;
    createLdapUser(
      lldapContainer,
      creds.ADMIN_PASSWORD,
      TEST_USER,
      TEST_EMAIL,
      TEST_PASSWORD
    );

    // Give GitLab time to sync LDAP
    console.log('Waiting for LDAP sync...');
    await new Promise((r) => setTimeout(r, 10000));

    console.log('=== Setup complete ===');
  }, 900000); // 15 minute timeout for setup

  test.afterAll(async () => {
    console.log('=== Cleaning up GitLab LDAP test ===');
    try {
      execSync(`docker rm -f ${GITLAB_CONTAINER}`, { encoding: 'utf-8', stdio: 'pipe' });
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

  test('GitLab health check returns ok', async () => {
    const result = execSync(
      `docker exec ${GITLAB_CONTAINER} curl -sf http://localhost/-/health`,
      { encoding: 'utf-8' }
    );
    expect(result).toContain('GitLab OK');
  });

  test('GitLab LDAP is configured', async () => {
    // Check LDAP config via rails console
    const result = execSync(
      `docker exec ${GITLAB_CONTAINER} gitlab-rails runner "puts Gitlab::Auth::Ldap::Config.servers.map(&:label)"`,
      { encoding: 'utf-8', timeout: 60000 }
    );
    console.log('LDAP servers:', result);
    expect(result).toContain('LLDAP');
  });

  test('LDAP authentication works via Rails adapter', async () => {
    // Test LDAP authentication directly using GitLab's LDAP adapter
    // Note: GitLab prefixes provider names with 'ldap', so 'main' becomes 'ldapmain'
    const result = execSync(
      `docker exec ${GITLAB_CONTAINER} gitlab-rails runner "` +
        `adapter = Gitlab::Auth::Ldap::Adapter.new('ldapmain'); ` +
        `entry = adapter.ldap.bind_as(filter: '(uid=${TEST_USER})', password: '${TEST_PASSWORD}'); ` +
        `puts entry ? 'auth_success' : 'auth_failed'"`,
      { encoding: 'utf-8', timeout: 60000 }
    );
    console.log('LDAP auth result:', result.trim());
    expect(result).toContain('auth_success');
  });

  test('LDAP user can be found in directory', async () => {
    // Search for the user in LDAP to verify the user exists and is searchable
    // Note: GitLab prefixes provider names with 'ldap', so 'main' becomes 'ldapmain'
    const result = execSync(
      `docker exec ${GITLAB_CONTAINER} gitlab-rails runner "` +
        `adapter = Gitlab::Auth::Ldap::Adapter.new('ldapmain'); ` +
        `users = adapter.users('uid', '${TEST_USER}'); ` +
        `puts users.empty? ? 'not_found' : users.first.uid"`,
      { encoding: 'utf-8', timeout: 60000 }
    );
    console.log('LDAP user search result:', result.trim());
    expect(result.trim()).toBe(TEST_USER);
  });
});
