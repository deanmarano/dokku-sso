import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import {
  dokku,
  getContainerIp,
  getLdapCredentials,
  waitForHealthy,
  waitForHttps,
} from './helpers';

/**
 * Authentik + Grafana OIDC Integration E2E Test
 *
 * Tests the full OIDC flow with Authentik as the identity provider:
 * 1. Create LLDAP directory service
 * 2. Create Authentik frontend with bootstrap credentials
 * 3. Configure Authentik via API (create OAuth2 provider + application)
 * 4. Deploy nginx TLS proxy
 * 5. Deploy Grafana with OIDC config pointing to Authentik
 * 6. Test the full browser login flow
 *
 * Requires:
 *   - dokku postgres and redis plugins installed
 *   - /etc/hosts entries:
 *       127.0.0.1 authentik-grafana.test.local
 *       127.0.0.1 grafana-authentik.test.local
 */

const DIRECTORY_SERVICE = 'ak-graf-oidc-dir';
const FRONTEND_SERVICE = 'ak-graf-oidc-fe';
const OIDC_CLIENT_ID = 'grafana-authentik-oidc';
const OIDC_CLIENT_SECRET = 'grafana-authentik-secret-123456789';
const TEST_USER = 'akoidcuser';
const TEST_PASSWORD = 'AkOidc123!';
const TEST_EMAIL = 'akoidcuser@test.local';
const GRAFANA_CONTAINER = 'grafana-authentik-oidc-test';
const NGINX_CONTAINER = 'nginx-authentik-grafana-proxy';

// Domain names (must be in /etc/hosts pointing to 127.0.0.1)
const AUTH_DOMAIN = 'authentik-grafana.test.local';
const APP_DOMAIN = 'grafana-authentik.test.local';

// HTTPS ports
const AUTHENTIK_HTTPS_PORT = 9443;
const GRAFANA_HTTPS_PORT = 9444;

let AUTHENTIK_INTERNAL_IP: string;
let BOOTSTRAP_TOKEN: string;
let AUTH_NETWORK: string;

// Generate self-signed certificates
function generateCerts(): void {
  console.log('Generating self-signed certificates...');
  execSync(
    `mkdir -p /tmp/authentik-grafana-certs && ` +
      `openssl req -x509 -nodes -days 1 -newkey rsa:2048 ` +
      `-keyout /tmp/authentik-grafana-certs/server.key -out /tmp/authentik-grafana-certs/server.crt ` +
      `-subj "/CN=test.local" ` +
      `-addext "subjectAltName=DNS:${AUTH_DOMAIN},DNS:${APP_DOMAIN},DNS:*.test.local"`,
    { encoding: 'utf-8' }
  );
  console.log('Certificates generated');
}

// Get Authentik bootstrap credentials
function getAuthentikCredentials(serviceName: string): { password: string; token: string } {
  // Read from config files directly
  const configDir = `/var/lib/dokku/services/auth/frontend/${serviceName}/config`;
  const password = execSync(`sudo cat ${configDir}/BOOTSTRAP_PASSWORD`, { encoding: 'utf-8' }).trim();
  const token = execSync(`sudo cat ${configDir}/BOOTSTRAP_TOKEN`, { encoding: 'utf-8' }).trim();
  return { password, token };
}

// Make API request to Authentik via host curl (not docker exec)
function authentikApiRequest(
  method: string,
  path: string,
  token: string,
  body?: object
): { ok: boolean; data?: any; error?: string } {
  const url = `https://${AUTH_DOMAIN}:${AUTHENTIK_HTTPS_PORT}${path}`;
  const curlArgs = [
    'curl', '-sk', '-X', method,
    '-H', `Authorization: Bearer ${token}`,
    '-H', 'Content-Type: application/json',
  ];
  if (body) {
    curlArgs.push('-d', JSON.stringify(body));
  }
  curlArgs.push(url);

  try {
    const result = execSync(curlArgs.join(' '), { encoding: 'utf-8', timeout: 30000 });
    return { ok: true, data: JSON.parse(result) };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

// Configure Authentik via API - create OAuth2 provider and application
async function configureAuthentikOAuth2(
  token: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<void> {
  console.log('Configuring Authentik OAuth2 provider via API...');

  // First, get the authorization flow pk
  let authFlowPk = '';
  const flowsResult = authentikApiRequest('GET', '/api/v3/flows/instances/?designation=authorization', token);
  if (flowsResult.ok && flowsResult.data?.results?.length > 0) {
    authFlowPk = flowsResult.data.results[0].pk;
    console.log(`Found authorization flow: ${authFlowPk}`);
  } else {
    console.log('Could not get flows:', flowsResult.error || 'empty results');
  }

  // Create OAuth2 provider
  const providerPayload: any = {
    name: 'Grafana OIDC Provider',
    client_type: 'confidential',
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uris: redirectUri,
    signing_key: null,
    access_code_validity: 'minutes=1',
    access_token_validity: 'minutes=5',
    refresh_token_validity: 'days=30',
    include_claims_in_id_token: true,
    sub_mode: 'user_email',
  };
  if (authFlowPk) {
    providerPayload.authorization_flow = authFlowPk;
  }

  let providerPk = '';
  const providerResult = authentikApiRequest('POST', '/api/v3/providers/oauth2/', token, providerPayload);
  if (providerResult.ok && providerResult.data?.pk) {
    providerPk = providerResult.data.pk;
    console.log(`OAuth2 provider created with pk: ${providerPk}`);
  } else {
    console.log('OAuth2 provider creation result:', providerResult.error || 'no pk returned');
    // Try to get existing provider
    const existingResult = authentikApiRequest('GET', `/api/v3/providers/oauth2/?search=${clientId}`, token);
    if (existingResult.ok && existingResult.data?.results?.length > 0) {
      providerPk = existingResult.data.results[0].pk;
      console.log(`Found existing provider: ${providerPk}`);
    }
  }

  if (!providerPk) {
    console.log('Warning: Could not create or find OAuth2 provider');
    return;
  }

  // Create application
  const appPayload = {
    name: 'Grafana',
    slug: 'grafana',
    provider: parseInt(providerPk),
    meta_launch_url: `https://${APP_DOMAIN}:${GRAFANA_HTTPS_PORT}/`,
    open_in_new_tab: false,
  };

  const appResult = authentikApiRequest('POST', '/api/v3/core/applications/', token, appPayload);
  if (appResult.ok) {
    console.log('Application created');
  } else {
    console.log('Application creation result:', appResult.error);
  }
}

// Create a user in Authentik via API
async function createAuthentikUser(
  token: string,
  username: string,
  email: string,
  password: string
): Promise<void> {
  console.log(`Creating user ${username} in Authentik...`);

  const userPayload = {
    username: username,
    name: username,
    email: email,
    is_active: true,
    groups: [],
  };

  let userPk = '';
  const userResult = authentikApiRequest('POST', '/api/v3/core/users/', token, userPayload);
  if (userResult.ok && userResult.data?.pk) {
    userPk = userResult.data.pk;
    console.log(`User created with pk: ${userPk}`);
  } else {
    console.log('User creation result:', userResult.error || 'no pk returned');
    // Try to get existing user
    const existingResult = authentikApiRequest('GET', `/api/v3/core/users/?username=${username}`, token);
    if (existingResult.ok && existingResult.data?.results?.length > 0) {
      userPk = existingResult.data.results[0].pk;
      console.log(`Found existing user: ${userPk}`);
    }
  }

  if (!userPk) {
    console.log('Warning: Could not create or find user');
    return;
  }

  // Set password
  const passwordResult = authentikApiRequest('POST', `/api/v3/core/users/${userPk}/set_password/`, token, { password });
  if (passwordResult.ok) {
    console.log('Password set');
  } else {
    console.log('Password set result:', passwordResult.error);
  }
}

test.describe('Authentik + Grafana OIDC Browser Flow', () => {
  test.beforeAll(async () => {
    console.log('=== Setting up Authentik + Grafana OIDC test ===');

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

    const ldapHealthy = await waitForHealthy(DIRECTORY_SERVICE, 'directory');
    if (!ldapHealthy) {
      throw new Error('LLDAP service not healthy');
    }

    // Determine the auth network
    AUTH_NETWORK = execSync(
      `docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' dokku.auth.directory.${DIRECTORY_SERVICE}`,
      { encoding: 'utf-8' }
    ).trim().split(' ')[0];
    console.log(`Auth network: ${AUTH_NETWORK}`);

    // 2. Create Authentik frontend service
    console.log('Creating Authentik frontend service...');

    // Force cleanup of any leftover service from previous runs
    const serviceDir = `/var/lib/dokku/services/auth/frontend/${FRONTEND_SERVICE}`;
    try {
      // Try to destroy via dokku first
      dokku(`auth:frontend:destroy ${FRONTEND_SERVICE} -f`, { quiet: true, swallowErrors: true });
    } catch {}
    // Also forcefully remove the service directory if it exists
    try {
      execSync(`sudo rm -rf ${serviceDir}`, { encoding: 'utf-8', stdio: 'pipe' });
    } catch {}
    // And clean up any leftover containers
    for (const suffix of ['', '.worker', '.postgres', '.redis']) {
      try {
        execSync(`docker rm -f dokku.auth.frontend.${FRONTEND_SERVICE}${suffix}`, { encoding: 'utf-8', stdio: 'pipe' });
      } catch {}
    }

    dokku(`auth:frontend:create ${FRONTEND_SERVICE} --provider authentik`);

    // Wait for Authentik to be healthy
    console.log('Waiting for Authentik to be ready...');
    const authentikHealthy = await waitForHealthy(FRONTEND_SERVICE, 'frontend', 180000);
    if (!authentikHealthy) {
      try {
        const logs = dokku(`auth:frontend:logs ${FRONTEND_SERVICE} -n 50`);
        console.log('Authentik logs:', logs);
      } catch {}
      throw new Error('Authentik not healthy');
    }

    // Get Authentik container info
    const authentikContainerName = `dokku.auth.frontend.${FRONTEND_SERVICE}`;
    AUTHENTIK_INTERNAL_IP = getContainerIp(authentikContainerName);
    console.log(`Authentik internal IP: ${AUTHENTIK_INTERNAL_IP}`);

    // Get bootstrap credentials
    const akCreds = getAuthentikCredentials(FRONTEND_SERVICE);
    BOOTSTRAP_TOKEN = akCreds.token;
    console.log('Got Authentik bootstrap credentials');

    // 4. Deploy nginx TLS proxy first (needed for API calls)
    console.log('Deploying nginx TLS proxy...');
    try {
      execSync(`docker rm -f ${NGINX_CONTAINER}`, { encoding: 'utf-8', stdio: 'pipe' });
    } catch {}

    // Create nginx config
    const nginxConfig = `
events { worker_connections 1024; }
http {
    resolver 127.0.0.11 valid=10s;

    # Authentik HTTPS
    server {
        listen 443 ssl;
        server_name ${AUTH_DOMAIN};
        ssl_certificate /etc/nginx/certs/server.crt;
        ssl_certificate_key /etc/nginx/certs/server.key;
        location / {
            proxy_pass http://${AUTHENTIK_INTERNAL_IP}:9000;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_buffer_size 128k;
            proxy_buffers 4 256k;
            proxy_busy_buffers_size 256k;
        }
    }
    # Grafana HTTPS
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
    fs.writeFileSync('/tmp/authentik-grafana-nginx.conf', nginxConfig);

    execSync(
      `docker run -d --name ${NGINX_CONTAINER} ` +
        `--network ${AUTH_NETWORK} ` +
        `-p ${AUTHENTIK_HTTPS_PORT}:443 ` +
        `-p ${GRAFANA_HTTPS_PORT}:3443 ` +
        `-v /tmp/authentik-grafana-nginx.conf:/etc/nginx/nginx.conf:ro ` +
        `-v /tmp/authentik-grafana-certs:/etc/nginx/certs:ro ` +
        `nginx:alpine`,
      { encoding: 'utf-8' }
    );

    await new Promise((r) => setTimeout(r, 3000));

    // Wait for Authentik HTTPS before making API calls
    console.log('Waiting for Authentik HTTPS...');
    const authentikHttpsReady = await waitForHttps(
      `https://${AUTH_DOMAIN}:${AUTHENTIK_HTTPS_PORT}/-/health/ready/`,
      60000
    );
    if (!authentikHttpsReady) {
      const logs = execSync(`docker logs ${NGINX_CONTAINER} 2>&1`, { encoding: 'utf-8' });
      console.log('nginx logs:', logs);
      throw new Error('Authentik HTTPS not ready');
    }
    console.log('Authentik HTTPS is ready');

    // 3. Configure Authentik via API (now that HTTPS is available)
    const redirectUri = `https://${APP_DOMAIN}:${GRAFANA_HTTPS_PORT}/login/generic_oauth`;
    await configureAuthentikOAuth2(
      BOOTSTRAP_TOKEN,
      OIDC_CLIENT_ID,
      OIDC_CLIENT_SECRET,
      redirectUri
    );

    // Create test user directly in Authentik
    await createAuthentikUser(
      BOOTSTRAP_TOKEN,
      TEST_USER,
      TEST_EMAIL,
      TEST_PASSWORD
    );

    // Get nginx IP for Grafana host resolution
    const nginxIp = getContainerIp(NGINX_CONTAINER);

    // 5. Deploy Grafana with OIDC
    console.log('Deploying Grafana with OIDC...');
    try {
      execSync(`docker rm -f ${GRAFANA_CONTAINER}`, { encoding: 'utf-8', stdio: 'pipe' });
    } catch {}

    // Authentik OIDC endpoints
    const authUrl = `https://${AUTH_DOMAIN}:${AUTHENTIK_HTTPS_PORT}/application/o/authorize/`;
    const tokenUrl = `https://${AUTH_DOMAIN}:${AUTHENTIK_HTTPS_PORT}/application/o/token/`;
    const apiUrl = `https://${AUTH_DOMAIN}:${AUTHENTIK_HTTPS_PORT}/application/o/userinfo/`;

    execSync(
      `docker run -d --name ${GRAFANA_CONTAINER} ` +
        `--network ${AUTH_NETWORK} ` +
        `-e GF_SERVER_ROOT_URL=https://${APP_DOMAIN}:${GRAFANA_HTTPS_PORT}/ ` +
        `-e GF_AUTH_GENERIC_OAUTH_ENABLED=true ` +
        `-e GF_AUTH_GENERIC_OAUTH_NAME=Authentik ` +
        `-e GF_AUTH_GENERIC_OAUTH_CLIENT_ID=${OIDC_CLIENT_ID} ` +
        `-e GF_AUTH_GENERIC_OAUTH_CLIENT_SECRET=${OIDC_CLIENT_SECRET} ` +
        `-e "GF_AUTH_GENERIC_OAUTH_SCOPES=openid profile email" ` +
        `-e GF_AUTH_GENERIC_OAUTH_AUTH_URL=${authUrl} ` +
        `-e GF_AUTH_GENERIC_OAUTH_TOKEN_URL=${tokenUrl} ` +
        `-e GF_AUTH_GENERIC_OAUTH_API_URL=${apiUrl} ` +
        `-e GF_AUTH_GENERIC_OAUTH_TLS_SKIP_VERIFY_INSECURE=true ` +
        `-e GF_AUTH_GENERIC_OAUTH_ALLOW_SIGN_UP=true ` +
        `-e GF_AUTH_GENERIC_OAUTH_USE_PKCE=true ` +
        `-e GF_SERVER_HTTP_PORT=3000 ` +
        `--add-host=${AUTH_DOMAIN}:${nginxIp} ` +
        `grafana/grafana-oss:latest`,
      { encoding: 'utf-8' }
    );

    // Wait for Grafana
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

    // Wait for Grafana HTTPS
    console.log('Waiting for Grafana HTTPS...');
    const grafanaHttpsReady = await waitForHttps(
      `https://${APP_DOMAIN}:${GRAFANA_HTTPS_PORT}/api/health`,
      60000
    );
    if (!grafanaHttpsReady) {
      throw new Error('Grafana HTTPS not ready');
    }

    console.log('=== Setup complete ===');
    console.log(`Authentik: https://${AUTH_DOMAIN}:${AUTHENTIK_HTTPS_PORT}`);
    console.log(`Grafana: https://${APP_DOMAIN}:${GRAFANA_HTTPS_PORT}`);
  }, 600000); // 10 minute timeout

  test.afterAll(async () => {
    console.log('=== Cleaning up Authentik + Grafana OIDC test ===');
    for (const container of [NGINX_CONTAINER, GRAFANA_CONTAINER]) {
      try {
        execSync(`docker rm -f ${container}`, { encoding: 'utf-8', stdio: 'pipe' });
      } catch {}
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
    // ===== Test 1: Full OIDC browser login flow =====
    console.log('Test: Full OIDC browser login flow');

    await page.context().clearCookies();

    // Step 1: Navigate to Grafana login page
    console.log('Step 1: Navigating to Grafana login...');
    await page.goto(`https://${APP_DOMAIN}:${GRAFANA_HTTPS_PORT}/login`);

    // Step 2: Click "Sign in with Authentik" button
    console.log('Step 2: Looking for Authentik OAuth button...');
    const oauthLink = page.locator('a[href*="login/generic_oauth"]');
    await expect(oauthLink).toBeVisible({ timeout: 15000 });
    await page.screenshot({ path: 'test-results/authentik-grafana-login.png' }).catch(() => {});
    await oauthLink.click();

    // Step 3: Should be redirected to Authentik login page
    console.log('Step 3: Waiting for redirect to Authentik...');
    await page.waitForURL(new RegExp(AUTH_DOMAIN), { timeout: 30000 });
    await page.screenshot({ path: 'test-results/authentik-login-page.png' }).catch(() => {});

    // Authentik login form
    console.log('Step 4: Looking for Authentik login form...');
    const usernameInput = page.locator('input[name="uidField"], input[name="uid-field"], input[autocomplete="username"]').first();
    const passwordInput = page.locator('input[name="password"], input[type="password"]').first();

    await expect(usernameInput).toBeVisible({ timeout: 15000 });
    await expect(passwordInput).toBeVisible({ timeout: 15000 });

    // Step 4: Fill credentials
    console.log('Step 5: Filling credentials...');
    await usernameInput.fill(TEST_USER);
    await passwordInput.fill(TEST_PASSWORD);

    // Step 5: Submit
    console.log('Step 6: Submitting login form...');
    const submitButton = page.locator('button[type="submit"]').first();
    await submitButton.click();

    // Step 6: Wait for redirect or consent
    console.log('Step 7: Waiting for redirect or consent...');
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'test-results/authentik-after-login.png' }).catch(() => {});

    const currentUrl = page.url();
    console.log(`Current URL: ${currentUrl}`);

    // Check for consent screen
    if (currentUrl.includes(AUTH_DOMAIN)) {
      console.log('Still on Authentik - checking for consent...');
      const consentSelectors = [
        'button:has-text("Continue")',
        'button:has-text("Accept")',
        'button:has-text("Consent")',
        'button:has-text("Authorize")',
        'button:has-text("Allow")',
      ];
      for (const selector of consentSelectors) {
        try {
          const btn = page.locator(selector).first();
          if (await btn.isVisible({ timeout: 2000 })) {
            console.log(`Found consent button: ${selector}`);
            await btn.click();
            await page.waitForTimeout(2000);
            break;
          }
        } catch {}
      }
    }

    // Wait for redirect to Grafana
    console.log('Step 8: Waiting for redirect to Grafana...');
    await page.waitForURL(new RegExp(APP_DOMAIN), { timeout: 30000 });
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'test-results/authentik-grafana-logged-in.png' }).catch(() => {});

    // Step 7: Verify logged in
    console.log('Step 9: Verifying logged-in state...');
    const userResponse = await page.request.get(
      `https://${APP_DOMAIN}:${GRAFANA_HTTPS_PORT}/api/user`
    );

    if (userResponse.ok()) {
      const user = await userResponse.json();
      console.log('Logged in user:', JSON.stringify(user));
      // Grafana may set login to email or username
      expect(user.email || user.login).toMatch(new RegExp(`${TEST_USER}|${TEST_EMAIL}`, 'i'));
    } else {
      console.log('User API returned:', userResponse.status());
      // Check page content instead
      const pageContent = await page.content();
      expect(pageContent.toLowerCase()).not.toContain('login');
    }

    console.log('All Authentik + Grafana OIDC tests passed!');
  });
});
