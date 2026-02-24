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
 * Authentik + oauth2-proxy E2E Test - Full Browser Flow
 *
 * Tests a complete OIDC-protected application with Authentik as identity provider:
 * 1. Create LLDAP directory service
 * 2. Create Authentik frontend with bootstrap credentials
 * 3. Deploy nginx TLS proxy
 * 4. Configure Authentik with OAuth2 provider and application via API
 * 5. Create test user in Authentik
 * 6. Deploy oauth2-proxy + whoami backend with OIDC config pointing to Authentik
 * 7. Test full browser login flow through oauth2-proxy → Authentik → back to app
 *
 * Requires:
 *   - /etc/hosts entries:
 *       127.0.0.1 ak-oauth2-auth.test.local
 *       127.0.0.1 ak-oauth2-app.test.local
 */

const DIRECTORY_SERVICE = 'ak-oauth2-dir';
const FRONTEND_SERVICE = 'ak-oauth2-fe';
const OAUTH2_PROXY_CONTAINER = 'authentik-oauth2-proxy-test';
const BACKEND_CONTAINER = 'authentik-whoami-test';
const NGINX_CONTAINER = 'nginx-ak-oauth2-proxy';

// Domain names (must be in /etc/hosts pointing to 127.0.0.1)
const AUTH_DOMAIN = 'ak-oauth2-auth.test.local';
const APP_DOMAIN = 'ak-oauth2-app.test.local';

// HTTPS ports - use 443 for Authentik so the OIDC issuer URL matches
// (Authentik returns issuer without port, so we need default HTTPS port)
const AUTHENTIK_HTTPS_PORT = 443;
const APP_HTTPS_PORT = 9544;

// OIDC client settings
const OIDC_CLIENT_ID = 'oauth2-proxy-authentik-test';
const OIDC_CLIENT_SECRET = 'oauth2-proxy-secret-1234567890123456';

// Test user
const TEST_USER = 'oauth2proxyuser';
const TEST_PASSWORD = 'OAuth2Proxy123!';
const TEST_EMAIL = 'oauth2proxy@test.local';

let AUTHENTIK_INTERNAL_IP: string;
let SSO_NETWORK: string;
let AUTHENTIK_BOOTSTRAP_TOKEN: string;

// Generate self-signed certificates for TLS
function generateCerts(): void {
  const certDir = '/tmp/ak-oauth2-proxy-certs';
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
 * Get OAuth2 scope property mappings from Authentik
 */
function getOAuth2ScopeMappings(containerName: string, token: string): string[] {
  console.log('Getting OAuth2 scope property mappings...');

  const mappingsResult = authentikApiRequest(
    containerName,
    'GET',
    '/api/v3/propertymappings/scope/?page_size=100',
    token
  );

  const mappings = JSON.parse(mappingsResult);
  if (mappings.error || !mappings.results) {
    console.log('Mappings result:', mappingsResult);
    throw new Error('Could not get property mappings');
  }

  const requiredScopes = ['openid', 'profile', 'email'];
  const scopeMappingIds: string[] = [];

  for (const mapping of mappings.results) {
    if (requiredScopes.includes(mapping.scope_name)) {
      console.log(`Found scope mapping: ${mapping.scope_name} -> ${mapping.pk}`);
      scopeMappingIds.push(mapping.pk);
    }
  }

  console.log(`Found ${scopeMappingIds.length} scope mappings`);
  return scopeMappingIds;
}

/**
 * Get a certificate keypair from Authentik for JWT signing
 */
function getSigningKey(containerName: string, token: string): string | null {
  console.log('Getting certificate keypairs for JWT signing...');

  const keypairsResult = authentikApiRequest(
    containerName,
    'GET',
    '/api/v3/crypto/certificatekeypairs/',
    token
  );

  const keypairs = JSON.parse(keypairsResult);
  if (keypairs.error || !keypairs.results) {
    console.log('Keypairs result:', keypairsResult);
    return null;
  }

  // Log all keypairs for debugging
  console.log(`Found ${keypairs.results.length} keypairs total`);
  for (const kp of keypairs.results) {
    console.log(`  Keypair: ${kp.name}, pk=${kp.pk}, has_key=${kp.has_key}, private_key_available=${kp.private_key_available}`);
  }

  // Look for authentik self-signed certificate first (created by default)
  // The self-signed certificate should have a private key
  for (const kp of keypairs.results) {
    if (kp.name?.toLowerCase().includes('authentik') || kp.name?.toLowerCase().includes('self-signed')) {
      console.log(`Using Authentik self-signed keypair: ${kp.pk}`);
      return kp.pk;
    }
  }

  // Fall back to any keypair that has a private key
  // Check both has_key and private_key_available (API might use different fields)
  for (const kp of keypairs.results) {
    if (kp.has_key === true || kp.private_key_available === true || kp.has_key !== false) {
      console.log(`Using keypair: ${kp.name} -> ${kp.pk}`);
      return kp.pk;
    }
  }

  // Last resort: use the first keypair
  if (keypairs.results.length > 0) {
    const kp = keypairs.results[0];
    console.log(`Using first available keypair: ${kp.name} -> ${kp.pk}`);
    return kp.pk;
  }

  console.log('No certificate keypairs found');
  return null;
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
  const providerName = `oauth2-proxy-provider-${Date.now()}`;

  const scopeMappings = getOAuth2ScopeMappings(containerName, token);

  // Get an authorization flow
  console.log('Getting authorization flows...');
  const flowsResult = authentikApiRequest(
    containerName,
    'GET',
    '/api/v3/flows/instances/?designation=authorization',
    token
  );
  const flows = JSON.parse(flowsResult);
  if (flows.error || !flows.results || flows.results.length === 0) {
    throw new Error('No authorization flow found');
  }
  const authorizationFlow = flows.results[0].pk;
  console.log(`Using authorization flow: ${authorizationFlow}`);

  // Get implicit consent flow
  let implicitFlow = authorizationFlow;
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
    }
  } catch {
    console.log('Could not find implicit flow, using default');
  }

  // Get signing key for JWT tokens
  const signingKey = getSigningKey(containerName, token);
  if (!signingKey) {
    console.log('Warning: No signing key found, OAuth2 tokens may not be verifiable');
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
      signing_key: signingKey,
      access_token_validity: 'minutes=10',
      refresh_token_validity: 'days=30',
      sub_mode: 'user_username',
      include_claims_in_id_token: true,
      issuer_mode: 'per_provider',
      property_mappings: scopeMappings,
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
      name: `OAuth2 Proxy Test ${Date.now()}`,
      slug: slug,
      provider: providerId,
      meta_launch_url: `https://${APP_DOMAIN}:${APP_HTTPS_PORT}/`,
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
  let userId = user.pk;

  if (user.error && !user.body?.includes('already exists')) {
    console.log('User result:', userResult);
    throw new Error(`Failed to create user: ${user.error}`);
  }

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
      userId = search.results[0].pk;
      console.log(`Found existing user: ${userId}`);
    } else {
      throw new Error('Could not create or find user');
    }
  } else {
    console.log(`Created user with ID: ${userId}`);
  }

  // Set password
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

test.describe('Authentik + oauth2-proxy OIDC Browser Flow', () => {
  test.setTimeout(600000); // 10 minute timeout

  test.beforeAll(async () => {
    console.log('=== Setting up Authentik + oauth2-proxy OIDC test ===');

    // Generate TLS certificates
    console.log('Generating self-signed certificates...');
    generateCerts();
    console.log('Certificates generated');

    // 1. Create LLDAP directory service
    console.log('Creating LLDAP directory service...');
    try {
      dokku(`sso:create ${DIRECTORY_SERVICE}`);
    } catch (e: any) {
      if (!e.stderr?.includes('already exists')) {
        throw e;
      }
    }

    const dirHealthy = await waitForHealthy(DIRECTORY_SERVICE, 'directory');
    if (!dirHealthy) {
      throw new Error('Directory service not healthy');
    }

    // Use the well-known SSO network name (must match config's SSO_NETWORK)
    SSO_NETWORK = 'dokku.sso.network';
    console.log(`Auth network: ${SSO_NETWORK}`);

    // 2. Create Authentik frontend service
    console.log('Creating Authentik frontend service...');

    // Force cleanup of any leftover service from previous runs
    const serviceDir = `/var/lib/dokku/services/sso/frontend/${FRONTEND_SERVICE}`;
    try {
      dokku(`sso:frontend:destroy ${FRONTEND_SERVICE} -f`, { quiet: true, swallowErrors: true });
    } catch {}
    try {
      execSync(`sudo rm -rf ${serviceDir}`, { encoding: 'utf-8', stdio: 'pipe' });
    } catch {}
    for (const suffix of ['', '.worker', '.postgres', '.redis']) {
      try {
        execSync(`docker rm -f dokku.sso.frontend.${FRONTEND_SERVICE}${suffix}`, {
          encoding: 'utf-8',
          stdio: 'pipe',
        });
      } catch {}
    }

    dokku(`sso:frontend:create ${FRONTEND_SERVICE} --provider authentik`);

    // Wait for Authentik to be healthy
    console.log('Waiting for Authentik to be ready...');
    const healthy = await waitForHealthy(FRONTEND_SERVICE, 'frontend', 180000);
    if (!healthy) {
      try {
        const logs = dokku(`sso:frontend:logs ${FRONTEND_SERVICE} -n 50`);
        console.log('Authentik logs:', logs);
      } catch {}
      throw new Error('Authentik not healthy');
    }

    // Get Authentik container info
    const authentikContainerName = `dokku.sso.frontend.${FRONTEND_SERVICE}`;
    AUTHENTIK_INTERNAL_IP = getContainerIp(authentikContainerName);
    console.log(`Authentik internal IP: ${AUTHENTIK_INTERNAL_IP}`);

    // Get bootstrap token
    try {
      AUTHENTIK_BOOTSTRAP_TOKEN = execSync(
        `sudo cat ${serviceDir}/BOOTSTRAP_TOKEN`,
        { encoding: 'utf-8' }
      ).trim();
      console.log('Got bootstrap token');
    } catch {
      console.log('Could not read bootstrap token, trying environment variable...');
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
    // Note: nginx listens on 443 for Authentik (so issuer URL doesn't need port)
    const nginxConfig = `
events { worker_connections 1024; }
http {
    resolver 127.0.0.11 valid=10s;

    # Authentik HTTPS on port 443 (default HTTPS)
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
    # oauth2-proxy HTTPS
    server {
        listen ${APP_HTTPS_PORT} ssl;
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
    fs.writeFileSync('/tmp/ak-oauth2-proxy-nginx.conf', nginxConfig);

    execSync(
      `docker run -d --name ${NGINX_CONTAINER} ` +
        `--network ${SSO_NETWORK} ` +
        `-p 443:443 ` +
        `-p ${APP_HTTPS_PORT}:${APP_HTTPS_PORT} ` +
        `-v /tmp/ak-oauth2-proxy-nginx.conf:/etc/nginx/nginx.conf:ro ` +
        `-v /tmp/ak-oauth2-proxy-certs:/etc/nginx/certs:ro ` +
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

    // 4. Wait for Authentik flows to be created
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

    // Wait for scope property mappings to be available
    console.log('Waiting for scope property mappings...');
    let scopeMappingsReady = false;
    for (let i = 0; i < 30; i++) {
      try {
        const mappingsResult = authentikApiRequest(
          authentikContainerName,
          'GET',
          '/api/v3/propertymappings/scope/?page_size=100',
          AUTHENTIK_BOOTSTRAP_TOKEN
        );
        const mappings = JSON.parse(mappingsResult);
        if (mappings.results && mappings.results.length > 0) {
          scopeMappingsReady = true;
          console.log(`Found ${mappings.results.length} scope property mappings`);
          break;
        }
        console.log('No scope mappings yet, waiting...');
      } catch (e) {
        console.log('Error checking scope mappings:', e);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!scopeMappingsReady) {
      console.log('Warning: Scope mappings not ready, continuing anyway...');
    }

    // Wait for certificate keypairs to be available (created by Authentik blueprints)
    console.log('Waiting for certificate keypairs...');
    let keypairsReady = false;
    for (let i = 0; i < 30; i++) {
      try {
        const keypairsResult = authentikApiRequest(
          authentikContainerName,
          'GET',
          '/api/v3/crypto/certificatekeypairs/',
          AUTHENTIK_BOOTSTRAP_TOKEN
        );
        const keypairs = JSON.parse(keypairsResult);
        console.log(`Keypairs API response: ${keypairs.results?.length || 0} keypairs`);
        if (keypairs.results && keypairs.results.length > 0) {
          keypairsReady = true;
          // Log all keypairs for debugging
          for (const kp of keypairs.results) {
            console.log(`  - ${kp.name}: pk=${kp.pk}, has_key=${kp.has_key}`);
          }
          break;
        }
        console.log('No certificate keypairs yet, waiting...');
      } catch (e) {
        console.log('Error checking certificate keypairs:', e);
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (!keypairsReady) {
      console.log('Warning: Certificate keypairs not ready, JWT signing may fail...');
    }

    // Configure Authentik with OAuth2 provider and application
    console.log('Configuring Authentik OAuth2...');
    const appSlug = `oauth2-proxy-${Date.now()}`;
    const redirectUri = `https://${APP_DOMAIN}:${APP_HTTPS_PORT}/oauth2/callback`;

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

    // Get nginx IP for oauth2-proxy host resolution
    const nginxIp = getContainerIp(NGINX_CONTAINER);

    // 6. Deploy whoami backend
    console.log('Deploying whoami backend...');
    try {
      execSync(`docker rm -f ${BACKEND_CONTAINER}`, { encoding: 'utf-8', stdio: 'pipe' });
    } catch {}

    execSync(
      `docker run -d --name ${BACKEND_CONTAINER} ` +
        `--network ${SSO_NETWORK} ` +
        `traefik/whoami:latest`,
      { encoding: 'utf-8' }
    );

    const backendIp = getContainerIp(BACKEND_CONTAINER);
    console.log(`Whoami backend IP: ${backendIp}`);

    // 7. Deploy oauth2-proxy with Authentik OIDC
    console.log('Deploying oauth2-proxy...');
    try {
      execSync(`docker rm -f ${OAUTH2_PROXY_CONTAINER}`, { encoding: 'utf-8', stdio: 'pipe' });
    } catch {}

    // Cookie secret must be exactly 16, 24, or 32 bytes
    const cookieSecret = '01234567890123456789012345678901';

    // Authentik OIDC endpoints - use the standard OpenID Connect URLs
    // Note: issuer URL must not include port when using default HTTPS (443)
    // because Authentik returns issuer without port in discovery response
    execSync(
      `docker run -d --name ${OAUTH2_PROXY_CONTAINER} ` +
        `--network ${SSO_NETWORK} ` +
        `-e OAUTH2_PROXY_HTTP_ADDRESS=0.0.0.0:4180 ` +
        `-e OAUTH2_PROXY_PROVIDER=oidc ` +
        `-e OAUTH2_PROXY_OIDC_ISSUER_URL=https://${AUTH_DOMAIN}/application/o/${appSlug}/ ` +
        `-e OAUTH2_PROXY_CLIENT_ID=${OIDC_CLIENT_ID} ` +
        `-e OAUTH2_PROXY_CLIENT_SECRET=${OIDC_CLIENT_SECRET} ` +
        `-e OAUTH2_PROXY_REDIRECT_URL=https://${APP_DOMAIN}:${APP_HTTPS_PORT}/oauth2/callback ` +
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

    // Wait for oauth2-proxy
    console.log('Waiting for oauth2-proxy to be ready...');
    await new Promise((r) => setTimeout(r, 5000));

    // Check if oauth2-proxy is running
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

    // Wait for oauth2-proxy HTTPS to be accessible via nginx
    console.log('Waiting for oauth2-proxy HTTPS to be ready...');
    const proxyHttpsReady = await waitForHttps(
      `https://${APP_DOMAIN}:${APP_HTTPS_PORT}/ping`,
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
    console.log(`Authentik: https://${AUTH_DOMAIN}:${AUTHENTIK_HTTPS_PORT}`);
    console.log(`OAuth2 Proxy: https://${APP_DOMAIN}:${APP_HTTPS_PORT}`);
  }, 600000);

  test.afterAll(async () => {
    console.log('=== Cleaning up Authentik + oauth2-proxy test ===');
    try {
      execSync(`docker rm -f ${OAUTH2_PROXY_CONTAINER}`, { encoding: 'utf-8', stdio: 'pipe' });
    } catch {}
    try {
      execSync(`docker rm -f ${BACKEND_CONTAINER}`, { encoding: 'utf-8', stdio: 'pipe' });
    } catch {}
    try {
      execSync(`docker rm -f ${NGINX_CONTAINER}`, { encoding: 'utf-8', stdio: 'pipe' });
    } catch {}
    try {
      dokku(`sso:frontend:destroy ${FRONTEND_SERVICE} -f`, { quiet: true });
    } catch (e: any) {
      console.log('[cleanup] frontend:destroy:', e.stderr?.trim() || e.message);
    }
    try {
      dokku(`sso:destroy ${DIRECTORY_SERVICE} -f`, { quiet: true });
    } catch (e: any) {
      console.log('[cleanup] sso:destroy:', e.stderr?.trim() || e.message);
    }
  });

  test('Full OIDC browser login flow works end-to-end', async ({ page }) => {
    // ===== Test 1: Authentik health endpoint responds =====
    console.log('Test 1: Verifying Authentik is accessible...');
    const healthResponse = await page.request.get(
      `https://${AUTH_DOMAIN}:${AUTHENTIK_HTTPS_PORT}/-/health/ready/`,
      { ignoreHTTPSErrors: true }
    );
    expect(healthResponse.ok()).toBe(true);

    // ===== Test 2: oauth2-proxy ping endpoint responds =====
    console.log('Test 2: Verifying oauth2-proxy is accessible...');
    const pingResponse = await page.request.get(
      `https://${APP_DOMAIN}:${APP_HTTPS_PORT}/ping`,
      { ignoreHTTPSErrors: true }
    );
    expect(pingResponse.ok()).toBe(true);

    // ===== Test 3: Full OIDC browser login flow =====
    console.log('Test 3: Starting full OIDC login flow...');

    // Clear cookies and start fresh
    await page.context().clearCookies();

    // Step 1: Navigate to protected app (oauth2-proxy will redirect to Authentik)
    console.log('Step 3.1: Navigating to protected app...');
    await page.goto(`https://${APP_DOMAIN}:${APP_HTTPS_PORT}/`);

    // Step 2: Should be redirected to Authentik login page
    console.log('Step 3.2: Waiting for redirect to Authentik...');
    await page.waitForURL(
      (url) => url.hostname.includes('authentik') || url.hostname === AUTH_DOMAIN,
      { timeout: 30000 }
    );

    await page.screenshot({ path: 'test-results/ak-oauth2-authentik-login.png' }).catch(() => {});

    // Verify we're on the Authentik login page
    console.log('Step 3.3: Verifying Authentik login page...');
    const usernameInput = page
      .locator('input[name="uidField"], input[name="username"], input[id="id_uid_field"]')
      .first();
    await expect(usernameInput).toBeVisible({ timeout: 15000 });

    // Step 3: Fill in username
    console.log('Step 3.4: Filling in credentials...');
    await usernameInput.fill(TEST_USER);

    // Submit username (Authentik may have two-step login)
    const submitButton = page.locator('button[type="submit"]').first();
    await submitButton.click();

    // Wait for password field
    await page.waitForTimeout(1000);
    const passwordInput = page.locator('input[name="password"], input[type="password"]').first();
    await expect(passwordInput).toBeVisible({ timeout: 10000 });
    await passwordInput.fill(TEST_PASSWORD);

    // Step 4: Submit the login form
    console.log('Step 3.5: Submitting login form...');
    await page.screenshot({ path: 'test-results/ak-oauth2-filled-form.png' }).catch(() => {});
    const loginSubmit = page.locator('button[type="submit"]').first();
    await loginSubmit.click();

    // Step 5: Handle consent screen if shown
    console.log('Step 3.6: Handling consent screen if shown...');
    await page.waitForTimeout(2000);
    const currentUrl = page.url();
    console.log(`Current URL after login: ${currentUrl}`);
    await page.screenshot({ path: 'test-results/ak-oauth2-after-login.png' }).catch(() => {});

    // If still on Authentik (consent screen), try to accept
    if (
      currentUrl.includes(AUTH_DOMAIN) ||
      currentUrl.includes('authentik') ||
      currentUrl.includes('consent')
    ) {
      console.log('Still on Authentik - checking for consent screen...');

      // Look for consent/continue button
      const consentSelectors = [
        'button:has-text("Continue")',
        'button:has-text("Accept")',
        'button:has-text("Allow")',
        'button:has-text("Authorize")',
        'button[type="submit"]',
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
        } catch {
          // Try next selector
        }
      }
    }

    // Step 6: Wait for callback to complete and redirect to actual content
    console.log('Step 3.7: Waiting for redirect back to app...');

    // First wait for URL to match app domain (should already be on callback)
    await page.waitForURL(new RegExp(APP_DOMAIN), { timeout: 30000 });

    // Wait for callback processing to complete - URL should NOT contain 'callback' after processing
    console.log('Current URL:', page.url());

    // Give oauth2-proxy time to process the callback and redirect
    await page.waitForTimeout(3000);

    // Wait for network to settle
    await page.waitForLoadState('networkidle', { timeout: 30000 });

    console.log('URL after networkidle:', page.url());

    // Step 7: Verify we see the whoami content
    console.log('Step 3.8: Verifying whoami content...');
    await page.screenshot({ path: 'test-results/ak-oauth2-whoami-result.png' }).catch(() => {});

    // Log actual page content for debugging
    const bodyText = await page.locator('body').textContent();
    console.log('Page body text (first 500 chars):', bodyText?.substring(0, 500));

    // If we see an error, try to get more context
    if (bodyText?.includes('Internal Server Error') || bodyText?.includes('Error') || bodyText?.includes('error')) {
      console.log('Error detected in page, getting oauth2-proxy logs...');
      try {
        const proxyLogs = execSync(`docker logs ${OAUTH2_PROXY_CONTAINER} 2>&1 | tail -50`, {
          encoding: 'utf-8',
          timeout: 5000
        });
        console.log('oauth2-proxy logs:', proxyLogs);
      } catch (e: any) {
        console.log('Could not get oauth2-proxy logs:', e.message);
      }
    }

    // whoami outputs "Hostname:" and other headers info
    expect(bodyText).toContain('Hostname');

    console.log('All OIDC browser tests passed!');
  });
});
