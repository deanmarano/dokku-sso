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
  type TestUser,,
  addSelfSignedCert,
} from './helpers';

/**
 * Radarr Forward Auth E2E Test
 *
 * Tests Radarr deployed via library:checkout with Authelia forward sso:
 * 1. Deploy Radarr as a proper dokku app
 * 2. Protect it with Authelia forward auth (via sso:protect)
 * 3. Verify unauthenticated requests redirect to Authelia
 * 4. Verify authenticated users can access Radarr
 *
 * Note: Radarr doesn't support native OIDC/LDAP, so forward auth is the
 * correct approach. library:checkout + sso:protect handles all nginx config.
 */

const APP = 'test-radarr-auth';
const DOMAIN = `${APP}.test.local`;
const AUTH_SERVICE = 'radarr-auth-dir';
const FRONTEND_SERVICE = 'radarr-auth-fe';
const TEST_USER: TestUser = {
  username: 'radarruser',
  email: 'radarruser@test.local',
  password: 'RadarrPass123!',
};

test.describe('Radarr Forward Auth Integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(600000);

  test.beforeAll(async () => {
    console.log('=== Setting up Radarr Forward Auth test ===');

    setupAuthServices(AUTH_SERVICE, FRONTEND_SERVICE);
    await waitForAuthHealthy(AUTH_SERVICE);
    createLdapTestUser(AUTH_SERVICE, TEST_USER);
    addHostsEntry(DOMAIN);
    addHostsEntry('auth.test.local');

    dokku(
      `library:checkout radarr --name=${APP} --domain=${DOMAIN} --no-ssl --non-interactive --auth-service=${AUTH_SERVICE}`,
      { timeout: 300000 },
    );

    // Authelia will not redirect back to an insecure target, so the app has
    // to answer on https for the post-login return trip to land on it.
    addSelfSignedCert(APP, DOMAIN);

    console.log('=== Setup complete ===');
  });

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
    await page.context().clearCookies();
    const redirected = await verifyAutheliaRedirect(page, `http://${DOMAIN}/`);
    expect(redirected).toBe(true);
  });

  test('full forward auth login flow', async ({ page }) => {
    await page.context().clearCookies();

    // Navigate to Radarr - should redirect to Authelia
    await page.goto(`http://${DOMAIN}/`);
    await loginViaAuthelia(page, TEST_USER.username, TEST_USER.password);

    // Should be back on the app domain
    await expect(page).toHaveURL(new RegExp(DOMAIN));

    // Verify Radarr UI is visible
    const content = await page.content();
    expect(
      content.includes('Radarr') ||
      content.includes('System') ||
      content.includes('Movies'),
    ).toBe(true);

    console.log('Forward auth login successful!');
  });

  test('cleanup succeeds', () => {
    const output = dokku(`library:cleanup ${APP} --force`, {
      timeout: 120000,
      swallowErrors: true,
    });
    expect(output).toContain('cleaned up');
  });
});
