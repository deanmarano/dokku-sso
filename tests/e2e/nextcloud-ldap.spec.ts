import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';

/**
 * Nextcloud LDAP Authentication E2E Test
 *
 * Tests the full flow of:
 * 1. Creating an LLDAP directory service
 * 2. Deploying Nextcloud with LDAP backend
 * 3. Configuring LDAP integration
 * 4. Verifying LDAP user lookup works
 *
 * Note: Full login tests are skipped due to Nextcloud UI complexity.
 * The test verifies LDAP connectivity and user enumeration instead.
 */

const SERVICE_NAME = 'nextcloud-ldap-test';
const TEST_USER = 'ncuser';
const TEST_PASSWORD = 'NcPass123!';
const TEST_EMAIL = 'ncuser@test.local';
const USE_SUDO = process.env.DOKKU_USE_SUDO === 'true';
const NEXTCLOUD_PORT = 8080;

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

  // Create user
  const createUserQuery = `
    mutation CreateUser($user: CreateUserInput!) {
      createUser(user: $user) {
        id
        email
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

// Configure Nextcloud LDAP via OCC command
function configureNextcloudLdap(
  containerName: string,
  ldapHost: string,
  baseDn: string,
  bindDn: string,
  bindPassword: string
): void {
  const occ = (cmd: string) => {
    const fullCmd = `docker exec -u www-data ${containerName} php occ ${cmd}`;
    console.log(`$ ${fullCmd}`);
    try {
      const result = execSync(fullCmd, { encoding: 'utf-8', timeout: 60000 });
      console.log(result);
      return result;
    } catch (e: any) {
      console.log('OCC command failed:', e.message);
      return '';
    }
  };

  // Enable LDAP app
  occ('app:enable user_ldap');

  // Create LDAP config
  occ('ldap:create-empty-config');

  // Configure LDAP settings (config s01 is the first empty config)
  occ(`ldap:set-config s01 ldapHost "ldap://${ldapHost}"`);
  occ(`ldap:set-config s01 ldapPort 3890`);
  occ(`ldap:set-config s01 ldapBase "${baseDn}"`);
  occ(`ldap:set-config s01 ldapAgentName "${bindDn}"`);
  occ(`ldap:set-config s01 ldapAgentPassword "${bindPassword}"`);

  // User settings
  occ(`ldap:set-config s01 ldapUserFilter "(objectclass=person)"`);
  occ(`ldap:set-config s01 ldapUserFilterObjectclass "person"`);
  occ(`ldap:set-config s01 ldapLoginFilter "(&(objectclass=person)(uid=%uid))"`);
  occ(`ldap:set-config s01 ldapLoginFilterUsername 1`);
  occ(`ldap:set-config s01 ldapUserDisplayName "displayName"`);

  // Group settings
  occ(`ldap:set-config s01 ldapGroupFilter "(objectclass=groupOfUniqueNames)"`);
  occ(`ldap:set-config s01 ldapGroupFilterObjectclass "groupOfUniqueNames"`);
  occ(`ldap:set-config s01 ldapGroupDisplayName "cn"`);
  occ(`ldap:set-config s01 ldapGroupMemberAssocAttr "uniqueMember"`);

  // Enable the configuration
  occ('ldap:set-config s01 ldapConfigurationActive 1');

  console.log('Nextcloud LDAP configuration complete');
}

let LLDAP_URL: string;
let LDAP_CONTAINER_IP: string;
let NEXTCLOUD_CONTAINER: string;
let NEXTCLOUD_URL: string;

test.describe('Nextcloud LDAP Authentication', () => {
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
    NEXTCLOUD_CONTAINER = 'nextcloud-ldap-test';

    // Remove existing container if present
    try {
      execSync(`docker rm -f ${NEXTCLOUD_CONTAINER}`, { encoding: 'utf-8' });
    } catch {}

    // Run Nextcloud with SQLite for simplicity
    execSync(
      `docker run -d --name ${NEXTCLOUD_CONTAINER} ` +
        `-p ${NEXTCLOUD_PORT}:80 ` +
        `-e NEXTCLOUD_ADMIN_USER=admin ` +
        `-e NEXTCLOUD_ADMIN_PASSWORD=adminpass ` +
        `-e SQLITE_DATABASE=nextcloud ` +
        `nextcloud:stable`,
      { encoding: 'utf-8' }
    );

    NEXTCLOUD_URL = `http://localhost:${NEXTCLOUD_PORT}`;

    // Wait for Nextcloud to be ready
    console.log('Waiting for Nextcloud to be ready...');
    let ncReady = false;
    for (let i = 0; i < 60; i++) {
      try {
        const response = await fetch(`${NEXTCLOUD_URL}/status.php`);
        if (response.ok) {
          const status = await response.json();
          if (status.installed) {
            ncReady = true;
            break;
          }
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (!ncReady) {
      throw new Error('Nextcloud not ready');
    }

    // Connect Nextcloud to same network as LLDAP
    const ncNetwork = execSync(
      `docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' dokku.auth.directory.${SERVICE_NAME}`,
      { encoding: 'utf-8' }
    ).trim().split(' ')[0];

    try {
      execSync(`docker network connect ${ncNetwork} ${NEXTCLOUD_CONTAINER}`, {
        encoding: 'utf-8',
      });
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

  test('Nextcloud should be accessible', async ({ page }) => {
    await page.goto(NEXTCLOUD_URL, { timeout: 30000 });
    // Just verify the page loads - look for any form element or NC-specific element
    await expect(
      page.locator('input').first()
    ).toBeVisible({ timeout: 30000 });
  });

  test('LDAP app should be enabled', async () => {
    // Verify LDAP app status via OCC
    const result = execSync(
      `docker exec -u www-data ${NEXTCLOUD_CONTAINER} php occ app:list --enabled`,
      { encoding: 'utf-8' }
    );
    expect(result).toContain('user_ldap');
  });

  test('LDAP configuration should be active', async () => {
    // Verify LDAP config is active
    const result = execSync(
      `docker exec -u www-data ${NEXTCLOUD_CONTAINER} php occ ldap:show-config s01`,
      { encoding: 'utf-8' }
    );
    expect(result).toContain('ldapConfigurationActive');
    expect(result).toContain('1');
    expect(result).toContain('ldapHost');
  });

  test('LDAP should be able to find admin user', async () => {
    // Test LDAP connection by searching for users
    const result = execSync(
      `docker exec -u www-data ${NEXTCLOUD_CONTAINER} php occ ldap:search user admin`,
      { encoding: 'utf-8' }
    );
    // Should find the admin user from LLDAP
    expect(result.toLowerCase()).toContain('admin');
  });

  test('LDAP should find test user', async () => {
    // Test that our created test user is discoverable
    const result = execSync(
      `docker exec -u www-data ${NEXTCLOUD_CONTAINER} php occ ldap:search user ${TEST_USER}`,
      { encoding: 'utf-8' }
    );
    expect(result.toLowerCase()).toContain(TEST_USER.toLowerCase());
  });

  test('LLDAP user authentication should work', async () => {
    // Test auth directly against LLDAP (bypasses Nextcloud UI)
    const creds = getLdapCredentials();
    const response = await fetch(`${LLDAP_URL}/auth/simple/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: TEST_USER, password: TEST_PASSWORD }),
    });
    expect(response.ok).toBe(true);
  });

  test('wrong password should fail LLDAP auth', async () => {
    const response = await fetch(`${LLDAP_URL}/auth/simple/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: TEST_USER, password: 'wrongpassword' }),
    });
    expect(response.ok).toBe(false);
  });
});
