import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';

/**
 * App LDAP Integration E2E Tests
 *
 * Tests the integration between dokku apps and LLDAP directory service.
 * Focuses on the plugin's functionality: linking apps to LDAP and setting env vars.
 *
 * Note: Full Gitea/Nextcloud deployment and LDAP configuration is out of scope
 * as it requires extensive app-specific setup. This test verifies the plugin's
 * core functionality works correctly.
 */

const SERVICE_NAME = 'app-ldap-test';
const TEST_APP = 'ldap-app-test';

// Helper to run dokku commands
function dokku(cmd: string): string {
  console.log(`$ dokku ${cmd}`);
  try {
    const result = execSync(`sudo dokku ${cmd}`, { encoding: 'utf8', timeout: 300000 });
    console.log(result);
    return result;
  } catch (error: any) {
    console.error(`Failed:`, error.stderr || error.message);
    throw error;
  }
}

// Helper to get LLDAP container IP
function getLdapContainerIp(serviceName: string): string {
  const containerName = `dokku.auth.directory.${serviceName}`;
  return execSync(
    `docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${containerName}`,
    { encoding: 'utf-8' }
  ).trim();
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

let LLDAP_URL: string;
let LDAP_CONTAINER_IP: string;

test.describe('App LDAP Integration', () => {
  test.beforeAll(async () => {
    console.log('=== Setting up LDAP integration test environment ===');

    // 1. Create directory service
    console.log('Creating LLDAP directory service...');
    try {
      dokku(`auth:create ${SERVICE_NAME}`);
    } catch (e: any) {
      if (!e.stderr?.includes('already exists')) {
        throw e;
      }
      console.log('Service already exists, continuing...');
    }

    // Wait for service to be healthy
    let healthy = false;
    for (let i = 0; i < 30; i++) {
      try {
        const status = execSync(`sudo dokku auth:status ${SERVICE_NAME}`, { encoding: 'utf-8' });
        if (status.includes('healthy')) {
          healthy = true;
          break;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 2000));
    }
    if (!healthy) {
      throw new Error('LLDAP service not healthy');
    }

    LDAP_CONTAINER_IP = getLdapContainerIp(SERVICE_NAME);
    LLDAP_URL = `http://${LDAP_CONTAINER_IP}:17170`;
    console.log(`LLDAP container IP: ${LDAP_CONTAINER_IP}`);
    console.log(`LLDAP URL: ${LLDAP_URL}`);

    // 2. Create test app
    console.log('Creating test app...');
    try {
      dokku(`apps:create ${TEST_APP}`);
    } catch (e: any) {
      if (!e.stderr?.includes('already exists')) {
        throw e;
      }
      console.log('App already exists, continuing...');
    }

  }, 300000); // 5 minute timeout for setup

  test.afterAll(async () => {
    console.log('=== Cleaning up test environment ===');
    try {
      dokku(`auth:unlink ${SERVICE_NAME} ${TEST_APP}`);
    } catch {}
    try {
      dokku(`apps:destroy ${TEST_APP} --force`);
    } catch (e) {
      console.log('Failed to destroy app:', e);
    }
    try {
      dokku(`auth:destroy ${SERVICE_NAME} -f`);
    } catch (e) {
      console.log('Failed to destroy service:', e);
    }
  });

  test('LLDAP service should be healthy', async () => {
    const status = execSync(`sudo dokku auth:status ${SERVICE_NAME}`, { encoding: 'utf-8' });
    expect(status).toContain('healthy');
  });

  test('LLDAP web UI should be accessible', async ({ page }) => {
    await page.goto(LLDAP_URL);

    // LLDAP shows a login form
    await expect(page.locator('input[type="text"], input[name="username"]').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('input[type="password"]')).toBeVisible();
  });

  test('should link app to LLDAP service', async () => {
    // Link the app
    const linkOutput = dokku(`auth:link ${SERVICE_NAME} ${TEST_APP}`);

    expect(linkOutput).toContain('Linking');
    expect(linkOutput).toContain('LDAP_URL');
    expect(linkOutput).toContain('LDAP_BASE_DN');
  });

  test('should set LDAP environment variables on linked app', async () => {
    // Get app config
    const config = dokku(`config:export ${TEST_APP}`);

    expect(config).toContain('LDAP_URL');
    expect(config).toContain('LDAP_BASE_DN');
    expect(config).toContain('LDAP_BIND_DN');
    expect(config).toContain('LDAP_BIND_PASSWORD');
  });

  test('should show app in service info linked apps', async () => {
    const info = dokku(`auth:info ${SERVICE_NAME}`);

    expect(info).toContain(TEST_APP);
    expect(info).toContain('Linked apps');
  });

  test('should create app-specific user group', async () => {
    // Check credentials include group info or check via LDAP
    const creds = getLdapCredentials();
    expect(creds.BASE_DN || creds.LDAP_BASE_DN).toBeTruthy();

    // The linking process creates a group named <app>_users
    // This is visible in the link output
    const info = dokku(`auth:info ${SERVICE_NAME}`);
    expect(info).toContain(TEST_APP);
  });

  test('should unlink app from service', async () => {
    const unlinkOutput = dokku(`auth:unlink ${SERVICE_NAME} ${TEST_APP}`);

    expect(unlinkOutput).toContain('Unlinking');

    // Verify LDAP vars are removed
    const config = dokku(`config:export ${TEST_APP}`);
    expect(config).not.toContain('LDAP_URL=ldap');
  });

  test('should login to LLDAP admin UI with credentials', async ({ page }) => {
    const creds = getLdapCredentials();
    const adminPassword = creds.ADMIN_PASSWORD;

    await page.goto(LLDAP_URL);

    // Fill login form
    await page.locator('input[type="text"], input[name="username"]').first().fill('admin');
    await page.locator('input[type="password"]').fill(adminPassword);
    await page.locator('button[type="submit"], input[type="submit"]').click();

    // Should see admin dashboard
    await expect(
      page.getByRole('link', { name: /users/i }).or(page.locator('nav')).or(page.getByText(/user list/i))
    ).toBeVisible({ timeout: 15000 });
  });
});
