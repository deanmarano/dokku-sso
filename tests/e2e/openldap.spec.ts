import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import { dokku, waitForHealthy, getContainerIp, getLdapCredentials } from './helpers';

/**
 * OpenLDAP Directory Provider E2E Test
 *
 * Tests the OpenLDAP provider:
 * 1. Creating a directory service with OpenLDAP provider
 * 2. Verifying LDAP port is accessible
 * 3. Testing LDAP bind and search with admin credentials
 * 4. Verifying organizational units are created
 */

const SERVICE_NAME = 'openldap-e2e-test';

test.describe('OpenLDAP Directory Provider', () => {
  test.beforeAll(async () => {
    console.log('=== Setting up OpenLDAP test ===');

    // Create OpenLDAP directory service
    console.log('Creating OpenLDAP directory service...');
    try {
      dokku(`auth:create ${SERVICE_NAME} --provider openldap`);
    } catch (e: any) {
      if (!e.stderr?.includes('already exists')) {
        throw e;
      }
    }

    // Wait for service to be healthy
    const healthy = await waitForHealthy(SERVICE_NAME, 'directory', 120000);
    if (!healthy) {
      // Get logs for debugging
      try {
        const logs = dokku(`auth:logs ${SERVICE_NAME} -n 50`);
        console.log('OpenLDAP logs:', logs);
      } catch {}
      throw new Error('OpenLDAP service not healthy');
    }

    console.log('=== Setup complete ===');
  }, 300000); // 5 minute timeout

  test.afterAll(async () => {
    console.log('=== Cleaning up OpenLDAP test ===');
    try {
      dokku(`auth:destroy ${SERVICE_NAME} -f`, { quiet: true });
    } catch (e: any) {
      console.log('[cleanup] auth:destroy:', e.stderr?.trim() || e.message);
    }
  });

  test('service status shows healthy', async () => {
    const status = dokku(`auth:status ${SERVICE_NAME}`);
    expect(status).toContain('healthy');
  });

  test('service info shows OpenLDAP provider', async () => {
    const info = dokku(`auth:info ${SERVICE_NAME}`);
    expect(info.toLowerCase()).toContain('openldap');
  });

  test('credentials are generated', async () => {
    const creds = getLdapCredentials(SERVICE_NAME);
    expect(creds.LDAP_URL).toBeDefined();
    expect(creds.LDAP_BASE_DN).toBeDefined();
    expect(creds.LDAP_BIND_DN).toBeDefined();
    expect(creds.ADMIN_PASSWORD).toBeDefined();
  });

  test('LDAP bind succeeds with admin credentials', async () => {
    const containerName = `dokku.auth.directory.${SERVICE_NAME}`;
    const creds = getLdapCredentials(SERVICE_NAME);

    const baseDn = creds.LDAP_BASE_DN;
    const password = creds.ADMIN_PASSWORD;

    // OpenLDAP has ldapsearch built-in - test admin bind
    const result = execSync(
      `docker exec ${containerName} ldapsearch -x -H ldap://localhost ` +
        `-D "cn=admin,${baseDn}" -w "${password}" ` +
        `-b "${baseDn}" "(objectClass=organization)" dn`,
      { encoding: 'utf-8', timeout: 30000 }
    );

    console.log('LDAP search result:', result);
    expect(result).toContain(baseDn);
  });

  test('organizational units are created', async () => {
    const containerName = `dokku.auth.directory.${SERVICE_NAME}`;
    const creds = getLdapCredentials(SERVICE_NAME);

    const baseDn = creds.LDAP_BASE_DN;
    const password = creds.ADMIN_PASSWORD;

    // Search for organizational units
    const result = execSync(
      `docker exec ${containerName} ldapsearch -x -H ldap://localhost ` +
        `-D "cn=admin,${baseDn}" -w "${password}" ` +
        `-b "${baseDn}" "(objectClass=organizationalUnit)" dn`,
      { encoding: 'utf-8', timeout: 30000 }
    );

    console.log('OU search result:', result);
    // OpenLDAP provider creates ou=people and ou=groups
    expect(result).toContain('ou=people');
    expect(result).toContain('ou=groups');
  });

  test('default users group is created', async () => {
    const containerName = `dokku.auth.directory.${SERVICE_NAME}`;
    const creds = getLdapCredentials(SERVICE_NAME);

    const baseDn = creds.LDAP_BASE_DN;
    const password = creds.ADMIN_PASSWORD;

    // Search for groups
    const result = execSync(
      `docker exec ${containerName} ldapsearch -x -H ldap://localhost ` +
        `-D "cn=admin,${baseDn}" -w "${password}" ` +
        `-b "ou=groups,${baseDn}" "(objectClass=groupOfNames)" cn`,
      { encoding: 'utf-8', timeout: 30000 }
    );

    console.log('Groups search result:', result);
    // Should have the default users group
    expect(result).toContain('dokku-auth-default-users');
  });

  test('doctor check passes', async () => {
    const result = dokku(`auth:doctor ${SERVICE_NAME}`);
    // Doctor should not report errors
    expect(result.toLowerCase()).not.toContain('error');
  });
});
