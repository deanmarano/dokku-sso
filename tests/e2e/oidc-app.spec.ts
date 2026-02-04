import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';

/**
 * OIDC Application E2E Test - Full Browser Flow
 *
 * Tests a complete OIDC-protected application with browser-based login:
 * 1. Create LLDAP directory service
 * 2. Create Authelia frontend with OIDC enabled (exposed on host port)
 * 3. Deploy oauth2-proxy as an OIDC client (exposed on host port)
 * 4. Create a test user in LLDAP
 * 5. Use Playwright to test the full browser login flow
 *
 * This test exposes services on host ports so Playwright can access them.
 */

const DIRECTORY_SERVICE = 'oidc-app-dir-test';
const FRONTEND_SERVICE = 'oidc-app-frontend-test';
const OIDC_CLIENT_ID = 'oauth2-proxy-test';
const OIDC_CLIENT_SECRET = 'oauth2-proxy-secret-1234567890123456';
const TEST_USER = 'oidcuser';
const TEST_PASSWORD = 'OidcPass123!';
const TEST_EMAIL = 'oidcuser@test.local';
const OAUTH2_PROXY_CONTAINER = 'oauth2-proxy-test';
const BACKEND_CONTAINER = 'whoami-test';
const USE_SUDO = process.env.DOKKU_USE_SUDO === 'true';

// Host ports for browser access
const AUTHELIA_HOST_PORT = 9091;
const OAUTH2_PROXY_HOST_PORT = 4180;

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

// Helper to get container IP
function getContainerIp(containerName: string): string {
  try {
    const ips = execSync(
      `docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' ${containerName}`,
      { encoding: 'utf-8' }
    ).trim();
    return ips.split(' ')[0];
  } catch {
    throw new Error(`Could not get IP for container ${containerName}`);
  }
}

// Get LLDAP credentials
function getLdapCredentials(): Record<string, string> {
  const output = dokku(`auth:credentials ${DIRECTORY_SERVICE}`);
  const creds: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const match = line.match(/^(\w+)=(.+)$/);
    if (match) {
      creds[match[1]] = match[2];
    }
  }
  return creds;
}

// Create user in LLDAP via GraphQL API (using docker exec curl)
function createLdapUser(
  lldapContainer: string,
  adminPassword: string,
  userId: string,
  email: string,
  password: string
): void {
  // Get auth token
  console.log('Getting LLDAP auth token...');
  const tokenResult = execSync(
    `docker exec ${lldapContainer} curl -s -X POST ` +
      `-H "Content-Type: application/json" ` +
      `-d '{"username":"admin","password":"${adminPassword}"}' ` +
      `"http://localhost:17170/auth/simple/login"`,
    { encoding: 'utf-8' }
  );
  const { token } = JSON.parse(tokenResult);
  console.log('Got auth token');

  // Create user via GraphQL
  console.log(`Creating user ${userId}...`);
  const createQuery = `{"query":"mutation CreateUser($user: CreateUserInput!) { createUser(user: $user) { id email } }","variables":{"user":{"id":"${userId}","email":"${email}","displayName":"${userId}","firstName":"Test","lastName":"User"}}}`;

  const createResult = execSync(
    `docker exec ${lldapContainer} curl -s -X POST ` +
      `-H "Content-Type: application/json" ` +
      `-H "Authorization: Bearer ${token}" ` +
      `-d '${createQuery}' ` +
      `"http://localhost:17170/api/graphql"`,
    { encoding: 'utf-8' }
  );

  const createJson = JSON.parse(createResult);
  if (
    createJson.errors &&
    !createJson.errors[0]?.message?.includes('already exists')
  ) {
    console.log('Create user result:', createResult);
  }

  // Set password using lldap_set_password tool
  console.log(`Setting password for ${userId}...`);
  try {
    execSync(
      `docker exec ${lldapContainer} /app/lldap_set_password --base-url http://localhost:17170 ` +
        `--admin-username admin --admin-password "${adminPassword}" ` +
        `--username "${userId}" --password "${password}"`,
      { encoding: 'utf-8', stdio: 'pipe' }
    );
    console.log(`Password set for user: ${userId}`);
  } catch (e: any) {
    console.error('lldap_set_password error:', e.stderr || e.message);
    throw e;
  }

  console.log(`Created LDAP user: ${userId}`);
}

// Wait for service to be healthy
async function waitForHealthy(
  service: string,
  type: 'directory' | 'frontend',
  maxWait = 60000
): Promise<boolean> {
  const start = Date.now();
  const cmd =
    type === 'directory' ? `auth:status ${service}` : `auth:frontend:status ${service}`;

  while (Date.now() - start < maxWait) {
    try {
      const statusCmd = USE_SUDO ? `sudo dokku ${cmd}` : `dokku ${cmd}`;
      const status = execSync(statusCmd, { encoding: 'utf-8' });
      if (status.includes('healthy') || status.includes('running')) {
        return true;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

// Wait for HTTP endpoint to be ready
async function waitForHttp(url: string, maxWait = 60000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });
      if (response.ok || response.status === 302 || response.status === 401 || response.status === 403) {
        return true;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

let AUTHELIA_INTERNAL_IP: string;
let ADMIN_PASSWORD: string;
let AUTH_NETWORK: string;

test.describe('OIDC Application Browser Flow', () => {
  test.beforeAll(async () => {
    console.log('=== Setting up OIDC application test environment ===');

    // 1. Create LLDAP directory service
    console.log('Creating LLDAP directory service...');
    try {
      dokku(`auth:create ${DIRECTORY_SERVICE}`);
    } catch (e: any) {
      if (!e.stderr?.includes('already exists')) {
        throw e;
      }
    }

    // Wait for LLDAP to be healthy
    const ldapHealthy = await waitForHealthy(DIRECTORY_SERVICE, 'directory');
    if (!ldapHealthy) {
      throw new Error('LLDAP service not healthy');
    }

    // Get admin password
    const creds = getLdapCredentials();
    ADMIN_PASSWORD = creds.ADMIN_PASSWORD;

    // Determine the auth network
    AUTH_NETWORK = execSync(
      `docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' dokku.auth.directory.${DIRECTORY_SERVICE}`,
      { encoding: 'utf-8' }
    )
      .trim()
      .split(' ')[0];
    console.log(`Auth network: ${AUTH_NETWORK}`);

    // 2. Create Authelia frontend service
    console.log('Creating Authelia frontend service...');
    try {
      dokku(`auth:frontend:create ${FRONTEND_SERVICE}`);
    } catch (e: any) {
      if (!e.stderr?.includes('already exists')) {
        throw e;
      }
    }

    // 3. Link frontend to directory
    console.log('Linking frontend to directory...');
    try {
      dokku(`auth:frontend:use-directory ${FRONTEND_SERVICE} ${DIRECTORY_SERVICE}`);
    } catch (e: any) {
      if (!e.stderr?.includes('already linked')) {
        console.log('Link result:', e.message);
      }
    }

    // 4. Enable OIDC
    console.log('Enabling OIDC...');
    dokku(`auth:oidc:enable ${FRONTEND_SERVICE}`);

    // 5. Add OIDC client for oauth2-proxy with localhost redirect URI
    const REDIRECT_URI = `http://localhost:${OAUTH2_PROXY_HOST_PORT}/oauth2/callback`;
    console.log('Adding OIDC client...');
    try {
      dokku(
        `auth:oidc:add-client ${FRONTEND_SERVICE} ${OIDC_CLIENT_ID} ${OIDC_CLIENT_SECRET} ${REDIRECT_URI}`
      );
    } catch (e: any) {
      if (!e.stderr?.includes('already exists')) {
        throw e;
      }
    }

    // 6. Apply frontend configuration (this starts the container)
    console.log('Applying frontend configuration...');
    try {
      dokku(`auth:frontend:apply ${FRONTEND_SERVICE}`);
    } catch (e: any) {
      console.log('Apply result:', e.message);
    }

    // Wait for Authelia to be healthy
    console.log('Waiting for Authelia to be ready...');
    await new Promise((r) => setTimeout(r, 5000));

    const autheliaHealthy = await waitForHealthy(FRONTEND_SERVICE, 'frontend', 120000);
    if (!autheliaHealthy) {
      try {
        const logs = dokku(`auth:frontend:logs ${FRONTEND_SERVICE} -n 50`);
        console.log('Authelia logs:', logs);
      } catch {}
      throw new Error('Authelia not healthy');
    }

    // Get Authelia container IP for internal communication
    const autheliaContainerName = `dokku.auth.frontend.${FRONTEND_SERVICE}`;
    AUTHELIA_INTERNAL_IP = getContainerIp(autheliaContainerName);
    console.log(`Authelia internal IP: ${AUTHELIA_INTERNAL_IP}`);

    // 7. Expose Authelia on host port using socat (since we can't easily restart with -p)
    console.log('Exposing Authelia on host port...');
    try {
      execSync(`docker rm -f authelia-port-forward`, { encoding: 'utf-8' });
    } catch {}

    execSync(
      `docker run -d --name authelia-port-forward ` +
        `--network ${AUTH_NETWORK} ` +
        `-p ${AUTHELIA_HOST_PORT}:${AUTHELIA_HOST_PORT} ` +
        `alpine/socat TCP-LISTEN:${AUTHELIA_HOST_PORT},fork,reuseaddr TCP:${AUTHELIA_INTERNAL_IP}:9091`,
      { encoding: 'utf-8' }
    );
    console.log(`Authelia exposed on http://localhost:${AUTHELIA_HOST_PORT}`);

    // 8. Create test user in LLDAP
    const lldapContainer = `dokku.auth.directory.${DIRECTORY_SERVICE}`;
    createLdapUser(
      lldapContainer,
      ADMIN_PASSWORD,
      TEST_USER,
      TEST_EMAIL,
      TEST_PASSWORD
    );

    // 9. Deploy a simple whoami backend
    console.log('Deploying whoami backend...');
    try {
      execSync(`docker rm -f ${BACKEND_CONTAINER}`, { encoding: 'utf-8' });
    } catch {}

    execSync(
      `docker run -d --name ${BACKEND_CONTAINER} ` +
        `--network ${AUTH_NETWORK} ` +
        `traefik/whoami:latest`,
      { encoding: 'utf-8' }
    );

    const backendIp = getContainerIp(BACKEND_CONTAINER);
    console.log(`Whoami backend IP: ${backendIp}`);

    // 10. Deploy oauth2-proxy with host port exposed
    console.log('Deploying oauth2-proxy...');
    try {
      execSync(`docker rm -f ${OAUTH2_PROXY_CONTAINER}`, { encoding: 'utf-8' });
    } catch {}

    // Generate a cookie secret (minimum 16 bytes for oauth2-proxy)
    const cookieSecret = 'oauth2proxysecret123456789012';

    // oauth2-proxy configuration for Authelia OIDC
    // Use localhost URL for issuer since that's where the browser will access it
    execSync(
      `docker run -d --name ${OAUTH2_PROXY_CONTAINER} ` +
        `--network ${AUTH_NETWORK} ` +
        `-p ${OAUTH2_PROXY_HOST_PORT}:4180 ` +
        `-e OAUTH2_PROXY_HTTP_ADDRESS=0.0.0.0:4180 ` +
        `-e OAUTH2_PROXY_PROVIDER=oidc ` +
        `-e OAUTH2_PROXY_OIDC_ISSUER_URL=http://localhost:${AUTHELIA_HOST_PORT} ` +
        `-e OAUTH2_PROXY_CLIENT_ID=${OIDC_CLIENT_ID} ` +
        `-e OAUTH2_PROXY_CLIENT_SECRET=${OIDC_CLIENT_SECRET} ` +
        `-e OAUTH2_PROXY_REDIRECT_URL=http://localhost:${OAUTH2_PROXY_HOST_PORT}/oauth2/callback ` +
        `-e OAUTH2_PROXY_UPSTREAMS=http://${backendIp}:80 ` +
        `-e OAUTH2_PROXY_COOKIE_SECRET=${cookieSecret} ` +
        `-e OAUTH2_PROXY_COOKIE_SECURE=false ` +
        `-e OAUTH2_PROXY_COOKIE_DOMAINS=localhost ` +
        `-e OAUTH2_PROXY_EMAIL_DOMAINS=* ` +
        `-e OAUTH2_PROXY_SKIP_PROVIDER_BUTTON=true ` +
        `-e OAUTH2_PROXY_INSECURE_OIDC_ALLOW_UNVERIFIED_EMAIL=true ` +
        `-e OAUTH2_PROXY_INSECURE_OIDC_SKIP_ISSUER_VERIFICATION=true ` +
        `-e OAUTH2_PROXY_SCOPE="openid profile email" ` +
        `-e OAUTH2_PROXY_CODE_CHALLENGE_METHOD=S256 ` +
        `--add-host=localhost:host-gateway ` +
        `quay.io/oauth2-proxy/oauth2-proxy:latest`,
      { encoding: 'utf-8' }
    );

    // Wait for oauth2-proxy to be accessible on host
    console.log('Waiting for oauth2-proxy to be ready on host...');
    const proxyReady = await waitForHttp(`http://localhost:${OAUTH2_PROXY_HOST_PORT}/ping`, 60000);
    if (!proxyReady) {
      const logs = execSync(`docker logs ${OAUTH2_PROXY_CONTAINER} 2>&1`, {
        encoding: 'utf-8',
      });
      console.log('oauth2-proxy logs:', logs);
      throw new Error('oauth2-proxy not ready on host port');
    }
    console.log('oauth2-proxy is ready');

    // Wait for Authelia to be accessible on host
    console.log('Waiting for Authelia to be ready on host...');
    const autheliaReady = await waitForHttp(`http://localhost:${AUTHELIA_HOST_PORT}/api/health`, 60000);
    if (!autheliaReady) {
      throw new Error('Authelia not ready on host port');
    }
    console.log('Authelia is ready on host');

    console.log('=== Setup complete ===');
    console.log(`Authelia: http://localhost:${AUTHELIA_HOST_PORT}`);
    console.log(`OAuth2 Proxy: http://localhost:${OAUTH2_PROXY_HOST_PORT}`);
  }, 600000); // 10 minute timeout

  test.afterAll(async () => {
    console.log('=== Cleaning up OIDC application test environment ===');
    try {
      execSync(`docker rm -f ${OAUTH2_PROXY_CONTAINER}`, { encoding: 'utf-8' });
    } catch {}
    try {
      execSync(`docker rm -f ${BACKEND_CONTAINER}`, { encoding: 'utf-8' });
    } catch {}
    try {
      execSync(`docker rm -f authelia-port-forward`, { encoding: 'utf-8' });
    } catch {}
    try {
      dokku(`auth:frontend:destroy ${FRONTEND_SERVICE} -f`);
    } catch (e) {
      console.log('Failed to destroy frontend:', e);
    }
    try {
      dokku(`auth:destroy ${DIRECTORY_SERVICE} -f`);
    } catch (e) {
      console.log('Failed to destroy directory:', e);
    }
  });

  test('OIDC browser login flow works end-to-end', async ({ page }) => {
    // This single test covers all OIDC browser flow scenarios to avoid
    // issues with Playwright's retry mechanism running afterAll between retries

    // ===== Test 1: OIDC discovery endpoint is accessible =====
    console.log('Test 1: OIDC discovery endpoint is accessible');
    const discoveryResponse = await page.request.get(
      `http://localhost:${AUTHELIA_HOST_PORT}/.well-known/openid-configuration`
    );

    expect(discoveryResponse.ok()).toBe(true);

    const config = await discoveryResponse.json();
    expect(config).toHaveProperty('issuer');
    expect(config).toHaveProperty('authorization_endpoint');
    expect(config).toHaveProperty('token_endpoint');
    expect(config).toHaveProperty('userinfo_endpoint');
    expect(config).toHaveProperty('jwks_uri');
    console.log('OIDC issuer:', config.issuer);

    // ===== Test 2: Unauthenticated request is redirected to login =====
    console.log('Test 2: Unauthenticated request is redirected to login');
    await page.context().clearCookies();
    await page.goto(`http://localhost:${OAUTH2_PROXY_HOST_PORT}/`);

    // Should redirect to Authelia
    await page.waitForURL(/localhost:9091/, { timeout: 30000 });

    // Verify login form is shown
    const loginFormCheck = page.locator('input[name="username"], input[id="username-textfield"]');
    await expect(loginFormCheck).toBeVisible({ timeout: 15000 });
    console.log('Unauthenticated request correctly redirected to login');

    // ===== Test 3: Invalid credentials are rejected =====
    console.log('Test 3: Invalid credentials are rejected');
    await page.context().clearCookies();
    await page.goto(`http://localhost:${AUTHELIA_HOST_PORT}/`);

    // Fill in wrong credentials
    let usernameInput = page.locator('input[name="username"], input[id="username-textfield"]').first();
    let passwordInput = page.locator('input[name="password"], input[id="password-textfield"]').first();

    await usernameInput.fill(TEST_USER);
    await passwordInput.fill('wrongpassword');

    // Submit
    let submitButton = page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Login")').first();
    await submitButton.click();

    // Should show an error message or stay on login page
    await page.waitForTimeout(2000);
    // Check we're still on the login page (not redirected)
    expect(page.url()).toContain('localhost:9091');
    console.log('Invalid credentials correctly rejected');

    // ===== Test 4: Full OIDC browser login flow =====
    console.log('Test 4: Full OIDC browser login flow');

    // Clear cookies and start fresh
    await page.context().clearCookies();

    // Step 1: Navigate to the protected app
    console.log('Step 4.1: Navigating to protected app...');
    await page.goto(`http://localhost:${OAUTH2_PROXY_HOST_PORT}/`);

    // Step 2: Should be redirected to Authelia login page
    console.log('Step 4.2: Waiting for redirect to Authelia...');
    await page.waitForURL(/localhost:9091/, { timeout: 30000 });

    // Verify we're on the Authelia login page
    console.log('Step 4.3: Verifying Authelia login page...');
    const loginForm = page.locator('input[name="username"], input[id="username-textfield"]');
    await expect(loginForm).toBeVisible({ timeout: 15000 });

    // Take a screenshot for debugging
    await page.screenshot({ path: 'test-results/authelia-login.png' }).catch(() => {});

    // Step 3: Fill in credentials
    console.log('Step 4.4: Filling in credentials...');
    usernameInput = page.locator('input[name="username"], input[id="username-textfield"]').first();
    passwordInput = page.locator('input[name="password"], input[id="password-textfield"]').first();

    await usernameInput.fill(TEST_USER);
    await passwordInput.fill(TEST_PASSWORD);

    // Step 4: Submit the form
    console.log('Step 4.5: Submitting login form...');
    submitButton = page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Login")').first();
    await submitButton.click();

    // Step 5: Wait for redirect back to the app
    console.log('Step 4.6: Waiting for redirect back to app...');

    // Authelia may show a consent screen or redirect directly
    // Wait for either consent or the final redirect
    try {
      // Check if there's a consent button to click
      const consentButton = page.locator('button:has-text("Accept"), button:has-text("Authorize"), button:has-text("Allow")');
      if (await consentButton.isVisible({ timeout: 5000 })) {
        console.log('Found consent screen, clicking accept...');
        await consentButton.click();
      }
    } catch {
      // No consent screen, that's fine
    }

    // Wait for redirect back to oauth2-proxy (our app)
    await page.waitForURL(/localhost:4180/, { timeout: 30000 });

    // Step 6: Verify we can see the whoami content
    console.log('Step 4.7: Verifying whoami content...');

    // whoami shows request headers and info
    // Wait for the page to load
    await page.waitForLoadState('networkidle');

    // Take a screenshot of the final result
    await page.screenshot({ path: 'test-results/whoami-result.png' }).catch(() => {});

    // Check that we see whoami output (it shows hostname, IP, headers etc)
    const pageContent = await page.content();
    console.log('Page content preview:', pageContent.substring(0, 500));

    // whoami outputs "Hostname:" or similar headers info
    const bodyText = await page.locator('body').textContent();
    expect(bodyText).toContain('Hostname');

    console.log('All OIDC browser tests passed!');
  });
});
