import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';

/**
 * LDAP Authentication E2E Test
 *
 * Tests the full flow of:
 * 1. Creating an LLDAP directory service
 * 2. Creating a test user in LLDAP
 * 3. Verifying LDAP bind authentication works
 *
 * This test verifies the core LDAP functionality without requiring
 * full application integration testing.
 */

const SERVICE_NAME = 'ldap-auth-test';
const TEST_USER = 'testuser';
const TEST_PASSWORD = 'TestPass123!';
const TEST_EMAIL = 'testuser@test.local';
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
  return ips.split(' ')[0]; // Return first IP
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

// Test LDAP bind authentication via LLDAP's simple auth endpoint
async function testLdapAuthentication(
  lldapUrl: string,
  username: string,
  password: string
): Promise<boolean> {
  try {
    const response = await fetch(`${lldapUrl}/auth/simple/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

let LLDAP_URL: string;
let LDAP_CONTAINER_IP: string;

test.describe('LDAP Authentication', () => {
  test.beforeAll(async () => {
    console.log('=== Setting up LDAP authentication test ===');

    // Create LLDAP directory service
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

    console.log('=== Setup complete ===');
  }, 300000);

  test.afterAll(async () => {
    console.log('=== Cleaning up LDAP authentication test ===');
    try {
      dokku(`auth:destroy ${SERVICE_NAME} -f`);
    } catch (e) {
      console.log('Failed to destroy LLDAP service:', e);
    }
  });

  test('LLDAP service should be healthy', async () => {
    const statusCmd = USE_SUDO
      ? `sudo dokku auth:status ${SERVICE_NAME}`
      : `dokku auth:status ${SERVICE_NAME}`;
    const status = execSync(statusCmd, { encoding: 'utf-8' });
    expect(status).toContain('healthy');
  });

  test('should get LDAP credentials', async () => {
    const creds = getLdapCredentials();
    expect(creds.ADMIN_PASSWORD).toBeDefined();
    expect(creds.BASE_DN).toBeDefined();
    expect(creds.BIND_DN).toBeDefined();
    console.log('LDAP credentials retrieved successfully');
  });

  test('admin should be able to authenticate', async () => {
    const creds = getLdapCredentials();
    const canAuth = await testLdapAuthentication(
      LLDAP_URL,
      'admin',
      creds.ADMIN_PASSWORD
    );
    expect(canAuth).toBe(true);
  });

  test('should create test user and authenticate', async () => {
    const creds = getLdapCredentials();

    // Create the test user
    await createLdapUser(
      LLDAP_URL,
      creds.ADMIN_PASSWORD,
      TEST_USER,
      TEST_EMAIL,
      TEST_PASSWORD
    );

    // Verify user can authenticate
    const canAuth = await testLdapAuthentication(
      LLDAP_URL,
      TEST_USER,
      TEST_PASSWORD
    );
    expect(canAuth).toBe(true);

    // Verify wrong password fails
    const wrongAuth = await testLdapAuthentication(
      LLDAP_URL,
      TEST_USER,
      'wrongpassword'
    );
    expect(wrongAuth).toBe(false);
  });

  test('non-existent user should fail authentication', async () => {
    const canAuth = await testLdapAuthentication(
      LLDAP_URL,
      'nonexistentuser',
      'anypassword'
    );
    expect(canAuth).toBe(false);
  });

  test('LLDAP web UI should be accessible', async ({ page }) => {
    // Access the LLDAP web UI directly
    await page.goto(LLDAP_URL, { timeout: 30000 });

    // LLDAP shows a login form
    await expect(
      page.locator('input[name="username"], input[type="text"]').first()
    ).toBeVisible({ timeout: 15000 });
  });
});
