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
 * Authentik + Grafana OIDC Infrastructure E2E Test
 *
 * Tests that Authentik can be configured with OIDC and Grafana can connect:
 * 1. Create LLDAP directory service
 * 2. Create Authentik frontend with bootstrap credentials
 * 3. Deploy nginx TLS proxy
 * 4. Deploy Grafana with OIDC config pointing to Authentik
 * 5. Verify Grafana can reach Authentik's OIDC endpoints
 *
 * Note: Full browser login flow requires manual OAuth2 provider configuration
 * in Authentik's admin UI. This test verifies infrastructure connectivity.
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

let AUTHENTIK_INTERNAL_IP: string;
let AUTH_NETWORK: string;

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

test.describe('Authentik + Grafana OIDC Infrastructure', () => {
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

    // 3. Deploy nginx TLS proxy
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

    // Get nginx IP for Grafana host resolution
    const nginxIp = getContainerIp(NGINX_CONTAINER);

    // 4. Deploy Grafana with OIDC
    console.log('Deploying Grafana with OIDC...');
    try {
      execSync(`docker rm -f ${GRAFANA_CONTAINER}`, { encoding: 'utf-8', stdio: 'pipe' });
    } catch {}

    // Grafana OIDC config pointing to Authentik (will fail without OAuth2 provider,
    // but tests infrastructure connectivity)
    const grafanaEnv = [
      `GF_SERVER_ROOT_URL=https://${APP_DOMAIN}:${GRAFANA_HTTPS_PORT}/`,
      'GF_AUTH_GENERIC_OAUTH_ENABLED=true',
      'GF_AUTH_GENERIC_OAUTH_NAME=Authentik',
      'GF_AUTH_GENERIC_OAUTH_CLIENT_ID=grafana-test',
      'GF_AUTH_GENERIC_OAUTH_CLIENT_SECRET=grafana-test-secret',
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
  }, 600000);

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

  test('Authentik health endpoint responds via HTTPS', async () => {
    const result = execSync(
      `curl -sk https://${AUTH_DOMAIN}:${AUTHENTIK_HTTPS_PORT}/-/health/ready/`,
      { encoding: 'utf-8', timeout: 10000 }
    );
    // Authentik returns empty body with 200/204 for health check
    expect(result).toBeDefined();
  });

  test('Authentik OpenID configuration endpoint responds', async () => {
    const result = execSync(
      `curl -sk https://${AUTH_DOMAIN}:${AUTHENTIK_HTTPS_PORT}/application/o/.well-known/openid-configuration`,
      { encoding: 'utf-8', timeout: 10000 }
    );
    // This may return 404 if no applications are configured, but proves connectivity
    expect(result).toBeDefined();
  });

  test('Grafana health endpoint responds via HTTPS', async () => {
    // Grafana health via nginx proxy
    const result = execSync(
      `curl -sk https://${APP_DOMAIN}:${GRAFANA_HTTPS_PORT}/api/health`,
      { encoding: 'utf-8', timeout: 10000 }
    );
    expect(result).toContain('ok');
  });

  test('Grafana can resolve Authentik domain', async () => {
    // Verify Grafana container can reach Authentik
    const result = execSync(
      `docker exec ${GRAFANA_CONTAINER} curl -sk https://${AUTH_DOMAIN}:443/-/health/ready/`,
      { encoding: 'utf-8', timeout: 10000 }
    );
    expect(result).toBeDefined();
  });

  test('Grafana OIDC settings are configured', async () => {
    // Check Grafana has OIDC settings via API
    const result = execSync(
      `docker exec ${GRAFANA_CONTAINER} curl -sf http://localhost:3000/api/frontend/settings`,
      { encoding: 'utf-8', timeout: 10000 }
    );
    const settings = JSON.parse(result);
    // Verify OIDC is configured
    expect(settings.oauth).toBeDefined();
  });

  test('Grafana login page shows OIDC option', async ({ page }) => {
    // Navigate to Grafana login and verify OIDC button is present
    await page.goto(`https://${APP_DOMAIN}:${GRAFANA_HTTPS_PORT}/login`, {
      ignoreHTTPSErrors: true,
    });

    // Wait for page to load
    await page.waitForLoadState('networkidle');

    // Check that OAuth login option is shown (the "Sign in with Authentik" button)
    const oauthButton = page.locator('a[href*="login/generic_oauth"]');
    await expect(oauthButton).toBeVisible({ timeout: 10000 });
  });
});
