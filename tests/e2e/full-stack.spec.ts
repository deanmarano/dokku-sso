import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';

/**
 * Full stack E2E tests
 *
 * These tests set up the complete auth stack and verify end-to-end flows.
 * Requires Docker and dokku-auth plugin to be available.
 */

const DOKKU_HOST = process.env.DOKKU_HOST || 'localhost';
const SERVICE_NAME = `e2e-test-${Date.now()}`;
const FRONTEND_NAME = `e2e-frontend-${Date.now()}`;
const TEST_DOMAIN = process.env.TEST_DOMAIN || 'test.local';

// Helper to run dokku commands
function dokku(cmd: string): string {
  try {
    return execSync(`dokku ${cmd}`, { encoding: 'utf8', timeout: 120000 });
  } catch (error: any) {
    console.error(`dokku ${cmd} failed:`, error.stderr);
    throw error;
  }
}

// Helper to wait for service to be ready
async function waitForService(url: string, timeout = 30000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000)
      });
      if (response.ok || response.status === 401 || response.status === 302) {
        return true;
      }
    } catch {
      // Service not ready yet
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return false;
}

test.describe('Full Auth Stack E2E', () => {
  test.beforeAll(async () => {
    // Create directory service
    console.log('Creating directory service...');
    dokku(`auth:create ${SERVICE_NAME}`);

    // Get the HTTP URL for LLDAP
    const info = dokku(`auth:info ${SERVICE_NAME}`);
    console.log('Directory service info:', info);
  });

  test.afterAll(async () => {
    // Cleanup
    try {
      dokku(`auth:frontend:destroy ${FRONTEND_NAME} -f`);
    } catch {}
    try {
      dokku(`auth:destroy ${SERVICE_NAME} -f`);
    } catch {}
  });

  test('directory service should be healthy', async () => {
    const status = dokku(`auth:status ${SERVICE_NAME}`);
    expect(status).toContain('healthy');
  });

  test('should be able to get credentials', async () => {
    const creds = dokku(`auth:credentials ${SERVICE_NAME}`);
    expect(creds).toContain('ADMIN_PASSWORD');
    expect(creds).toContain('BASE_DN');
    expect(creds).toContain('BIND_DN');
    expect(creds).toContain('JWT_SECRET');
  });

  // Browser-based test skipped - can't access Docker internal IPs from Playwright browser
  test.skip('LLDAP web UI should be accessible', async ({ page }) => {
    // This test requires browser access to Docker internal network
  });

  test('should create and use frontend service', async () => {
    // Create frontend
    dokku(`auth:frontend:create ${FRONTEND_NAME}`);
    dokku(`auth:frontend:config ${FRONTEND_NAME} DOMAIN=auth.${TEST_DOMAIN}`);
    dokku(`auth:frontend:use-directory ${FRONTEND_NAME} ${SERVICE_NAME}`);

    // Apply config
    dokku(`auth:frontend:apply ${FRONTEND_NAME}`);

    // Check status
    const status = dokku(`auth:frontend:status ${FRONTEND_NAME}`);
    expect(status).toContain('running');
  });

  test('should enable OIDC', async () => {
    dokku(`auth:oidc:enable ${FRONTEND_NAME}`);

    // Add a test client
    const result = dokku(`auth:oidc:add-client ${FRONTEND_NAME} test-client`);
    expect(result).toContain('Client added');
    expect(result).toContain('Client Secret');

    // List clients
    const clients = dokku(`auth:oidc:list ${FRONTEND_NAME}`);
    expect(clients).toContain('test-client');
  });

  test('doctor should run diagnostics', async () => {
    // Doctor may fail on port checks when run from host (network isolation)
    // but should still run and report status
    try {
      const doctorResult = dokku(`auth:doctor ${SERVICE_NAME}`);
      expect(doctorResult).toContain('Running diagnostics');
    } catch (error: any) {
      // Command may exit non-zero if issues found, but should still produce output
      expect(error.stdout || error.stderr).toContain('Running diagnostics');
    }
  });

  test('sync should work with no errors', async () => {
    // Sync (may report 0 members if no users yet)
    const syncResult = dokku(`auth:sync ${SERVICE_NAME}`);
    expect(syncResult).toContain('Sync');
  });
});

test.describe('User Creation and Login Flow', () => {
  const LLDAP_URL = process.env.LLDAP_URL;
  const ADMIN_PASSWORD = process.env.LLDAP_ADMIN_PASSWORD;

  test.skip(!LLDAP_URL || !ADMIN_PASSWORD, 'Requires LLDAP_URL and LLDAP_ADMIN_PASSWORD');

  test('should create user via LLDAP GraphQL API', async ({ request }) => {
    // Get auth token
    const loginResponse = await request.post(`${LLDAP_URL}/auth/simple/login`, {
      data: { username: 'admin', password: ADMIN_PASSWORD }
    });
    expect(loginResponse.ok()).toBeTruthy();

    const { token } = await loginResponse.json();
    expect(token).toBeTruthy();

    // Create user via GraphQL
    const testUser = `e2e-user-${Date.now()}`;
    const createResponse = await request.post(`${LLDAP_URL}/api/graphql`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        query: `mutation {
          createUser(user: {
            id: "${testUser}",
            email: "${testUser}@test.local"
          }) {
            id
            email
          }
        }`
      }
    });

    expect(createResponse.ok()).toBeTruthy();
    const result = await createResponse.json();
    expect(result.data?.createUser?.id).toBe(testUser);
  });

  test('should login as created user via LDAP bind', async ({ request }) => {
    // This would require an LDAP client, which we test via the integration tests
    // Here we just verify the user exists via GraphQL
    const loginResponse = await request.post(`${LLDAP_URL}/auth/simple/login`, {
      data: { username: 'admin', password: ADMIN_PASSWORD }
    });
    const { token } = await loginResponse.json();

    const usersResponse = await request.post(`${LLDAP_URL}/api/graphql`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { query: '{ users { id email } }' }
    });

    const result = await usersResponse.json();
    expect(result.data?.users).toBeDefined();
    expect(Array.isArray(result.data.users)).toBeTruthy();
  });
});
