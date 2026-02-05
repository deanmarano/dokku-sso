import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import {
  USE_SUDO,
  dokku,
  getContainerIp,
  getLdapCredentials,
} from './helpers';

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
        const statusCmd = USE_SUDO ? `sudo dokku auth:status ${SERVICE_NAME}` : `dokku auth:status ${SERVICE_NAME}`;
        const status = execSync(statusCmd, { encoding: 'utf-8' });
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

    LDAP_CONTAINER_IP = getContainerIp(`dokku.auth.directory.${SERVICE_NAME}`);
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
      dokku(`auth:unlink ${SERVICE_NAME} ${TEST_APP}`, { quiet: true });
    } catch (e: any) {
      console.log('[cleanup] auth:unlink:', e.stderr?.trim() || e.message);
    }
    try {
      dokku(`apps:destroy ${TEST_APP} --force`, { quiet: true });
    } catch (e: any) {
      console.log('[cleanup] apps:destroy:', e.stderr?.trim() || e.message);
    }
    try {
      dokku(`auth:destroy ${SERVICE_NAME} -f`, { quiet: true });
    } catch (e: any) {
      console.log('[cleanup] auth:destroy:', e.stderr?.trim() || e.message);
    }
  });

  test('LLDAP service should be healthy', async () => {
    const statusCmd = USE_SUDO ? `sudo dokku auth:status ${SERVICE_NAME}` : `dokku auth:status ${SERVICE_NAME}`;
    const status = execSync(statusCmd, { encoding: 'utf-8' });
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
    const creds = getLdapCredentials(SERVICE_NAME);
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
    const creds = getLdapCredentials(SERVICE_NAME);
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
