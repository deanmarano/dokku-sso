import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';

/**
 * Nextcloud LDAP Integration E2E Test
 *
 * Tests the integration of Nextcloud with LLDAP:
 * 1. Creating an LLDAP directory service
 * 2. Deploying Nextcloud container
 * 3. Configuring LDAP via OCC commands
 * 4. Verifying LDAP user lookup works
 *
 * Note: This test uses OCC commands instead of browser-based tests
 * for reliability. Nextcloud UI testing is fragile due to slow startup.
 */

const SERVICE_NAME = 'nextcloud-ldap-test';
const TEST_USER = 'ncuser';
const TEST_PASSWORD = 'NcPass123!';
const TEST_EMAIL = 'ncuser@test.local';
const USE_SUDO = process.env.DOKKU_USE_SUDO === 'true';

// Helper to run dokku commands
function dokku(cmd: string): string {
  const dokkuCmd = USE_SUDO ? `sudo dokku ${cmd}` : `dokku ${cmd}`;
  console.log(`$ ${dokkuCmd}`);
  try {
    const result = execSync(dokkuCmd, { encoding: 'utf8', timeout: 300000 });
    console.log(result);
    return result;
  } catch (error: any) {
    console.error(`Failed:`, error.stderr || error.message);
    throw error;
  }
}

// Get container IP
function getContainerIp(containerName: string): string {
  const ips = execSync(
    `docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' ${containerName}`,
    { encoding: 'utf-8' }
  ).trim();
  return ips.split(' ')[0];
}

// Get LLDAP credentials
function getLdapCredentials(): Record<string, string> {
  const output = dokku(`auth:credentials ${SERVICE_NAME}`);
  const creds: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const match = line.match(/^(\w+)=(.+)$/);
    if (match) {
      creds[match[1]] = match[2];
    }
  }
  return creds;
}

// Create user in LLDAP via GraphQL API
async function createLdapUser(
  lldapUrl: string,
  adminPassword: string,
  userId: string,
  email: string,
  password: string
): Promise<void> {
  // Get auth token
  const loginResponse = await fetch(`${lldapUrl}/auth/simple/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: adminPassword }),
  });

  if (!loginResponse.ok) {
    throw new Error(`Failed to login to LLDAP: ${await loginResponse.text()}`);
  }

  const { token } = await loginResponse.json();

  // Create user with all required attributes
  const createUserQuery = `
    mutation CreateUser($user: CreateUserInput!) {
      createUser(user: $user) {
        id
        email
        displayName
      }
    }
  `;

  const createResponse = await fetch(`${lldapUrl}/api/graphql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      query: createUserQuery,
      variables: {
        user: {
          id: userId,
          email: email,
          displayName: userId, // Set displayName same as userId for search
          firstName: 'Test',
          lastName: 'User',
        },
      },
    }),
  });

  const createResult = await createResponse.json();
  if (createResult.errors) {
    if (!createResult.errors[0]?.message?.includes('already exists')) {
      console.log('Create user result:', JSON.stringify(createResult, null, 2));
    }
  }

  // Set user password
  const setPasswordQuery = `
    mutation SetPassword($userId: String!, $password: String!) {
      setPassword(userId: $userId, password: $password) {
        ok
      }
    }
  `;

  await fetch(`${lldapUrl}/api/graphql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      query: setPasswordQuery,
      variables: {
        userId: userId,
        password: password,
      },
    }),
  });

  console.log(`Created LDAP user: ${userId}`);
}

// Run OCC command in Nextcloud container
function occ(containerName: string, cmd: string): string {
  const fullCmd = `docker exec -u www-data ${containerName} php occ ${cmd}`;
  console.log(`$ ${fullCmd}`);
  try {
    const result = execSync(fullCmd, { encoding: 'utf-8', timeout: 120000 });
    console.log(result);
    return result;
  } catch (e: any) {
    console.log('OCC command failed:', e.message);
    throw e;
  }
}

// Configure Nextcloud LDAP via OCC command for LLDAP
function configureNextcloudLdap(
  containerName: string,
  ldapHost: string,
  baseDn: string,
  bindDn: string,
  bindPassword: string
): void {
  // Enable LDAP app (may already be enabled)
  try {
    occ(containerName, 'app:enable user_ldap');
  } catch {
    console.log('LDAP app may already be enabled');
  }

  // Create LDAP config
  occ(containerName, 'ldap:create-empty-config');

  // Connection settings
  occ(containerName, `ldap:set-config s01 ldapHost "ldap://${ldapHost}"`);
  occ(containerName, `ldap:set-config s01 ldapPort 3890`);
  occ(containerName, `ldap:set-config s01 ldapAgentName "${bindDn}"`);
  occ(containerName, `ldap:set-config s01 ldapAgentPassword "${bindPassword}"`);

  // LLDAP-specific base DNs - users are in ou=people, groups in ou=groups
  occ(containerName, `ldap:set-config s01 ldapBase "${baseDn}"`);
  occ(containerName, `ldap:set-config s01 ldapBaseUsers "ou=people,${baseDn}"`);
  occ(containerName, `ldap:set-config s01 ldapBaseGroups "ou=groups,${baseDn}"`);

  // User settings for LLDAP
  occ(containerName, `ldap:set-config s01 ldapUserFilter "(objectclass=person)"`);
  occ(containerName, `ldap:set-config s01 ldapUserFilterObjectclass "person"`);
  occ(containerName, `ldap:set-config s01 ldapLoginFilter "(&(objectclass=person)(uid=%uid))"`);
  occ(containerName, `ldap:set-config s01 ldapLoginFilterUsername 1`);
  occ(containerName, `ldap:set-config s01 ldapUserDisplayName "cn"`);
  occ(containerName, `ldap:set-config s01 ldapEmailAttribute "mail"`);

  // Expert settings for LLDAP compatibility
  occ(containerName, `ldap:set-config s01 ldapExpertUsernameAttr "uid"`);
  occ(containerName, `ldap:set-config s01 ldapExpertUUIDUserAttr "uid"`);
  occ(containerName, `ldap:set-config s01 ldapExpertUUIDGroupAttr "cn"`);

  // Group settings
  occ(containerName, `ldap:set-config s01 ldapGroupFilter "(objectclass=groupOfUniqueNames)"`);
  occ(containerName, `ldap:set-config s01 ldapGroupFilterObjectclass "groupOfUniqueNames"`);
  occ(containerName, `ldap:set-config s01 ldapGroupDisplayName "cn"`);
  occ(containerName, `ldap:set-config s01 ldapGroupMemberAssocAttr "member"`);

  // Enable the configuration
  occ(containerName, 'ldap:set-config s01 ldapConfigurationActive 1');

  console.log('Nextcloud LDAP configuration complete');
}

const NEXTCLOUD_CONTAINER = 'nextcloud-ldap-test';
let LLDAP_URL: string;
let LDAP_CONTAINER_IP: string;

test.describe('Nextcloud LDAP Integration', () => {
  test.beforeAll(async () => {
    console.log('=== Setting up Nextcloud LDAP test ===');

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
    LLDAP_URL = `http://${LDAP_CONTAINER_IP}:17170`;
    console.log(`LLDAP URL: ${LLDAP_URL}`);

    // 2. Deploy Nextcloud container
    console.log('Deploying Nextcloud container...');

    // Remove existing container if present
    try {
      execSync(`docker rm -f ${NEXTCLOUD_CONTAINER}`, { encoding: 'utf-8' });
    } catch {}

    // Run Nextcloud with SQLite for simplicity (no port mapping needed - we use OCC)
    execSync(
      `docker run -d --name ${NEXTCLOUD_CONTAINER} ` +
        `-e NEXTCLOUD_ADMIN_USER=admin ` +
        `-e NEXTCLOUD_ADMIN_PASSWORD=adminpass ` +
        `-e SQLITE_DATABASE=nextcloud ` +
        `nextcloud:stable`,
      { encoding: 'utf-8' }
    );

    // Wait for Nextcloud to be ready (check via OCC)
    console.log('Waiting for Nextcloud to be ready...');
    let ncReady = false;
    for (let i = 0; i < 60; i++) {
      try {
        const result = execSync(
          `docker exec -u www-data ${NEXTCLOUD_CONTAINER} php occ status --output=json`,
          { encoding: 'utf-8', timeout: 30000 }
        );
        const status = JSON.parse(result);
        if (status.installed) {
          ncReady = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (!ncReady) {
      throw new Error('Nextcloud not ready');
    }
    console.log('Nextcloud is ready');

    // Connect Nextcloud to same network as LLDAP
    const ncNetwork = execSync(
      `docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' dokku.auth.directory.${SERVICE_NAME}`,
      { encoding: 'utf-8' }
    ).trim().split(' ')[0];

    try {
      execSync(`docker network connect ${ncNetwork} ${NEXTCLOUD_CONTAINER}`, {
        encoding: 'utf-8',
      });
      console.log(`Connected Nextcloud to network: ${ncNetwork}`);
    } catch (e: any) {
      if (!e.message?.includes('already exists')) {
        console.log('Network connect warning:', e.message);
      }
    }

    // 3. Configure Nextcloud LDAP
    const creds = getLdapCredentials();
    configureNextcloudLdap(
      NEXTCLOUD_CONTAINER,
      LDAP_CONTAINER_IP,
      creds.BASE_DN,
      creds.BIND_DN,
      creds.ADMIN_PASSWORD
    );

    // 4. Create test user in LLDAP
    await createLdapUser(
      LLDAP_URL,
      creds.ADMIN_PASSWORD,
      TEST_USER,
      TEST_EMAIL,
      TEST_PASSWORD
    );

    // 5. Test LDAP connection from Nextcloud
    console.log('Testing LDAP connection...');
    try {
      const testResult = occ(NEXTCLOUD_CONTAINER, 'ldap:test-config s01');
      console.log('LDAP test result:', testResult);
    } catch (e: any) {
      console.log('LDAP test warning:', e.message);
    }

    // Small delay to ensure LDAP sync
    await new Promise((r) => setTimeout(r, 2000));

    console.log('=== Setup complete ===');
  }, 600000); // 10 minute timeout

  test.afterAll(async () => {
    console.log('=== Cleaning up Nextcloud LDAP test ===');
    try {
      execSync(`docker rm -f ${NEXTCLOUD_CONTAINER}`, { encoding: 'utf-8' });
    } catch {}
    try {
      dokku(`auth:destroy ${SERVICE_NAME} -f`);
    } catch {}
  });

  test('LDAP app should be enabled', async () => {
    const result = occ(NEXTCLOUD_CONTAINER, 'app:list --enabled');
    expect(result).toContain('user_ldap');
  });

  test('LDAP configuration should be active', async () => {
    const result = occ(NEXTCLOUD_CONTAINER, 'ldap:show-config s01');
    expect(result).toContain('ldapConfigurationActive');
    expect(result).toContain('1');
    expect(result).toContain('ldapHost');
  });

  test('LDAP should find admin user', async () => {
    const result = occ(NEXTCLOUD_CONTAINER, 'ldap:search admin');
    expect(result.toLowerCase()).toContain('admin');
  });

  test('LDAP should find test user', async () => {
    const result = occ(NEXTCLOUD_CONTAINER, `ldap:search ${TEST_USER}`);
    expect(result.toLowerCase()).toContain(TEST_USER.toLowerCase());
  });

  test('LLDAP authentication should work', async () => {
    const response = await fetch(`${LLDAP_URL}/auth/simple/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: TEST_USER, password: TEST_PASSWORD }),
    });
    expect(response.ok).toBe(true);
  });

  test('wrong password should fail', async () => {
    const response = await fetch(`${LLDAP_URL}/auth/simple/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: TEST_USER, password: 'wrongpassword' }),
    });
    expect(response.ok).toBe(false);
  });
});
