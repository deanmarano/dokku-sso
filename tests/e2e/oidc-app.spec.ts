import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import {
  USE_SUDO,
  dokku,
  getContainerIp,
  getLdapCredentials,
  createLdapUser,
  waitForHealthy,
  waitForHttps,
} from './helpers';

/**
 * OIDC Application E2E Test - Full Browser Flow
 *
 * Tests a complete OIDC-protected application with browser-based login:
 * 1. Create LLDAP directory service
 * 2. Create Authelia frontend with OIDC enabled
 * 3. Deploy oauth2-proxy as an OIDC client
 * 4. Create a test user in LLDAP
 * 5. Use Playwright to test the full browser login flow
 *
 * Requires /etc/hosts entries:
 *   127.0.0.1 auth.test.local
 *   127.0.0.1 app.test.local
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
const NGINX_CONTAINER = 'nginx-tls-proxy';

// Domain names (must be in /etc/hosts pointing to 127.0.0.1)
const AUTH_DOMAIN = 'auth.test.local';
const APP_DOMAIN = 'app.test.local';

// HTTPS ports - use 443 for Authelia so the OIDC issuer URL matches
// (Authelia generates issuer as https://DOMAIN without port, so we need default 443)
const AUTHELIA_HTTPS_PORT = 443;
const OAUTH2_PROXY_HTTPS_PORT = 4443;

// Generate self-signed certificates
function generateCerts(): void {
  console.log('Generating self-signed certificates...');
  execSync(
    `mkdir -p /tmp/certs && ` +
      `openssl req -x509 -nodes -days 1 -newkey rsa:2048 ` +
      `-keyout /tmp/certs/server.key -out /tmp/certs/server.crt ` +
      `-subj "/CN=test.local" ` +
      `-addext "subjectAltName=DNS:auth.test.local,DNS:app.test.local,DNS:*.test.local"`,
    { encoding: 'utf-8' }
  );
  console.log('Certificates generated');
}

let AUTHELIA_INTERNAL_IP: string;
let ADMIN_PASSWORD: string;
let AUTH_NETWORK: string;

test.describe('OIDC Application Browser Flow', () => {
  test.beforeAll(async () => {
    console.log('=== Setting up OIDC application test environment ===');

    // Generate self-signed certificates
    generateCerts();

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
    const creds = getLdapCredentials(DIRECTORY_SERVICE);
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

    // 2b. Configure Authelia domain
    console.log('Configuring Authelia domain...');
    dokku(`auth:frontend:config ${FRONTEND_SERVICE} DOMAIN=${AUTH_DOMAIN}`);

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

    // 5. Add OIDC client for oauth2-proxy
    const REDIRECT_URI = `https://${APP_DOMAIN}:${OAUTH2_PROXY_HTTPS_PORT}/oauth2/callback`;
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

    // 7. Create test user in LLDAP
    const lldapContainer = `dokku.auth.directory.${DIRECTORY_SERVICE}`;
    createLdapUser(
      lldapContainer,
      ADMIN_PASSWORD,
      TEST_USER,
      TEST_EMAIL,
      TEST_PASSWORD
    );

    // 8. Deploy a simple whoami backend
    console.log('Deploying whoami backend...');
    try {
      execSync(`docker rm -f ${BACKEND_CONTAINER}`, { encoding: 'utf-8', stdio: 'pipe' });
    } catch (e: any) {
      if (!e.stderr?.includes('No such container')) {
        console.log('[cleanup]', e.stderr?.trim() || e.message);
      }
    }

    execSync(
      `docker run -d --name ${BACKEND_CONTAINER} ` +
        `--network ${AUTH_NETWORK} ` +
        `traefik/whoami:latest`,
      { encoding: 'utf-8' }
    );

    const backendIp = getContainerIp(BACKEND_CONTAINER);
    console.log(`Whoami backend IP: ${backendIp}`);

    // 9. Deploy nginx FIRST as TLS terminating proxy
    // nginx must be up before oauth2-proxy because oauth2-proxy fetches
    // OIDC discovery from https://auth.test.local:9443 on startup.
    // Use Docker DNS resolver so nginx can resolve oauth2-proxy by container name
    // (it doesn't exist yet, but will be resolved at request time, not startup).
    console.log('Deploying nginx TLS proxy...');
    try {
      execSync(`docker rm -f ${NGINX_CONTAINER}`, { encoding: 'utf-8', stdio: 'pipe' });
    } catch (e: any) {
      if (!e.stderr?.includes('No such container')) {
        console.log('[cleanup]', e.stderr?.trim() || e.message);
      }
    }

    // Create nginx config using Docker's embedded DNS resolver
    // The 'set $var' + proxy_pass $var pattern makes nginx resolve at request time
    const nginxConfig = `
events { worker_connections 1024; }
http {
    resolver 127.0.0.11 valid=10s;

    # Authelia HTTPS
    server {
        listen 443 ssl;
        server_name ${AUTH_DOMAIN};
        ssl_certificate /etc/nginx/certs/server.crt;
        ssl_certificate_key /etc/nginx/certs/server.key;
        location / {
            proxy_pass http://${AUTHELIA_INTERNAL_IP}:9091;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }
    }
    # oauth2-proxy HTTPS (resolved at request time via Docker DNS)
    server {
        listen 4443 ssl;
        server_name ${APP_DOMAIN};
        ssl_certificate /etc/nginx/certs/server.crt;
        ssl_certificate_key /etc/nginx/certs/server.key;
        location / {
            set $oauth2_backend "http://${OAUTH2_PROXY_CONTAINER}:4180";
            proxy_pass $oauth2_backend;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }
    }
}`;

    fs.writeFileSync('/tmp/nginx.conf', nginxConfig);

    execSync(
      `docker run -d --name ${NGINX_CONTAINER} ` +
        `--network ${AUTH_NETWORK} ` +
        `-p ${AUTHELIA_HTTPS_PORT}:443 ` +
        `-p ${OAUTH2_PROXY_HTTPS_PORT}:4443 ` +
        `-v /tmp/nginx.conf:/etc/nginx/nginx.conf:ro ` +
        `-v /tmp/certs:/etc/nginx/certs:ro ` +
        `nginx:alpine`,
      { encoding: 'utf-8' }
    );

    // Wait for nginx to be ready
    console.log('Waiting for nginx TLS proxy to be ready...');
    await new Promise((r) => setTimeout(r, 3000));

    // Wait for Authelia HTTPS to be accessible via nginx
    console.log('Waiting for Authelia HTTPS to be ready...');
    const autheliaHttpsReady = await waitForHttps(
      `https://${AUTH_DOMAIN}:${AUTHELIA_HTTPS_PORT}/api/health`,
      60000
    );
    if (!autheliaHttpsReady) {
      const logs = execSync(`docker logs ${NGINX_CONTAINER} 2>&1`, { encoding: 'utf-8' });
      console.log('nginx logs:', logs);
      throw new Error('Authelia HTTPS not ready');
    }
    console.log('Authelia HTTPS is ready');

    // Get nginx container IP so oauth2-proxy can reach auth.test.local via nginx
    const nginxIp = getContainerIp(NGINX_CONTAINER);
    console.log(`nginx container IP: ${nginxIp}`);

    // 10. Deploy oauth2-proxy (AFTER nginx so OIDC discovery works)
    console.log('Deploying oauth2-proxy...');
    try {
      execSync(`docker rm -f ${OAUTH2_PROXY_CONTAINER}`, { encoding: 'utf-8', stdio: 'pipe' });
    } catch (e: any) {
      if (!e.stderr?.includes('No such container')) {
        console.log('[cleanup]', e.stderr?.trim() || e.message);
      }
    }

    // Cookie secret must be exactly 16, 24, or 32 bytes for AES cipher
    const cookieSecret = '01234567890123456789012345678901'; // exactly 32 bytes

    // oauth2-proxy reaches OIDC discovery via nginx (using --add-host to route
    // auth.test.local to nginx's container IP on port 443)
    execSync(
      `docker run -d --name ${OAUTH2_PROXY_CONTAINER} ` +
        `--network ${AUTH_NETWORK} ` +
        `-e OAUTH2_PROXY_HTTP_ADDRESS=0.0.0.0:4180 ` +
        `-e OAUTH2_PROXY_PROVIDER=oidc ` +
        `-e OAUTH2_PROXY_OIDC_ISSUER_URL=https://${AUTH_DOMAIN} ` +
        `-e OAUTH2_PROXY_CLIENT_ID=${OIDC_CLIENT_ID} ` +
        `-e OAUTH2_PROXY_CLIENT_SECRET=${OIDC_CLIENT_SECRET} ` +
        `-e OAUTH2_PROXY_REDIRECT_URL=https://${APP_DOMAIN}:${OAUTH2_PROXY_HTTPS_PORT}/oauth2/callback ` +
        `-e OAUTH2_PROXY_UPSTREAMS=http://${backendIp}:80 ` +
        `-e OAUTH2_PROXY_COOKIE_SECRET=${cookieSecret} ` +
        `-e OAUTH2_PROXY_COOKIE_SECURE=true ` +
        `-e OAUTH2_PROXY_COOKIE_DOMAINS=.test.local ` +
        `-e OAUTH2_PROXY_EMAIL_DOMAINS=* ` +
        `-e OAUTH2_PROXY_SKIP_PROVIDER_BUTTON=true ` +
        `-e OAUTH2_PROXY_INSECURE_OIDC_ALLOW_UNVERIFIED_EMAIL=true ` +
        `-e OAUTH2_PROXY_SSL_INSECURE_SKIP_VERIFY=true ` +
        `-e OAUTH2_PROXY_SCOPE="openid profile email" ` +
        `-e OAUTH2_PROXY_CODE_CHALLENGE_METHOD=S256 ` +
        `--add-host=${AUTH_DOMAIN}:${nginxIp} ` +
        `quay.io/oauth2-proxy/oauth2-proxy:latest`,
      { encoding: 'utf-8' }
    );

    // Wait for oauth2-proxy to start and be accessible via nginx
    console.log('Waiting for oauth2-proxy to be ready...');
    await new Promise((r) => setTimeout(r, 5000));

    // Check if oauth2-proxy is running
    try {
      const proxyStatus = execSync(
        `docker inspect -f '{{.State.Status}}' ${OAUTH2_PROXY_CONTAINER}`,
        { encoding: 'utf-8' }
      ).trim();
      console.log(`oauth2-proxy status: ${proxyStatus}`);
      if (proxyStatus !== 'running') {
        const logs = execSync(`docker logs ${OAUTH2_PROXY_CONTAINER} 2>&1`, {
          encoding: 'utf-8',
        });
        console.log('oauth2-proxy logs:', logs);
        throw new Error(`oauth2-proxy not running: ${proxyStatus}`);
      }
    } catch (e: any) {
      if (e.message?.includes('oauth2-proxy not running')) throw e;
      console.log('Could not check oauth2-proxy status:', e.message);
    }

    // Wait for oauth2-proxy HTTPS to be accessible via nginx
    console.log('Waiting for oauth2-proxy HTTPS to be ready...');
    const proxyHttpsReady = await waitForHttps(
      `https://${APP_DOMAIN}:${OAUTH2_PROXY_HTTPS_PORT}/ping`,
      60000
    );
    if (!proxyHttpsReady) {
      const logs = execSync(`docker logs ${OAUTH2_PROXY_CONTAINER} 2>&1`, {
        encoding: 'utf-8',
      });
      console.log('oauth2-proxy logs:', logs);
      throw new Error('oauth2-proxy HTTPS not ready');
    }
    console.log('oauth2-proxy HTTPS is ready');

    console.log('=== Setup complete ===');
    console.log(`Authelia: https://${AUTH_DOMAIN}:${AUTHELIA_HTTPS_PORT}`);
    console.log(`OAuth2 Proxy: https://${APP_DOMAIN}:${OAUTH2_PROXY_HTTPS_PORT}`);
  }, 600000); // 10 minute timeout

  test.afterAll(async () => {
    console.log('=== Cleaning up OIDC application test environment ===');
    try {
      execSync(`docker rm -f ${NGINX_CONTAINER}`, { encoding: 'utf-8', stdio: 'pipe' });
    } catch (e: any) {
      if (!e.stderr?.includes('No such container')) {
        console.log('[cleanup]', e.stderr?.trim() || e.message);
      }
    }
    try {
      execSync(`docker rm -f ${OAUTH2_PROXY_CONTAINER}`, { encoding: 'utf-8', stdio: 'pipe' });
    } catch (e: any) {
      if (!e.stderr?.includes('No such container')) {
        console.log('[cleanup]', e.stderr?.trim() || e.message);
      }
    }
    try {
      execSync(`docker rm -f ${BACKEND_CONTAINER}`, { encoding: 'utf-8', stdio: 'pipe' });
    } catch (e: any) {
      if (!e.stderr?.includes('No such container')) {
        console.log('[cleanup]', e.stderr?.trim() || e.message);
      }
    }
    try {
      dokku(`auth:frontend:destroy ${FRONTEND_SERVICE} -f`, { quiet: true });
    } catch (e: any) {
      console.log('[cleanup] frontend:destroy:', e.stderr?.trim() || e.message);
    }
    try {
      dokku(`auth:destroy ${DIRECTORY_SERVICE} -f`, { quiet: true });
    } catch (e: any) {
      console.log('[cleanup] auth:destroy:', e.stderr?.trim() || e.message);
    }
  });

  test('OIDC browser login flow works end-to-end', async ({ page }) => {
    // This single test covers all OIDC browser flow scenarios to avoid
    // issues with Playwright's retry mechanism running afterAll between retries

    // ===== Test 1: OIDC discovery endpoint is accessible =====
    console.log('Test 1: OIDC discovery endpoint is accessible');
    const discoveryResponse = await page.request.get(
      `https://${AUTH_DOMAIN}:${AUTHELIA_HTTPS_PORT}/.well-known/openid-configuration`
    );

    expect(discoveryResponse.ok()).toBe(true);

    const config = await discoveryResponse.json();
    expect(config).toHaveProperty('issuer');
    expect(config).toHaveProperty('authorization_endpoint');
    expect(config).toHaveProperty('token_endpoint');
    expect(config).toHaveProperty('userinfo_endpoint');
    expect(config).toHaveProperty('jwks_uri');
    console.log('OIDC issuer:', config.issuer);

    // ===== Test 2: Full OIDC browser login flow =====
    console.log('Test 2: Full OIDC browser login flow');

    // Clear cookies and start fresh
    await page.context().clearCookies();

    // Step 1: Navigate to the protected app
    console.log('Step 2.1: Navigating to protected app...');
    await page.goto(`https://${APP_DOMAIN}:${OAUTH2_PROXY_HTTPS_PORT}/`);

    // Step 2: Should be redirected to Authelia login page
    console.log('Step 2.2: Waiting for redirect to Authelia...');
    await page.waitForURL(new RegExp(AUTH_DOMAIN), { timeout: 30000 });

    // Verify we're on the Authelia login page
    console.log('Step 2.3: Verifying Authelia login page...');
    const loginForm = page.locator('input[name="username"], input[id="username-textfield"]');
    await expect(loginForm).toBeVisible({ timeout: 15000 });

    // Take a screenshot for debugging
    await page.screenshot({ path: 'test-results/authelia-login.png' }).catch(() => {});

    // Step 3: Fill in credentials
    console.log('Step 2.4: Filling in credentials...');
    const usernameInput = page.locator('input[name="username"], input[id="username-textfield"]').first();
    const passwordInput = page.locator('input[name="password"], input[id="password-textfield"]').first();

    await usernameInput.fill(TEST_USER);
    await passwordInput.fill(TEST_PASSWORD);

    // Step 4: Submit the form
    console.log('Step 2.5: Submitting login form...');
    const submitButton = page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Login")').first();
    await submitButton.click();

    // Step 5: Wait for redirect back to the app
    console.log('Step 2.6: Waiting for redirect back to app...');

    // After login, Authelia may show a consent screen.
    // With consent_mode: implicit, consent is auto-granted.
    // Wait a moment for any processing, then take screenshot for debugging.
    await page.waitForTimeout(2000);
    const currentUrl = page.url();
    console.log(`Current URL after login: ${currentUrl}`);
    await page.screenshot({ path: 'test-results/after-login.png' }).catch(() => {});

    // If still on Authelia (consent screen), try to click accept/consent
    if (currentUrl.includes(AUTH_DOMAIN)) {
      console.log('Still on Authelia - checking for consent screen...');
      const pageText = await page.locator('body').textContent();
      console.log('Page text:', pageText?.substring(0, 300));

      // Try various consent button selectors
      const consentSelectors = [
        'button:has-text("Accept")',
        'button:has-text("Consent")',
        'button:has-text("Authorize")',
        'button:has-text("Allow")',
        'button[type="submit"]',
      ];
      for (const selector of consentSelectors) {
        try {
          const btn = page.locator(selector).first();
          if (await btn.isVisible({ timeout: 2000 })) {
            console.log(`Found consent button: ${selector}`);
            await btn.click();
            break;
          }
        } catch {
          // Try next selector
        }
      }
    }

    // Wait for redirect back to oauth2-proxy (our app)
    await page.waitForURL(new RegExp(APP_DOMAIN), { timeout: 30000 });

    // Step 6: Verify we can see the whoami content
    console.log('Step 2.7: Verifying whoami content...');

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
