import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import { getContainerIp } from './helpers';

/**
 * E2E tests for LLDAP web UI login
 *
 * Prerequisites:
 * - LLDAP service running (created by global-setup)
 * - Admin credentials available
 */

const SERVICE_NAME = process.env.E2E_SERVICE_NAME || 'e2e-shared';

// Helper to get admin password
function getAdminPassword(serviceName: string): string {
  try {
    const output = execSync(`dokku auth:credentials ${serviceName}`, { encoding: 'utf-8' });
    const match = output.match(/ADMIN_PASSWORD=(.+)/);
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

// Get service details dynamically
let LLDAP_URL: string;
let ADMIN_PASSWORD: string;
const ADMIN_USER = 'admin';

test.beforeAll(() => {
  const containerIp = getContainerIp(`dokku.auth.directory.${SERVICE_NAME}`);
  LLDAP_URL = `http://${containerIp}:17170`;
  ADMIN_PASSWORD = getAdminPassword(SERVICE_NAME);
  console.log(`LLDAP URL: ${LLDAP_URL}`);
  console.log(`Admin password: ${ADMIN_PASSWORD ? '(set)' : '(not set)'}`);
});

test.describe('LLDAP Web UI', () => {
  test('should display login page', async ({ page }) => {
    await page.goto(LLDAP_URL);

    // LLDAP shows a login form
    await expect(page.locator('input[name="username"], input[type="text"]').first()).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
  });

  test('should login as admin', async ({ page }) => {
    await page.goto(LLDAP_URL);

    // Fill login form
    await page.locator('input[name="username"], input[type="text"]').first().fill(ADMIN_USER);
    await page.locator('input[type="password"]').fill(ADMIN_PASSWORD);

    // Submit
    await page.locator('button[type="submit"], input[type="submit"]').click();

    // Wait for navigation/login to complete
    await page.waitForLoadState('networkidle');

    // Should see admin dashboard - LLDAP shows "Users" or "Groups" navigation
    // Use OR selector properly
    await expect(
      page.getByRole('link', { name: /users/i }).or(page.getByText(/user list/i)).or(page.locator('nav'))
    ).toBeVisible({ timeout: 15000 });
  });

  test('should reject invalid credentials', async ({ page }) => {
    await page.goto(LLDAP_URL);

    await page.locator('input[name="username"], input[type="text"]').first().fill('admin');
    await page.locator('input[type="password"]').fill('wrong-password');
    await page.locator('button[type="submit"], input[type="submit"]').click();

    // Wait a bit for error to appear
    await page.waitForTimeout(2000);

    // Should show error - look for common error indicators
    const hasError = await page.locator('.alert, .error, [class*="error"], [class*="danger"]').count() > 0;
    const hasErrorText = await page.getByText(/invalid|error|failed|incorrect|wrong/i).count() > 0;
    const stillOnLogin = await page.locator('input[type="password"]').isVisible();

    // Either we see an error message or we're still on the login page
    expect(hasError || hasErrorText || stillOnLogin).toBeTruthy();
  });

  test('should navigate to user management after login', async ({ page }) => {
    // Login as admin first
    await page.goto(LLDAP_URL);
    await page.locator('input[name="username"], input[type="text"]').first().fill(ADMIN_USER);
    await page.locator('input[type="password"]').fill(ADMIN_PASSWORD);
    await page.locator('button[type="submit"], input[type="submit"]').click();

    // Wait for login to complete
    await page.waitForLoadState('networkidle');

    // Look for navigation elements or user management link
    const usersLink = page.getByRole('link', { name: /users/i });
    const createUserBtn = page.getByRole('button', { name: /create|add/i });
    const userListTable = page.locator('table');

    // At least one of these should be visible after login
    const isLoggedIn = await usersLink.or(createUserBtn).or(userListTable).first().isVisible({ timeout: 10000 });
    expect(isLoggedIn).toBeTruthy();
  });
});
