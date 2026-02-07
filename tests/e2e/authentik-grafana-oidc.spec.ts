import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import {
  dokku,
  getContainerIp,
  waitForHealthy,
  waitForHttps,
} from './helpers';

/**
 * Authentik + Grafana OIDC E2E Test - Full Browser Flow
 *
 * Tests a complete OIDC-protected Grafana with Authentik as identity provider:
 * 1. Create LLDAP directory service
 * 2. Create Authentik frontend with bootstrap credentials
 * 3. Deploy nginx TLS proxy
 * 4. Configure Authentik with OAuth2 provider and application via API
 * 5. Create test user in Authentik
 * 6. Deploy Grafana with OIDC config pointing to Authentik
 * 7. Test full browser login flow through Grafana → Authentik → back to Grafana
 *
 * Requires:
 *   - /etc/hosts entries:
 *       127.0.0.1 authentik-grafana.test.local
 *       127.0.0.1 grafana-authentik.test.local
 */

const DIRECTORY_SERVICE = 'ak-graf-oidc-dir';
const FRONTEND_SERVICE = 'ak-graf-oidc-fe';
const GRAFANA_CONTAINER = 'grafana-authentik-oidc-test';
const NGINX_CONTAINER = 'nginx-authentik-grafana-proxy';

// Domain names (must be in /etc/hosts pointing to 127.0.0.1)
const AUTH_DOMAIN = 'authentik-grafana.test.local';
const APP_DOMAIN = 'grafana-authentik.test.local';

// HTTPS ports
const AUTHENTIK_HTTPS_PORT = 9443;
const GRAFANA_HTTPS_PORT = 9444;

// OIDC client settings
const OIDC_CLIENT_ID = 'grafana-oidc-test';
const OIDC_CLIENT_SECRET = 'grafana-oidc-secret-1234567890123456';

// Test user
const TEST_USER = 'grafanaoidcuser';
const TEST_PASSWORD = 'GrafanaOidc123!';
const TEST_EMAIL = 'grafanaoidc@test.local';

let AUTHENTIK_INTERNAL_IP: string;
let AUTH_NETWORK: string;
let AUTHENTIK_BOOTSTRAP_TOKEN: string;

// Generate self-signed certificates for TLS
function generateCerts(): void {
  const certDir = '/tmp/authentik-grafana-certs';
  if (fs.existsSync(`${certDir}/server.crt`)) {
    return;
  }
  fs.mkdirSync(certDir, { recursive: true });

  execSync(
    `openssl req -x509 -nodes -days 1 -newkey rsa:2048 ` +
      `-keyout ${certDir}/server.key -out ${certDir}/server.crt ` +
      `-subj "/CN=${AUTH_DOMAIN}" ` +
      `-addext "subjectAltName=DNS:${AUTH_DOMAIN},DNS:${APP_DOMAIN}"`,
    { encoding: 'utf-8' }
  );
}

/**
 * Execute a Python script inside the Authentik container to make API calls.
 * Authentik containers have Python but no curl/wget.
 */
function authentikApiRequest(
  containerName: string,
  method: string,
  path: string,
  token: string,
  body?: object
): string {
  // Convert to JSON and replace JavaScript values with Python equivalents
  const bodyJson = body
    ? JSON.stringify(body)
        .replace(/'/g, "\\'")
        .replace(/\bnull\b/g, 'None')
        .replace(/\btrue\b/g, 'True')
        .replace(/\bfalse\b/g, 'False')
    : 'None';
  const pythonScript = `
import urllib.request
import urllib.error
import json
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

url = 'http://localhost:9000${path}'
headers = {
    'Authorization': 'Bearer ${token}',
    'Content-Type': 'application/json',
}
data = ${bodyJson !== 'None' ? `json.dumps(${bodyJson}).encode('utf-8')` : 'None'}

req = urllib.request.Request(url, data=data, headers=headers, method='${method}')
try:
    with urllib.request.urlopen(req, context=ctx, timeout=30) as resp:
        result = resp.read().decode('utf-8')
        print(result if result else '{}')
except urllib.error.HTTPError as e:
    body = e.read().decode('utf-8') if e.fp else ''
    print(json.dumps({'error': str(e), 'status': e.code, 'body': body}))
except Exception as e:
    print(json.dumps({'error': str(e)}))
`;

  const result = execSync(
    `docker exec ${containerName} python3 -c '${pythonScript.replace(/'/g, "'\"'\"'")}'`,
    { encoding: 'utf-8', timeout: 60000 }
  );
  return result.trim();
}

/**
 * Create OAuth2 provider in Authentik via API
 */
function createOAuth2Provider(
  containerName: string,
  token: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): { providerId: number; providerName: string } {
  const providerName = `grafana-oidc-provider-${Date.now()}`;

  // First, get an authorization flow - we need its pk
  console.log('Getting authorization flows...');
  const flowsResult = authentikApiRequest(
    containerName,
    'GET',
    '/api/v3/flows/instances/?designation=authorization',
    token
  );
  const flows = JSON.parse(flowsResult);
  if (flows.error || !flows.results || flows.results.length === 0) {
    console.log('Flows result:', flowsResult);
    throw new Error('No authorization flow found');
  }
  const authorizationFlow = flows.results[0].pk;
  console.log(`Using authorization flow: ${authorizationFlow}`);

  // Get implicit consent flow (skips consent screen)
  console.log('Looking for implicit consent flow...');
  let implicitFlow = authorizationFlow; // fallback to explicit
  try {
    const implicitFlowsResult = authentikApiRequest(
      containerName,
      'GET',
      '/api/v3/flows/instances/?search=implicit-consent',
      token
    );
    const implicitFlows = JSON.parse(implicitFlowsResult);
    if (implicitFlows.results && implicitFlows.results.length > 0) {
      implicitFlow = implicitFlows.results[0].pk;
      console.log(`Using implicit consent flow: ${implicitFlow}`);
    } else {
      console.log('No implicit consent flow found, using default');
    }
  } catch (e) {
    console.log('Could not find implicit flow, using default');
  }

  // Create OAuth2 provider
  console.log('Creating OAuth2 provider...');
  const providerResult = authentikApiRequest(
    containerName,
    'POST',
    '/api/v3/providers/oauth2/',
    token,
    {
      name: providerName,
      authorization_flow: implicitFlow,
      client_type: 'confidential',
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uris: redirectUri,
      signing_key: null,
      access_token_validity: 'minutes=10',
      refresh_token_validity: 'days=30',
      sub_mode: 'user_username',
      include_claims_in_id_token: true,
      issuer_mode: 'per_provider',
    }
  );

  const provider = JSON.parse(providerResult);
  if (provider.error) {
    console.log('Provider result:', providerResult);
    throw new Error(`Failed to create OAuth2 provider: ${provider.error}`);
  }
  console.log(`Created OAuth2 provider: ${provider.pk}`);
  return { providerId: provider.pk, providerName };
}

/**
 * Create application in Authentik that uses the OAuth2 provider
 */
function createApplication(
  containerName: string,
  token: string,
  providerId: number,
  slug: string
): void {
  console.log('Creating application...');
  const appResult = authentikApiRequest(
    containerName,
    'POST',
    '/api/v3/core/applications/',
    token,
    {
      name: `Grafana OIDC Test ${Date.now()}`,
      slug: slug,
      provider: providerId,
      meta_launch_url: `https://${APP_DOMAIN}:${GRAFANA_HTTPS_PORT}/`,
      open_in_new_tab: false,
    }
  );

  const app = JSON.parse(appResult);
  if (app.error) {
    console.log('Application result:', appResult);
    throw new Error(`Failed to create application: ${app.error}`);
  }
  console.log(`Created application: ${app.slug}`);
}

/**
 * Create a user in Authentik via API
 */
function createAuthentikUser(
  containerName: string,
  token: string,
  username: string,
  email: string,
  password: string
): void {
  console.log(`Creating user ${username}...`);

  // Create user
  const userResult = authentikApiRequest(
    containerName,
    'POST',
    '/api/v3/core/users/',
    token,
    {
      username: username,
      name: username,
      email: email,
      is_active: true,
      path: 'users',
    }
  );

  const user = JSON.parse(userResult);
  if (user.error && !user.body?.includes('already exists')) {
    console.log('User result:', userResult);
    throw new Error(`Failed to create user: ${user.error}`);
  }

  const userId = user.pk;
  if (!userId) {
    // User might already exist, try to find it
    console.log('User may already exist, searching...');
    const searchResult = authentikApiRequest(
      containerName,
      'GET',
      `/api/v3/core/users/?username=${username}`,
      token
    );
    const search = JSON.parse(searchResult);
    if (search.results && search.results.length > 0) {
      console.log(`Found existing user: ${search.results[0].pk}`);
      // Set password for existing user
      setAuthentikUserPassword(containerName, token, search.results[0].pk, password);
      return;
    }
    throw new Error('Could not create or find user');
  }

  console.log(`Created user with ID: ${userId}`);

  // Set password
  setAuthentikUserPassword(containerName, token, userId, password);
}

function setAuthentikUserPassword(
  containerName: string,
  token: string,
  userId: number,
  password: string
): void {
  console.log(`Setting password for user ${userId}...`);
  const pwResult = authentikApiRequest(
    containerName,
    'POST',
    `/api/v3/core/users/${userId}/set_password/`,
    token,
    { password: password }
  );

  const pw = JSON.parse(pwResult);
  if (pw.error) {
    console.log('Password result:', pwResult);
    throw new Error(`Failed to set password: ${pw.error}`);
  }
  console.log('Password set successfully');
}

test.describe('Authentik + Grafana OIDC Browser Flow', () => {
  test.setTimeout(600000); // 10 minute timeout for the whole suite

  test.beforeAll(async () => {
    console.log('=== Setting up Authentik + Grafana OIDC test ===');

    // Generate TLS certificates
    console.log('Generating self-signed certificates...');
    generateCerts();
    console.log('Certificates generated');

    // 1. Create LLDAP directory service
    console.log('Creating LLDAP directory service...');
    try {
      dokku(`auth:create ${DIRECTORY_SERVICE}`);
    } catch (e: any) {
      if (!e.stderr?.includes('already exists')) {
        throw e;
      }
    }

    const dirHealthy = await waitForHealthy(DIRECTORY_SERVICE, 'directory');
    if (!dirHealthy) {
      throw new Error('Directory service not healthy');
    }

    // Get auth network
    AUTH_NETWORK = execSync(
      `docker inspect dokku.auth.directory.${DIRECTORY_SERVICE} --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}'`,
      { encoding: 'utf-8' }
    )
      .trim()
      .split('\n')[0];
    console.log(`Auth network: ${AUTH_NETWORK}`);

    // 2. Create Authentik frontend service
    console.log('Creating Authentik frontend service...');

    // Force cleanup of any leftover service from previous runs
    const serviceDir = `/var/lib/dokku/services/auth/frontend/${FRONTEND_SERVICE}`;
    try {
      dokku(`auth:frontend:destroy ${FRONTEND_SERVICE} -f`, { quiet: true, swallowErrors: true });
    } catch {}
    try {
      execSync(`sudo rm -rf ${serviceDir}`, { encoding: 'utf-8', stdio: 'pipe' });
    } catch {}
    for (const suffix of ['', '.worker', '.postgres', '.redis']) {
      try {
        execSync(`docker rm -f dokku.auth.frontend.${FRONTEND_SERVICE}${suffix}`, {
          encoding: 'utf-8',
          stdio: 'pipe',
        });
      } catch {}
    }

    dokku(`auth:frontend:create ${FRONTEND_SERVICE} --provider authentik`);

    // Wait for Authentik to be healthy
    console.log('Waiting for Authentik to be ready...');
    const healthy = await waitForHealthy(FRONTEND_SERVICE, 'frontend', 180000);
    if (!healthy) {
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

    // Get bootstrap token from service directory
    try {
      AUTHENTIK_BOOTSTRAP_TOKEN = execSync(
        `sudo cat ${serviceDir}/BOOTSTRAP_TOKEN`,
        { encoding: 'utf-8' }
      ).trim();
      console.log('Got bootstrap token');
    } catch (e) {
      console.log('Could not read bootstrap token, trying environment variable...');
      // Try to get from container environment
      AUTHENTIK_BOOTSTRAP_TOKEN = execSync(
        `docker inspect ${authentikContainerName} --format '{{range .Config.Env}}{{println .}}{{end}}' | grep AUTHENTIK_BOOTSTRAP_TOKEN | cut -d= -f2`,
        { encoding: 'utf-8' }
      ).trim();
    }

    // 3. Deploy nginx TLS proxy
    console.log('Deploying nginx TLS proxy...');
    try {
      execSync(`docker rm -f ${NGINX_CONTAINER}`, { encoding: 'utf-8', stdio: 'pipe' });
    } catch {}

    // Create nginx config
    // IMPORTANT: nginx must listen on the same ports that are mapped to the host (9443, 9444)
    // so that containers inside the network can reach it on the same ports as the host.
    // Otherwise Grafana's token exchange would fail because it tries to connect to 9443
    // but nginx would only be listening on 443.
    const nginxConfig = `
events { worker_connections 1024; }
http {
    resolver 127.0.0.11 valid=10s;

    # Authentik HTTPS - listen on both 443 (for port mapping) and 9443 (for internal containers)
    server {
        listen 443 ssl;
        listen ${AUTHENTIK_HTTPS_PORT} ssl;
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
    # Grafana HTTPS - listen on both 3443 (for port mapping) and 9444 (for internal containers)
    server {
        listen 3443 ssl;
        listen ${GRAFANA_HTTPS_PORT} ssl;
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
        `-p ${AUTHENTIK_HTTPS_PORT}:${AUTHENTIK_HTTPS_PORT} ` +
        `-p ${GRAFANA_HTTPS_PORT}:${GRAFANA_HTTPS_PORT} ` +
        `-v /tmp/authentik-grafana-nginx.conf:/etc/nginx/nginx.conf:ro ` +
        `-v /tmp/authentik-grafana-certs:/etc/nginx/certs:ro ` +
        `nginx:alpine`,
      { encoding: 'utf-8' }
    );

    await new Promise((r) => setTimeout(r, 3000));

    // Wait for Authentik HTTPS
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

    // 4. Wait for Authentik flows to be created (they're created asynchronously)
    console.log('Waiting for Authentik flows to be available...');
    let flowsReady = false;
    for (let i = 0; i < 60; i++) {
      try {
        const flowsResult = authentikApiRequest(
          authentikContainerName,
          'GET',
          '/api/v3/flows/instances/?designation=authorization',
          AUTHENTIK_BOOTSTRAP_TOKEN
        );
        const flows = JSON.parse(flowsResult);
        if (flows.results && flows.results.length > 0) {
          flowsReady = true;
          console.log(`Found ${flows.results.length} authorization flows`);
          break;
        }
        console.log('No authorization flows yet, waiting...');
      } catch (e) {
        console.log('Error checking flows:', e);
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (!flowsReady) {
      throw new Error('Authentik flows not ready after waiting');
    }

    // Configure Authentik with OAuth2 provider and application
    console.log('Configuring Authentik OAuth2...');
    const appSlug = `grafana-oidc-${Date.now()}`;
    const redirectUri = `https://${APP_DOMAIN}:${GRAFANA_HTTPS_PORT}/login/generic_oauth`;

    const { providerId } = createOAuth2Provider(
      authentikContainerName,
      AUTHENTIK_BOOTSTRAP_TOKEN,
      OIDC_CLIENT_ID,
      OIDC_CLIENT_SECRET,
      redirectUri
    );

    createApplication(
      authentikContainerName,
      AUTHENTIK_BOOTSTRAP_TOKEN,
      providerId,
      appSlug
    );

    // 5. Create test user in Authentik
    console.log('Creating test user in Authentik...');
    createAuthentikUser(
      authentikContainerName,
      AUTHENTIK_BOOTSTRAP_TOKEN,
      TEST_USER,
      TEST_EMAIL,
      TEST_PASSWORD
    );

    // Get nginx IP for Grafana host resolution
    const nginxIp = getContainerIp(NGINX_CONTAINER);

    // 6. Deploy Grafana with OIDC
    console.log('Deploying Grafana with OIDC...');
    try {
      execSync(`docker rm -f ${GRAFANA_CONTAINER}`, { encoding: 'utf-8', stdio: 'pipe' });
    } catch {}

    // Grafana OIDC config pointing to Authentik
    // Note: Authentik's OIDC endpoints are at /application/o/<provider-slug>/
    const grafanaEnv = [
      `GF_SERVER_ROOT_URL=https://${APP_DOMAIN}:${GRAFANA_HTTPS_PORT}/`,
      'GF_AUTH_GENERIC_OAUTH_ENABLED=true',
      'GF_AUTH_GENERIC_OAUTH_NAME=Authentik',
      `GF_AUTH_GENERIC_OAUTH_CLIENT_ID=${OIDC_CLIENT_ID}`,
      `GF_AUTH_GENERIC_OAUTH_CLIENT_SECRET=${OIDC_CLIENT_SECRET}`,
      'GF_AUTH_GENERIC_OAUTH_SCOPES=openid profile email',
      `GF_AUTH_GENERIC_OAUTH_AUTH_URL=https://${AUTH_DOMAIN}:${AUTHENTIK_HTTPS_PORT}/application/o/authorize/`,
      `GF_AUTH_GENERIC_OAUTH_TOKEN_URL=https://${AUTH_DOMAIN}:${AUTHENTIK_HTTPS_PORT}/application/o/token/`,
      `GF_AUTH_GENERIC_OAUTH_API_URL=https://${AUTH_DOMAIN}:${AUTHENTIK_HTTPS_PORT}/application/o/userinfo/`,
      'GF_AUTH_GENERIC_OAUTH_TLS_SKIP_VERIFY_INSECURE=true',
      'GF_AUTH_GENERIC_OAUTH_ALLOW_SIGN_UP=true',
      'GF_AUTH_ANONYMOUS_ENABLED=false',
    ];

    const envArgs = grafanaEnv.map((e) => `-e "${e}"`).join(' ');

    execSync(
      `docker run -d --name ${GRAFANA_CONTAINER} ` +
        `--network ${AUTH_NETWORK} ` +
        `--add-host=${AUTH_DOMAIN}:${nginxIp} ` +
        `${envArgs} ` +
        `grafana/grafana-oss:latest`,
      { encoding: 'utf-8', shell: '/bin/bash' }
    );

    // Wait for Grafana
    console.log('Waiting for Grafana to be ready...');
    let grafanaReady = false;
    for (let i = 0; i < 30; i++) {
      try {
        const result = execSync(
          `docker exec ${GRAFANA_CONTAINER} curl -sf http://localhost:3000/api/health`,
          { encoding: 'utf-8', timeout: 5000 }
        );
        if (result.includes('ok')) {
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

    console.log('=== Setup complete ===');
  });

  test.afterAll(async () => {
    console.log('=== Cleaning up Authentik + Grafana OIDC test ===');
    try {
      execSync(`docker rm -f ${GRAFANA_CONTAINER}`, { encoding: 'utf-8', stdio: 'pipe' });
    } catch {}
    try {
      execSync(`docker rm -f ${NGINX_CONTAINER}`, { encoding: 'utf-8', stdio: 'pipe' });
    } catch {}
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

  test('Full OIDC browser login flow works end-to-end', async ({ page }) => {
    // This single test covers the full OIDC browser flow to avoid
    // issues with Playwright's retry mechanism running afterAll between retries

    // ===== Test 1: Authentik health endpoint responds =====
    console.log('Test 1: Verifying Authentik is accessible...');
    const healthResponse = await page.request.get(
      `https://${AUTH_DOMAIN}:${AUTHENTIK_HTTPS_PORT}/-/health/ready/`,
      { ignoreHTTPSErrors: true }
    );
    expect(healthResponse.ok()).toBe(true);

    // ===== Test 2: Grafana health endpoint responds =====
    console.log('Test 2: Verifying Grafana is accessible...');
    const grafanaHealth = await page.request.get(
      `https://${APP_DOMAIN}:${GRAFANA_HTTPS_PORT}/api/health`,
      { ignoreHTTPSErrors: true }
    );
    expect(grafanaHealth.ok()).toBe(true);
    const grafanaHealthJson = await grafanaHealth.json();
    expect(grafanaHealthJson.database).toBe('ok');

    // ===== Test 3: Grafana login page shows OIDC option =====
    console.log('Test 3: Verifying Grafana login page shows OIDC option...');
    await page.goto(`https://${APP_DOMAIN}:${GRAFANA_HTTPS_PORT}/login`);
    await page.waitForLoadState('domcontentloaded');

    // Check that OAuth login option is shown (the "Sign in with Authentik" button)
    const oauthButton = page.locator('a[href*="login/generic_oauth"]');
    await expect(oauthButton).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: 'test-results/grafana-login-page.png' }).catch(() => {});

    // ===== Test 4: Full OIDC browser login flow =====
    console.log('Test 4: Starting full OIDC login flow...');

    // Clear cookies and start fresh
    await page.context().clearCookies();

    // Step 1: Navigate to Grafana login and click OIDC button
    console.log('Step 4.1: Navigating to Grafana login...');
    await page.goto(`https://${APP_DOMAIN}:${GRAFANA_HTTPS_PORT}/login`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000); // Give page a moment to render

    // Click "Sign in with Authentik"
    console.log('Step 4.2: Clicking OIDC login button...');
    const oidcButton = page.locator('a[href*="login/generic_oauth"]');
    await oidcButton.click();

    // Step 2: Should be redirected to Authentik login page
    console.log('Step 4.3: Waiting for redirect to Authentik...');
    await page.waitForURL((url) => url.hostname.includes('authentik') || url.hostname === AUTH_DOMAIN, {
      timeout: 30000,
    });

    await page.screenshot({ path: 'test-results/authentik-login-page.png' }).catch(() => {});

    // Verify we're on the Authentik login page
    console.log('Step 4.4: Verifying Authentik login page...');
    // Authentik uses ak-flow-executor for login, look for username input
    const usernameInput = page.locator('input[name="uidField"], input[name="username"], input[id="id_uid_field"]').first();
    await expect(usernameInput).toBeVisible({ timeout: 15000 });

    // Step 3: Fill in credentials
    console.log('Step 4.5: Filling in credentials...');
    await usernameInput.fill(TEST_USER);

    // Authentik may have a two-step login (username first, then password)
    // or single-page login. Let's handle both.
    const submitButton = page.locator('button[type="submit"]').first();
    await submitButton.click();

    // Wait for password field (either already visible or appears after username submit)
    await page.waitForTimeout(1000);
    const passwordInput = page.locator('input[name="password"], input[type="password"]').first();
    await expect(passwordInput).toBeVisible({ timeout: 10000 });
    await passwordInput.fill(TEST_PASSWORD);

    // Step 4: Submit the login form
    console.log('Step 4.6: Submitting login form...');
    await page.screenshot({ path: 'test-results/authentik-filled-form.png' }).catch(() => {});
    const loginSubmit = page.locator('button[type="submit"]').first();
    await loginSubmit.click();

    // Step 5: Handle consent screen if shown
    console.log('Step 4.7: Handling consent screen if shown...');
    await page.waitForTimeout(2000);
    const currentUrl = page.url();
    console.log(`Current URL after login: ${currentUrl}`);
    await page.screenshot({ path: 'test-results/authentik-after-login.png' }).catch(() => {});

    // If still on Authentik (consent screen), handle it
    if (currentUrl.includes(AUTH_DOMAIN) || currentUrl.includes('authentik') || currentUrl.includes('consent')) {
      console.log('Still on Authentik - handling consent screen...');
      await page.screenshot({ path: 'test-results/authentik-consent-screen.png' }).catch(() => {});

      // Log what's on the page - look for consent-related elements
      const pageContent = await page.content();
      console.log('Consent page content preview:', pageContent.substring(0, 3000));

      // Check if this is actually a consent page by looking for consent-related content
      const isConsentPage =
        pageContent.includes('consent') ||
        pageContent.includes('authorize') ||
        pageContent.includes('permission') ||
        pageContent.includes('Allow') ||
        pageContent.includes('ak-stage-consent');
      console.log(`Is consent page: ${isConsentPage}`);

      // Wait for form to be ready
      await page.waitForTimeout(2000);

      // Get all visible buttons
      const allButtons = await page.locator('button').all();
      console.log(`Found ${allButtons.length} buttons on page`);
      for (let i = 0; i < allButtons.length; i++) {
        try {
          const text = await allButtons[i].textContent();
          const visible = await allButtons[i].isVisible();
          console.log(`Button ${i}: "${text?.trim()}" visible=${visible}`);
        } catch {}
      }

      // Try to find and click the consent button
      // Authentik uses web components, so we need to handle shadow DOM
      const urlBefore = page.url();
      let clicked = false;

      // First, try using JavaScript to find and click the submit button
      // This works better with shadow DOM components
      try {
        console.log('Trying JavaScript click on submit button...');
        clicked = await page.evaluate(() => {
          // Try finding the button in the regular DOM first
          let btn = document.querySelector('button[type="submit"]') as HTMLButtonElement;
          if (btn) {
            btn.click();
            return true;
          }

          // Try finding in shadow roots (Authentik uses web components)
          const akStage = document.querySelector('ak-stage-consent');
          if (akStage && akStage.shadowRoot) {
            btn = akStage.shadowRoot.querySelector('button[type="submit"]') as HTMLButtonElement;
            if (btn) {
              btn.click();
              return true;
            }
          }

          // Try finding any visible submit button
          const buttons = document.querySelectorAll('button');
          for (const b of buttons) {
            if (b.textContent?.toLowerCase().includes('continue') ||
                b.textContent?.toLowerCase().includes('allow') ||
                b.type === 'submit') {
              (b as HTMLButtonElement).click();
              return true;
            }
          }
          return false;
        });
        console.log(`JavaScript click result: ${clicked}`);
      } catch (e: any) {
        console.log('JavaScript click error:', e.message);
      }

      // If JavaScript click didn't work, try Playwright click
      if (!clicked) {
        const consentSelectors = [
          'button[type="submit"]',
          '.pf-c-button.pf-m-primary',
          'button:has-text("Continue")',
          'button:has-text("Allow")',
        ];

        for (const selector of consentSelectors) {
          try {
            const btn = page.locator(selector).first();
            if (await btn.isVisible({ timeout: 2000 })) {
              console.log(`Clicking consent button: ${selector}`);
              await btn.click({ force: true });
              clicked = true;
              break;
            }
          } catch (e: any) {
            console.log(`Selector ${selector} error: ${e.message}`);
          }
        }
      }

      // Wait for navigation or URL change
      if (clicked) {
        try {
          await page.waitForURL((url) => !url.href.includes('consent'), { timeout: 15000 });
          console.log('URL changed after consent click');
        } catch {
          console.log('URL did not change after consent click');
        }
      }

      if (!clicked) {
        console.log('Could not click consent button, trying keyboard submit...');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(3000);
      }

      console.log('URL after consent handling:', page.url());
      await page.screenshot({ path: 'test-results/authentik-after-consent.png' }).catch(() => {});
    }

    // Step 6: Wait for redirect back to Grafana
    console.log('Step 4.8: Waiting for redirect back to Grafana...');
    await page.waitForURL((url) => url.hostname === APP_DOMAIN || url.hostname.includes('grafana'), {
      timeout: 30000,
    });

    // Step 7: Verify we're logged in to Grafana
    console.log('Step 4.9: Verifying Grafana shows logged-in user...');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000); // Give Grafana time to process the OAuth callback
    await page.screenshot({ path: 'test-results/grafana-logged-in.png' }).catch(() => {});

    // Check we're not on the login page anymore
    const finalUrl = page.url();
    console.log(`Final URL: ${finalUrl}`);
    expect(finalUrl).not.toContain('/login');

    // Verify we can access the user API endpoint (proves we're authenticated)
    const userResponse = await page.request.get(
      `https://${APP_DOMAIN}:${GRAFANA_HTTPS_PORT}/api/user`,
      { ignoreHTTPSErrors: true }
    );
    console.log(`User API response status: ${userResponse.status()}`);
    const userText = await userResponse.text();
    console.log(`User API response body: ${userText}`);

    if (!userResponse.ok()) {
      // Take a screenshot for debugging
      await page.screenshot({ path: 'test-results/grafana-user-api-failed.png' }).catch(() => {});
      console.log('Current URL when API failed:', page.url());
    }

    expect(userResponse.ok()).toBe(true);
    const userJson = JSON.parse(userText);
    console.log('Logged in user:', userJson);
    expect(userJson.login).toBe(TEST_USER);

    console.log('All OIDC browser flow tests passed!');
  });
});
