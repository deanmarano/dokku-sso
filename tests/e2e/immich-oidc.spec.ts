import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import {
  dokku,
  getContainerIp,
  getLdapCredentials,
  createLdapUser,
  waitForHealthy,
  waitForHttps,
} from './helpers';

/**
 * Immich OIDC Integration E2E Test
 *
 * Tests Immich photo management with OIDC authentication via Authelia:
 * 1. Create LLDAP directory service
 * 2. Create Authelia frontend with OIDC enabled
 * 3. Deploy Immich with PostgreSQL and Redis
 * 4. Configure OIDC via environment variables
 * 5. Test browser-based OIDC login flow
 *
 * Note: Immich does not support LDAP, only OIDC.
 *
 * Requires /etc/hosts entries:
 *   127.0.0.1 immich-auth.test.local
 *   127.0.0.1 immich-app.test.local
 */

const DIRECTORY_SERVICE = 'immich-oidc-dir';
const FRONTEND_SERVICE = 'immich-oidc-fe';
const IMMICH_CONTAINER = 'immich-server-test';
const IMMICH_POSTGRES = 'immich-postgres-test';
const IMMICH_REDIS = 'immich-redis-test';
const NGINX_CONTAINER = 'nginx-immich-proxy';

// Domain names (must be in /etc/hosts pointing to 127.0.0.1)
const AUTH_DOMAIN = 'immich-auth.test.local';
const APP_DOMAIN = 'immich-app.test.local';

// HTTPS ports
const AUTHELIA_HTTPS_PORT = 9543;
const IMMICH_HTTPS_PORT = 9544;

// OIDC client settings
const OIDC_CLIENT_ID = 'immich-oidc-test';
const OIDC_CLIENT_SECRET = 'immich-oidc-secret-1234567890123456';

// Test user
const TEST_USER = 'immichuser';
const TEST_PASSWORD = 'ImmichPass123!';
const TEST_EMAIL = 'immichuser@test.local';

let AUTHELIA_INTERNAL_IP: string;
let AUTH_NETWORK: string;
let ADMIN_PASSWORD: string;

// Generate self-signed certificates
function generateCerts(): void {
  const certDir = '/tmp/immich-certs';
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

test.describe('Immich OIDC Integration', () => {
  test.setTimeout(600000); // 10 minute timeout

  test.beforeAll(async () => {
    console.log('=== Setting up Immich OIDC test ===');

    // Generate TLS certificates
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

    const dirHealthy = await waitForHealthy(DIRECTORY_SERVICE, 'directory');
    if (!dirHealthy) {
      throw new Error('Directory service not healthy');
    }

    // Get credentials and network
    const creds = getLdapCredentials(DIRECTORY_SERVICE);
    ADMIN_PASSWORD = creds.ADMIN_PASSWORD;

    AUTH_NETWORK = execSync(
      `docker inspect dokku.auth.directory.${DIRECTORY_SERVICE} --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}'`,
      { encoding: 'utf-8' }
    )
      .trim()
      .split('\n')[0];
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

    // Configure Authelia domain
    dokku(`auth:frontend:config ${FRONTEND_SERVICE} DOMAIN=${AUTH_DOMAIN}`);

    // Link to directory
    try {
      dokku(`auth:frontend:use-directory ${FRONTEND_SERVICE} ${DIRECTORY_SERVICE}`);
    } catch {}

    // Enable OIDC and add client
    dokku(`auth:oidc:enable ${FRONTEND_SERVICE}`);

    // Immich uses multiple redirect URIs
    const redirectUri = `https://${APP_DOMAIN}:${IMMICH_HTTPS_PORT}/auth/login,https://${APP_DOMAIN}:${IMMICH_HTTPS_PORT}/user-settings`;
    try {
      dokku(`auth:oidc:add-client ${FRONTEND_SERVICE} ${OIDC_CLIENT_ID} ${OIDC_CLIENT_SECRET} "${redirectUri}"`);
    } catch (e: any) {
      if (!e.stderr?.includes('already exists')) {
        throw e;
      }
    }

    // Apply configuration
    try {
      dokku(`auth:frontend:apply ${FRONTEND_SERVICE}`);
    } catch {}

    // Wait for Authelia
    console.log('Waiting for Authelia to be ready...');
    await new Promise((r) => setTimeout(r, 5000));
    const autheliaHealthy = await waitForHealthy(FRONTEND_SERVICE, 'frontend', 120000);
    if (!autheliaHealthy) {
      throw new Error('Authelia not healthy');
    }

    AUTHELIA_INTERNAL_IP = getContainerIp(`dokku.auth.frontend.${FRONTEND_SERVICE}`);
    console.log(`Authelia IP: ${AUTHELIA_INTERNAL_IP}`);

    // 3. Create test user in LLDAP
    console.log('Creating test user...');
    createLdapUser(
      `dokku.auth.directory.${DIRECTORY_SERVICE}`,
      ADMIN_PASSWORD,
      TEST_USER,
      TEST_EMAIL,
      TEST_PASSWORD
    );

    // 4. Deploy Immich dependencies (PostgreSQL, Redis)
    console.log('Deploying Immich dependencies...');

    // Cleanup old containers
    for (const container of [IMMICH_CONTAINER, IMMICH_POSTGRES, IMMICH_REDIS, NGINX_CONTAINER]) {
      try {
        execSync(`docker rm -f ${container}`, { encoding: 'utf-8', stdio: 'pipe' });
      } catch {}
    }

    // PostgreSQL for Immich
    execSync(
      `docker run -d --name ${IMMICH_POSTGRES} ` +
        `--network ${AUTH_NETWORK} ` +
        `-e POSTGRES_USER=immich ` +
        `-e POSTGRES_PASSWORD=immich ` +
        `-e POSTGRES_DB=immich ` +
        `postgres:15-alpine`,
      { encoding: 'utf-8' }
    );

    // Redis for Immich
    execSync(
      `docker run -d --name ${IMMICH_REDIS} ` +
        `--network ${AUTH_NETWORK} ` +
        `redis:alpine`,
      { encoding: 'utf-8' }
    );

    // Wait for PostgreSQL to be ready
    console.log('Waiting for PostgreSQL...');
    for (let i = 0; i < 30; i++) {
      try {
        execSync(`docker exec ${IMMICH_POSTGRES} pg_isready -U immich`, {
          encoding: 'utf-8',
          stdio: 'pipe',
        });
        break;
      } catch {}
      await new Promise((r) => setTimeout(r, 2000));
    }

    // 5. Deploy nginx TLS proxy
    console.log('Deploying nginx proxy...');
    const nginxConfig = `
events { worker_connections 1024; }
http {
    resolver 127.0.0.11 valid=10s;
    client_max_body_size 50000M;

    # Authelia
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
    # Immich
    server {
        listen 3443 ssl;
        server_name ${APP_DOMAIN};
        ssl_certificate /etc/nginx/certs/server.crt;
        ssl_certificate_key /etc/nginx/certs/server.key;
        location / {
            set $immich "http://${IMMICH_CONTAINER}:3001";
            proxy_pass $immich;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
        }
    }
}`;
    fs.writeFileSync('/tmp/immich-nginx.conf', nginxConfig);

    const nginxIp = execSync(
      `docker run -d --name ${NGINX_CONTAINER} ` +
        `--network ${AUTH_NETWORK} ` +
        `-p ${AUTHELIA_HTTPS_PORT}:443 ` +
        `-p ${IMMICH_HTTPS_PORT}:3443 ` +
        `-v /tmp/immich-nginx.conf:/etc/nginx/nginx.conf:ro ` +
        `-v /tmp/immich-certs:/etc/nginx/certs:ro ` +
        `nginx:alpine && ` +
        `sleep 2 && ` +
        `docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${NGINX_CONTAINER}`,
      { encoding: 'utf-8' }
    ).trim().split('\n').pop();

    // Wait for Authelia HTTPS
    console.log('Waiting for Authelia HTTPS...');
    const autheliaReady = await waitForHttps(
      `https://${AUTH_DOMAIN}:${AUTHELIA_HTTPS_PORT}/api/health`,
      60000
    );
    if (!autheliaReady) {
      throw new Error('Authelia HTTPS not ready');
    }

    // 6. Deploy Immich server
    console.log('Deploying Immich server...');

    // Immich OIDC environment variables
    execSync(
      `docker run -d --name ${IMMICH_CONTAINER} ` +
        `--network ${AUTH_NETWORK} ` +
        `--add-host=${AUTH_DOMAIN}:${nginxIp} ` +
        `-e DB_HOSTNAME=${IMMICH_POSTGRES} ` +
        `-e DB_USERNAME=immich ` +
        `-e DB_PASSWORD=immich ` +
        `-e DB_DATABASE_NAME=immich ` +
        `-e REDIS_HOSTNAME=${IMMICH_REDIS} ` +
        `-e IMMICH_SERVER_URL=https://${APP_DOMAIN}:${IMMICH_HTTPS_PORT} ` +
        `-e OAUTH_ENABLED=true ` +
        `-e OAUTH_ISSUER_URL=https://${AUTH_DOMAIN}:${AUTHELIA_HTTPS_PORT} ` +
        `-e OAUTH_CLIENT_ID=${OIDC_CLIENT_ID} ` +
        `-e OAUTH_CLIENT_SECRET=${OIDC_CLIENT_SECRET} ` +
        `-e OAUTH_SCOPE="openid profile email" ` +
        `-e OAUTH_AUTO_REGISTER=true ` +
        `-e OAUTH_BUTTON_TEXT="Login with Authelia" ` +
        `-e NODE_TLS_REJECT_UNAUTHORIZED=0 ` +
        `ghcr.io/immich-app/immich-server:release`,
      { encoding: 'utf-8' }
    );

    // Wait for Immich to be ready
    console.log('Waiting for Immich to be ready...');
    let immichReady = false;
    for (let i = 0; i < 60; i++) {
      try {
        const result = execSync(
          `docker exec ${IMMICH_CONTAINER} curl -sf http://localhost:3001/api/server-info/ping`,
          { encoding: 'utf-8', timeout: 5000 }
        );
        if (result.includes('pong')) {
          immichReady = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (!immichReady) {
      const logs = execSync(`docker logs ${IMMICH_CONTAINER} 2>&1 | tail -50`, {
        encoding: 'utf-8',
      });
      console.log('Immich logs:', logs);
      throw new Error('Immich not ready');
    }
    console.log('Immich is ready');

    console.log('=== Setup complete ===');
  });

  test.afterAll(async () => {
    console.log('=== Cleaning up Immich OIDC test ===');
    for (const container of [IMMICH_CONTAINER, IMMICH_POSTGRES, IMMICH_REDIS, NGINX_CONTAINER]) {
      try {
        execSync(`docker rm -f ${container}`, { encoding: 'utf-8', stdio: 'pipe' });
      } catch {}
    }
    try {
      dokku(`auth:frontend:destroy ${FRONTEND_SERVICE} -f`, { quiet: true });
    } catch {}
    try {
      dokku(`auth:destroy ${DIRECTORY_SERVICE} -f`, { quiet: true });
    } catch {}
  });

  test('Immich API ping responds', async () => {
    const result = execSync(
      `docker exec ${IMMICH_CONTAINER} curl -sf http://localhost:3001/api/server-info/ping`,
      { encoding: 'utf-8' }
    );
    expect(result).toContain('pong');
  });

  test('Immich server info is accessible', async () => {
    const result = execSync(
      `docker exec ${IMMICH_CONTAINER} curl -sf http://localhost:3001/api/server-info/version`,
      { encoding: 'utf-8' }
    );
    const info = JSON.parse(result);
    expect(info).toHaveProperty('major');
    expect(info).toHaveProperty('minor');
    console.log('Immich version:', `${info.major}.${info.minor}.${info.patch}`);
  });

  test('Full OIDC browser login flow', async ({ page }) => {
    // Navigate to Immich
    console.log('Navigating to Immich...');
    await page.goto(`https://${APP_DOMAIN}:${IMMICH_HTTPS_PORT}`);
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'test-results/immich-home.png' }).catch(() => {});

    // Look for OAuth login button
    console.log('Looking for OAuth login button...');
    const oauthButton = page.locator('button:has-text("Login with Authelia"), a:has-text("Login with Authelia")');

    // Immich might show a "Getting Started" page first - handle that
    const getStartedButton = page.locator('button:has-text("Getting Started")');
    if (await getStartedButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await getStartedButton.click();
      await page.waitForLoadState('networkidle');
    }

    await expect(oauthButton).toBeVisible({ timeout: 15000 });
    await page.screenshot({ path: 'test-results/immich-login.png' }).catch(() => {});

    // Click OAuth login
    console.log('Clicking OAuth login...');
    await oauthButton.click();

    // Wait for redirect to Authelia
    console.log('Waiting for Authelia redirect...');
    await page.waitForURL((url) => url.hostname === AUTH_DOMAIN, { timeout: 30000 });
    await page.screenshot({ path: 'test-results/authelia-login.png' }).catch(() => {});

    // Fill credentials
    console.log('Filling credentials...');
    const usernameInput = page.locator('input[name="username"], input[id="username-textfield"]').first();
    const passwordInput = page.locator('input[name="password"], input[id="password-textfield"]').first();

    await expect(usernameInput).toBeVisible({ timeout: 10000 });
    await usernameInput.fill(TEST_USER);
    await passwordInput.fill(TEST_PASSWORD);

    // Submit
    const submitButton = page.locator('button[type="submit"]').first();
    await submitButton.click();

    // Handle consent if needed
    await page.waitForTimeout(2000);
    if (page.url().includes(AUTH_DOMAIN)) {
      const consentButton = page.locator('button:has-text("Accept"), button:has-text("Allow")').first();
      if (await consentButton.isVisible({ timeout: 2000 }).catch(() => false)) {
        await consentButton.click();
      }
    }

    // Wait for redirect back to Immich
    console.log('Waiting for Immich redirect...');
    await page.waitForURL((url) => url.hostname === APP_DOMAIN, { timeout: 30000 });
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'test-results/immich-logged-in.png' }).catch(() => {});

    // Verify we're logged in - Immich shows the main interface after login
    // The URL should not contain /auth/login anymore
    const finalUrl = page.url();
    console.log('Final URL:', finalUrl);
    expect(finalUrl).not.toContain('/auth/login');

    console.log('OIDC login successful!');
  });
});
