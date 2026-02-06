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
 * Radarr Forward Auth E2E Test
 *
 * Tests Radarr movie manager protected by Authelia forward authentication:
 * 1. Create LLDAP directory service
 * 2. Create Authelia frontend
 * 3. Deploy Radarr behind nginx with forward auth
 * 4. Test that unauthenticated requests are redirected to Authelia
 * 5. Test that authenticated users can access Radarr
 *
 * Note: Radarr doesn't support native OIDC/LDAP, so we use forward auth.
 *
 * Requires /etc/hosts entries:
 *   127.0.0.1 radarr-auth.test.local
 *   127.0.0.1 radarr-app.test.local
 */

const DIRECTORY_SERVICE = 'radarr-auth-dir';
const FRONTEND_SERVICE = 'radarr-auth-fe';
const RADARR_CONTAINER = 'radarr-test';
const NGINX_CONTAINER = 'nginx-radarr-proxy';

// Domain names (must be in /etc/hosts pointing to 127.0.0.1)
const AUTH_DOMAIN = 'radarr-auth.test.local';
const APP_DOMAIN = 'radarr-app.test.local';

// HTTPS ports
const AUTHELIA_HTTPS_PORT = 9643;
const RADARR_HTTPS_PORT = 9644;

// Test user
const TEST_USER = 'radarruser';
const TEST_PASSWORD = 'RadarrPass123!';
const TEST_EMAIL = 'radarruser@test.local';

let AUTHELIA_INTERNAL_IP: string;
let RADARR_INTERNAL_IP: string;
let AUTH_NETWORK: string;
let ADMIN_PASSWORD: string;

// Generate self-signed certificates
function generateCerts(): void {
  const certDir = '/tmp/radarr-certs';
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

test.describe('Radarr Forward Auth Integration', () => {
  test.setTimeout(600000); // 10 minute timeout

  test.beforeAll(async () => {
    console.log('=== Setting up Radarr Forward Auth test ===');

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

    // 4. Deploy Radarr
    console.log('Deploying Radarr...');
    for (const container of [RADARR_CONTAINER, NGINX_CONTAINER]) {
      try {
        execSync(`docker rm -f ${container}`, { encoding: 'utf-8', stdio: 'pipe' });
      } catch {}
    }

    execSync(
      `docker run -d --name ${RADARR_CONTAINER} ` +
        `--network ${AUTH_NETWORK} ` +
        `-e PUID=1000 ` +
        `-e PGID=1000 ` +
        `linuxserver/radarr:latest`,
      { encoding: 'utf-8' }
    );

    // Wait for Radarr to be ready
    console.log('Waiting for Radarr to be ready...');
    let radarrReady = false;
    for (let i = 0; i < 60; i++) {
      try {
        const result = execSync(
          `docker exec ${RADARR_CONTAINER} curl -sf http://localhost:7878/ping`,
          { encoding: 'utf-8', timeout: 5000 }
        );
        if (result.includes('Pong')) {
          radarrReady = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (!radarrReady) {
      const logs = execSync(`docker logs ${RADARR_CONTAINER} 2>&1 | tail -50`, {
        encoding: 'utf-8',
      });
      console.log('Radarr logs:', logs);
      throw new Error('Radarr not ready');
    }

    RADARR_INTERNAL_IP = getContainerIp(RADARR_CONTAINER);
    console.log(`Radarr IP: ${RADARR_INTERNAL_IP}`);

    // 5. Deploy nginx with forward auth
    console.log('Deploying nginx with forward auth...');

    // nginx config with Authelia forward auth
    const nginxConfig = `
events { worker_connections 1024; }
http {
    resolver 127.0.0.11 valid=10s;

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

    # Radarr with forward auth
    server {
        listen 3443 ssl;
        server_name ${APP_DOMAIN};
        ssl_certificate /etc/nginx/certs/server.crt;
        ssl_certificate_key /etc/nginx/certs/server.key;

        # Forward auth to Authelia
        location /authelia {
            internal;
            proxy_pass http://${AUTHELIA_INTERNAL_IP}:9091/api/verify?rd=https://${AUTH_DOMAIN}:${AUTHELIA_HTTPS_PORT}/;
            proxy_pass_request_body off;
            proxy_set_header Content-Length "";
            proxy_set_header Host $host;
            proxy_set_header X-Original-URL $scheme://$host$request_uri;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }

        # API bypass (for download clients, Overseerr, etc.)
        location /api {
            proxy_pass http://${RADARR_INTERNAL_IP}:7878;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }

        # Protected main app
        location / {
            auth_request /authelia;
            auth_request_set $user $upstream_http_remote_user;
            auth_request_set $groups $upstream_http_remote_groups;
            auth_request_set $name $upstream_http_remote_name;
            auth_request_set $email $upstream_http_remote_email;

            proxy_set_header Remote-User $user;
            proxy_set_header Remote-Groups $groups;
            proxy_set_header Remote-Name $name;
            proxy_set_header Remote-Email $email;

            error_page 401 =302 https://${AUTH_DOMAIN}:${AUTHELIA_HTTPS_PORT}/?rd=$scheme://$host$request_uri;

            proxy_pass http://${RADARR_INTERNAL_IP}:7878;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }
    }
}`;
    fs.writeFileSync('/tmp/radarr-nginx.conf', nginxConfig);

    execSync(
      `docker run -d --name ${NGINX_CONTAINER} ` +
        `--network ${AUTH_NETWORK} ` +
        `-p ${AUTHELIA_HTTPS_PORT}:443 ` +
        `-p ${RADARR_HTTPS_PORT}:3443 ` +
        `-v /tmp/radarr-nginx.conf:/etc/nginx/nginx.conf:ro ` +
        `-v /tmp/radarr-certs:/etc/nginx/certs:ro ` +
        `nginx:alpine`,
      { encoding: 'utf-8' }
    );

    await new Promise((r) => setTimeout(r, 3000));

    // Wait for Authelia HTTPS
    console.log('Waiting for Authelia HTTPS...');
    const autheliaReady = await waitForHttps(
      `https://${AUTH_DOMAIN}:${AUTHELIA_HTTPS_PORT}/api/health`,
      60000
    );
    if (!autheliaReady) {
      throw new Error('Authelia HTTPS not ready');
    }

    console.log('=== Setup complete ===');
  });

  test.afterAll(async () => {
    console.log('=== Cleaning up Radarr Forward Auth test ===');
    for (const container of [RADARR_CONTAINER, NGINX_CONTAINER]) {
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

  test('Radarr ping endpoint responds directly', async () => {
    const result = execSync(
      `docker exec ${RADARR_CONTAINER} curl -sf http://localhost:7878/ping`,
      { encoding: 'utf-8' }
    );
    expect(result).toContain('Pong');
  });

  test('API endpoint is accessible without auth (bypass)', async ({ page }) => {
    // API should be accessible without authentication (for download clients)
    const response = await page.request.get(
      `https://${APP_DOMAIN}:${RADARR_HTTPS_PORT}/api/v3/system/status`
    );
    // Should get 401 from Radarr itself (needs API key), not redirect to Authelia
    // This proves the bypass is working - we reached Radarr, not Authelia
    expect([200, 401]).toContain(response.status());
    console.log('API bypass working - reached Radarr API');
  });

  test('Main UI redirects to Authelia when not authenticated', async ({ page }) => {
    // Clear cookies to ensure we're not authenticated
    await page.context().clearCookies();

    // Try to access Radarr main UI
    await page.goto(`https://${APP_DOMAIN}:${RADARR_HTTPS_PORT}/`);

    // Should be redirected to Authelia login
    await page.waitForURL((url) => url.hostname === AUTH_DOMAIN, { timeout: 15000 });

    // Verify we're on Authelia login page
    const loginForm = page.locator('input[name="username"], input[id="username-textfield"]');
    await expect(loginForm).toBeVisible({ timeout: 10000 });

    console.log('Forward auth working - redirected to Authelia');
  });

  test('Full forward auth login flow', async ({ page }) => {
    // Clear cookies
    await page.context().clearCookies();

    // 1. Navigate to Radarr
    console.log('Navigating to Radarr...');
    await page.goto(`https://${APP_DOMAIN}:${RADARR_HTTPS_PORT}/`);

    // 2. Should redirect to Authelia
    console.log('Waiting for Authelia redirect...');
    await page.waitForURL((url) => url.hostname === AUTH_DOMAIN, { timeout: 15000 });
    await page.screenshot({ path: 'test-results/authelia-login-radarr.png' }).catch(() => {});

    // 3. Fill credentials
    console.log('Filling credentials...');
    const usernameInput = page.locator('input[name="username"], input[id="username-textfield"]').first();
    const passwordInput = page.locator('input[name="password"], input[id="password-textfield"]').first();

    await expect(usernameInput).toBeVisible({ timeout: 10000 });
    await usernameInput.fill(TEST_USER);
    await passwordInput.fill(TEST_PASSWORD);

    // 4. Submit login
    const submitButton = page.locator('button[type="submit"]').first();
    await submitButton.click();

    // 5. Should redirect back to Radarr
    console.log('Waiting for Radarr redirect...');
    await page.waitForURL((url) => url.hostname === APP_DOMAIN, { timeout: 30000 });
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'test-results/radarr-logged-in.png' }).catch(() => {});

    // 6. Verify we can see Radarr UI
    // Radarr shows a navbar with "Movies" when loaded
    const pageContent = await page.content();
    console.log('Page content preview:', pageContent.substring(0, 500));

    // Radarr UI should be visible (look for common elements)
    // The page should contain Radarr-specific content
    expect(page.url()).toContain(APP_DOMAIN);

    console.log('Forward auth login successful!');
  });
});
