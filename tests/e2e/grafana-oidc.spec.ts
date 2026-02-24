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
  pluginAvailable,
  type TestUser,
} from './helpers';

/**
 * Grafana OIDC Integration E2E Test
 *
 * Tests Grafana deployed via library:checkout with Authelia forward sso:
 * 1. Deploy Grafana as a proper dokku app
 * 2. Protect it with Authelia forward auth (via sso:protect)
 * 3. Verify the full browser login flow
 *
 * Note: With library:checkout + sso:protect, the auth flow uses forward auth
 * (Authelia sits in front of the app) rather than native OIDC. This tests the
 * real user-facing integration path.
 */

const APP = 'test-grafana-oidc';
const DOMAIN = `${APP}.test.local`;
const AUTH_SERVICE = 'grafana-oidc-auth';
const FRONTEND_SERVICE = 'grafana-oidc-fe';
const TEST_USER: TestUser = {
  username: 'grafoidcuser',
  email: 'grafoidcuser@test.local',
  password: 'GrafOidc123!',
};

test.describe('Grafana OIDC Browser Flow', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    test.skip(!pluginAvailable('postgres'), 'postgres plugin not available');

    console.log('=== Setting up Grafana OIDC test environment ===');

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

  test('app is running and responds on HTTP', async () => {
    const healthy = await waitForAppHealthy(APP, 120000);
    expect(healthy).toBe(true);
    const httpReady = await waitForHttp(`http://${DOMAIN}/`, 60000);
    expect(httpReady).toBe(true);
  });

  test('unauthenticated access redirects to Authelia', async ({ page }) => {
    const redirected = await verifyAutheliaRedirect(page, `http://${DOMAIN}/`);
    expect(redirected).toBe(true);
  });

  test('full browser login flow works end-to-end', async ({ page }) => {
    await page.context().clearCookies();

    // Navigate to Grafana - should redirect to Authelia
    await page.goto(`http://${DOMAIN}/`);
    await loginViaAuthelia(page, TEST_USER.username, TEST_USER.password);

    // Should be back on the app domain
    await expect(page).toHaveURL(new RegExp(DOMAIN));

    // Verify Grafana content is visible
    const content = await page.content();
    expect(
      content.includes('Grafana') ||
      content.includes('Home') ||
      content.includes('dashboard'),
    ).toBe(true);
  });

  test('cleanup succeeds', () => {
    const output = dokku(`library:cleanup ${APP} --force`, {
      timeout: 120000,
      swallowErrors: true,
    });
    expect(output).toContain('cleaned up');
  });
});
