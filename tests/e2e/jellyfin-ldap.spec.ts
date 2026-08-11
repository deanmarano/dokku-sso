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
  type TestUser,
  addSelfSignedCert,
} from './helpers';

/**
 * Jellyfin LDAP Integration E2E Test
 *
 * Tests Jellyfin deployed via library:checkout with Authelia forward sso:
 * 1. Deploy Jellyfin as a proper dokku app
 * 2. Protect it with Authelia forward auth
 * 3. Verify auth redirect and login flow
 *
 * Note: library:checkout handles volume setup and configuration.
 * Forward auth protects the app at the nginx level.
 */

const APP = 'test-jellyfin-ldap';
const DOMAIN = `${APP}.test.local`;
const AUTH_SERVICE = 'jellyfin-ldap-auth';
const FRONTEND_SERVICE = 'jellyfin-ldap-fe';
const TEST_USER: TestUser = {
  username: 'jellyuser',
  email: 'jellyuser@test.local',
  password: 'testpassword123',
};

test.describe('Jellyfin LDAP Integration', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    console.log('=== Setting up Jellyfin LDAP test ===');

    setupAuthServices(AUTH_SERVICE, FRONTEND_SERVICE);
    await waitForAuthHealthy(AUTH_SERVICE);
    createLdapTestUser(AUTH_SERVICE, TEST_USER);
    addHostsEntry(DOMAIN);
    addHostsEntry('auth.test.local');

    dokku(
      `library:checkout jellyfin --name=${APP} --domain=${DOMAIN} --no-ssl --non-interactive --auth-service=${AUTH_SERVICE}`,
      { timeout: 300000 },
    );

    // Authelia will not redirect back to an insecure target, so the app has
    // to answer on https for the post-login return trip to land on it.
    addSelfSignedCert(APP, DOMAIN);

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
    await page.context().clearCookies();
    const redirected = await verifyAutheliaRedirect(page, `http://${DOMAIN}/`);
    expect(redirected).toBe(true);
  });

  test('login via Authelia grants access to Jellyfin', async ({ page }) => {
    await page.context().clearCookies();

    await page.goto(`http://${DOMAIN}/`);
    await loginViaAuthelia(page, TEST_USER.username, TEST_USER.password);

    await expect(page).toHaveURL(new RegExp(DOMAIN));

    // Jellyfin shows its web UI or setup wizard after forward auth
    const content = await page.content();
    expect(
      content.includes('Jellyfin') ||
      content.includes('jellyfin') ||
      content.includes('Server') ||
      content.includes('Welcome'),
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
