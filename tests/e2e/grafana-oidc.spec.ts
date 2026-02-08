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
  getGrafanaOidcEnvVars,
} from './helpers';

/**
 * Grafana OIDC Integration E2E Test - Full Browser Flow
 *
 * Tests Grafana with Authelia as an OIDC provider:
 * 1. Create LLDAP directory service
 * 2. Create Authelia frontend with OIDC enabled
 * 3. Deploy Grafana with Generic OAuth configured
 * 4. Use Playwright to test the full browser login flow
 *
 * Requires /etc/hosts entries:
 *   127.0.0.1 grafana-auth.test.local
 *   127.0.0.1 grafana-app.test.local
 */

const DIRECTORY_SERVICE = 'grafana-oidc-dir-test';
const FRONTEND_SERVICE = 'grafana-oidc-fe-test';
const OIDC_CLIENT_ID = 'grafana-oidc-test';
const OIDC_CLIENT_SECRET = 'grafana-oidc-secret-1234567890123';
const TEST_USER = 'grafoidcuser';
const TEST_PASSWORD = 'GrafOidc123!';
const TEST_EMAIL = 'grafoidcuser@test.local';
const GRAFANA_CONTAINER = 'grafana-oidc-test';
const NGINX_CONTAINER = 'nginx-grafana-oidc-proxy';

// Domain names (must be in /etc/hosts pointing to 127.0.0.1)
const AUTH_DOMAIN = 'grafana-auth.test.local';
const APP_DOMAIN = 'grafana-app.test.local';

// HTTPS ports
const AUTHELIA_HTTPS_PORT = 443;
const GRAFANA_HTTPS_PORT = 3443;

// Generate self-signed certificates
function generateCerts(): void {
  console.log('Generating self-signed certificates...');
  execSync(
    `mkdir -p /tmp/grafana-oidc-certs && ` +
      `openssl req -x509 -nodes -days 1 -newkey rsa:2048 ` +
      `-keyout /tmp/grafana-oidc-certs/server.key -out /tmp/grafana-oidc-certs/server.crt ` +
      `-subj "/CN=test.local" ` +
      `-addext "subjectAltName=DNS:grafana-auth.test.local,DNS:grafana-app.test.local,DNS:*.test.local"`,
    { encoding: 'utf-8' }
  );
  console.log('Certificates generated');
}

let AUTHELIA_INTERNAL_IP: string;
let ADMIN_PASSWORD: string;
let AUTH_NETWORK: string;

test.describe('Grafana OIDC Browser Flow', () => {
  test.beforeAll(async () => {
    console.log('=== Setting up Grafana OIDC test environment ===');

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

    // 5. Add OIDC client for Grafana
    const REDIRECT_URI = `https://${APP_DOMAIN}:${GRAFANA_HTTPS_PORT}/login/generic_oauth`;
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

    // 8. Deploy nginx TLS proxy
    console.log('Deploying nginx TLS proxy...');
    try {
      execSync(`docker rm -f ${NGINX_CONTAINER}`, { encoding: 'utf-8', stdio: 'pipe' });
    } catch (e: any) {
      if (!e.stderr?.includes('No such container')) {
        console.log('[cleanup]', e.stderr?.trim() || e.message);
      }
    }

    // Create nginx config - proxy Authelia on 443, Grafana on 3443
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
    # Grafana HTTPS (resolved at request time via Docker DNS)
    server {
        listen 3443 ssl;
        server_name ${APP_DOMAIN};
        ssl_certificate /etc/nginx/certs/server.crt;
        ssl_certificate_key /etc/nginx/certs/server.key;
        location / {
            set $grafana_backend "http://${GRAFANA_CONTAINER}:3000";
            proxy_pass $grafana_backend;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }
    }
}`;

    fs.writeFileSync('/tmp/grafana-oidc-nginx.conf', nginxConfig);

    execSync(
      `docker run -d --name ${NGINX_CONTAINER} ` +
        `--network ${AUTH_NETWORK} ` +
        `-p ${AUTHELIA_HTTPS_PORT}:443 ` +
        `-p ${GRAFANA_HTTPS_PORT}:3443 ` +
        `-v /tmp/grafana-oidc-nginx.conf:/etc/nginx/nginx.conf:ro ` +
        `-v /tmp/grafana-oidc-certs:/etc/nginx/certs:ro ` +
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

    // Get nginx container IP so Grafana can reach auth domain via nginx
    const nginxIp = getContainerIp(NGINX_CONTAINER);
    console.log(`nginx container IP: ${nginxIp}`);

    // 9. Deploy Grafana with OIDC env vars from preset
    console.log('Deploying Grafana with OIDC (using grafana preset)...');
    try {
      execSync(`docker rm -f ${GRAFANA_CONTAINER}`, { encoding: 'utf-8', stdio: 'pipe' });
    } catch (e: any) {
      if (!e.stderr?.includes('No such container')) {
        console.log('[cleanup]', e.stderr?.trim() || e.message);
      }
    }

    // Get OIDC env vars from the preset
    const oidcEnvVars = getGrafanaOidcEnvVars(OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, AUTH_DOMAIN);
    const envFlags = Object.entries(oidcEnvVars)
      .map(([key, value]) => `-e ${key}="${value}"`)
      .join(' ');

    execSync(
      `docker run -d --name ${GRAFANA_CONTAINER} ` +
        `--network ${AUTH_NETWORK} ` +
        `-e GF_SERVER_ROOT_URL=https://${APP_DOMAIN}:${GRAFANA_HTTPS_PORT}/ ` +
        `${envFlags} ` +
        `-e GF_AUTH_GENERIC_OAUTH_TLS_SKIP_VERIFY_INSECURE=true ` +
        `-e GF_SERVER_HTTP_PORT=3000 ` +
        `--add-host=${AUTH_DOMAIN}:${nginxIp} ` +
        `grafana/grafana-oss:latest`,
      { encoding: 'utf-8' }
    );

    // Wait for Grafana to be ready
    console.log('Waiting for Grafana to be ready...');
    let grafanaReady = false;
    for (let i = 0; i < 60; i++) {
      try {
        const result = execSync(
          `docker exec ${GRAFANA_CONTAINER} curl -sf http://localhost:3000/api/health`,
          { encoding: 'utf-8', timeout: 5000 }
        );
        const health = JSON.parse(result);
        if (health.database === 'ok') {
          grafanaReady = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!grafanaReady) {
      const logs = execSync(`docker logs ${GRAFANA_CONTAINER} 2>&1`, { encoding: 'utf-8' });
      console.log('Grafana logs:', logs);
      throw new Error('Grafana not ready');
    }
    console.log('Grafana is ready');

    // Wait for Grafana HTTPS to be accessible via nginx
    console.log('Waiting for Grafana HTTPS to be ready...');
    const grafanaHttpsReady = await waitForHttps(
      `https://${APP_DOMAIN}:${GRAFANA_HTTPS_PORT}/api/health`,
      60000
    );
    if (!grafanaHttpsReady) {
      const logs = execSync(`docker logs ${NGINX_CONTAINER} 2>&1`, { encoding: 'utf-8' });
      console.log('nginx logs:', logs);
      throw new Error('Grafana HTTPS not ready via nginx');
    }
    console.log('Grafana HTTPS is ready');

    console.log('=== Setup complete ===');
    console.log(`Authelia: https://${AUTH_DOMAIN}:${AUTHELIA_HTTPS_PORT}`);
    console.log(`Grafana: https://${APP_DOMAIN}:${GRAFANA_HTTPS_PORT}`);
  }, 600000); // 10 minute timeout

  test.afterAll(async () => {
    console.log('=== Cleaning up Grafana OIDC test environment ===');
    try {
      execSync(`docker rm -f ${NGINX_CONTAINER}`, { encoding: 'utf-8', stdio: 'pipe' });
    } catch (e: any) {
      if (!e.stderr?.includes('No such container')) {
        console.log('[cleanup]', e.stderr?.trim() || e.message);
      }
    }
    try {
      execSync(`docker rm -f ${GRAFANA_CONTAINER}`, { encoding: 'utf-8', stdio: 'pipe' });
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
    // Single test covering the full OIDC browser flow for reliability

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
    console.log('OIDC issuer:', config.issuer);

    // ===== Test 2: Full OIDC browser login flow =====
    console.log('Test 2: Full OIDC browser login flow');

    // Clear cookies and start fresh
    await page.context().clearCookies();

    // Step 1: Navigate to Grafana login page
    console.log('Step 2.1: Navigating to Grafana login...');
    await page.goto(`https://${APP_DOMAIN}:${GRAFANA_HTTPS_PORT}/login`);

    // Step 2: Click "Sign in with Authelia" button
    console.log('Step 2.2: Clicking Sign in with Authelia...');
    const oauthLink = page.locator('a[href*="login/generic_oauth"]');
    await expect(oauthLink).toBeVisible({ timeout: 15000 });
    await page.screenshot({ path: 'test-results/grafana-login.png' }).catch(() => {});
    await oauthLink.click();

    // Step 3: Should be redirected to Authelia login page
    console.log('Step 2.3: Waiting for redirect to Authelia...');
    await page.waitForURL(new RegExp(AUTH_DOMAIN), { timeout: 30000 });

    // Verify we're on the Authelia login page
    console.log('Step 2.4: Verifying Authelia login page...');
    const loginForm = page.locator('input[name="username"], input[id="username-textfield"]');
    await expect(loginForm).toBeVisible({ timeout: 15000 });
    await page.screenshot({ path: 'test-results/grafana-authelia-login.png' }).catch(() => {});

    // Step 4: Fill in credentials
    console.log('Step 2.5: Filling in credentials...');
    const usernameInput = page.locator('input[name="username"], input[id="username-textfield"]').first();
    const passwordInput = page.locator('input[name="password"], input[id="password-textfield"]').first();

    await usernameInput.fill(TEST_USER);
    await passwordInput.fill(TEST_PASSWORD);

    // Step 5: Submit the form
    console.log('Step 2.6: Submitting login form...');
    const submitButton = page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Login")').first();
    await submitButton.click();

    // Step 6: Wait for redirect back to Grafana
    console.log('Step 2.7: Waiting for redirect back to Grafana...');

    // After login, Authelia may show a consent screen
    await page.waitForTimeout(2000);
    const currentUrl = page.url();
    console.log(`Current URL after login: ${currentUrl}`);
    await page.screenshot({ path: 'test-results/grafana-after-login.png' }).catch(() => {});

    // If still on Authelia (consent screen), try to click accept/consent
    if (currentUrl.includes(AUTH_DOMAIN)) {
      console.log('Still on Authelia - checking for consent screen...');
      const pageText = await page.locator('body').textContent();
      console.log('Page text:', pageText?.substring(0, 300));

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

    // Wait for redirect back to Grafana
    await page.waitForURL(new RegExp(APP_DOMAIN), { timeout: 30000 });

    // Step 7: Verify we're logged in to Grafana
    console.log('Step 2.8: Verifying Grafana logged-in state...');
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'test-results/grafana-logged-in.png' }).catch(() => {});

    // Verify via the API that we're logged in as the test user
    const userResponse = await page.request.get(
      `https://${APP_DOMAIN}:${GRAFANA_HTTPS_PORT}/api/user`
    );
    expect(userResponse.ok()).toBe(true);

    const user = await userResponse.json();
    console.log('Grafana user:', JSON.stringify(user));
    // Grafana Generic OAuth sets login to the email address
    expect(user.login).toBe(TEST_EMAIL);

    console.log('All Grafana OIDC browser tests passed!');
  });
});
