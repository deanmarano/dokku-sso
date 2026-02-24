import { test, expect } from '@playwright/test';
import {
  dokku,
  cleanupApp,
  waitForAppHealthy,
  waitForHttp,
  addHostsEntry,
  setupAuthServices,
  teardownAuthServices,
  createLdapTestUser,
  loginViaAuthelia,
  verifyAutheliaRedirect,
  waitForAuthHealthy,
  getAppUrl,
  getConfig,
  pluginAvailable,
  type TestUser,
} from './helpers';

/**
 * Grafana LDAP Integration E2E Test
 *
 * Tests Grafana deployed via library:checkout with SSO protection:
 * 1. Deploy Grafana as a proper dokku app
 * 2. Protect it with Authelia forward auth
 * 3. Verify auth redirect and login flow
 * 4. Verify Grafana is accessible after authentication
 */

const APP = 'test-grafana-ldap';
const DOMAIN = `${APP}.test.local`;
const AUTH_SERVICE = 'grafana-ldap-auth';
const FRONTEND_SERVICE = 'grafana-ldap-fe';
const TEST_USER: TestUser = {
  username: 'grafuser',
  email: 'grafuser@test.local',
  password: 'GrafPass123!',
};

test.describe('Grafana LDAP Integration', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    test.skip(!pluginAvailable('postgres'), 'postgres plugin not available');

    console.log('=== Setting up Grafana LDAP test ===');

    setupAuthServices(AUTH_SERVICE, FRONTEND_SERVICE);
    await waitForAuthHealthy(AUTH_SERVICE);
    createLdapTestUser(AUTH_SERVICE, TEST_USER);
    addHostsEntry(DOMAIN);

    dokku(
      `library:checkout grafana --name=${APP} --domain=${DOMAIN} --no-ssl --non-interactive --auth-service=${AUTH_SERVICE}`,
      { timeout: 300000 },
    );

    console.log('=== Setup complete ===');
  }, 600000);

  test.afterAll(() => {
    cleanupApp(APP);
    teardownAuthServices(AUTH_SERVICE, FRONTEND_SERVICE);
  });

  test('app is running and healthy', async () => {
    const healthy = await waitForAppHealthy(APP, 120000);
    expect(healthy).toBe(true);
    const httpReady = await waitForHttp(`http://${DOMAIN}/`, 60000);
    expect(httpReady).toBe(true);
  });

  test('unauthenticated access redirects to Authelia', async ({ page }) => {
    const redirected = await verifyAutheliaRedirect(page, `http://${DOMAIN}/`);
    expect(redirected).toBe(true);
  });

  test('login via Authelia grants access to Grafana', async ({ page }) => {
    await page.goto(`http://${DOMAIN}/`);
    await loginViaAuthelia(page, TEST_USER.username, TEST_USER.password);
    await expect(page).toHaveURL(new RegExp(DOMAIN));
  });

  test('Grafana health API responds ok', async ({ page }) => {
    // Authenticate first, then check the API
    await page.goto(`http://${DOMAIN}/`);
    await loginViaAuthelia(page, TEST_USER.username, TEST_USER.password);

    const healthResponse = await page.request.get(`http://${DOMAIN}/api/health`);
    expect(healthResponse.ok()).toBe(true);
    const health = await healthResponse.json();
    expect(health.database).toBe('ok');
  });

  test('cleanup succeeds', () => {
    const output = dokku(`library:cleanup ${APP} --force`, {
      timeout: 120000,
      swallowErrors: true,
    });
    expect(output).toContain('cleaned up');
  });
});
