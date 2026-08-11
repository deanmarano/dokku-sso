import { execSync } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { Page } from '@playwright/test';

export const USE_SUDO = process.env.DOKKU_USE_SUDO === 'true';

/**
 * Run a dokku command with configurable behavior.
 *
 * Covers all variants used across the E2E suite:
 * - global-setup: prefix '[setup]', ignoreAlreadyExists
 * - global-teardown: swallowErrors (returns '' on failure)
 * - spec files: prefix '$ ', logOutput
 */
export function dokku(cmd: string, opts?: {
  quiet?: boolean;
  prefix?: string;
  timeout?: number;
  swallowErrors?: boolean;
  ignoreAlreadyExists?: boolean;
  logOutput?: boolean;
}): string {
  const {
    quiet = false,
    prefix = '$ ',
    timeout = 300000,
    swallowErrors = false,
    ignoreAlreadyExists = false,
    logOutput = true,
  } = opts ?? {};

  const dokkuCmd = USE_SUDO ? `sudo dokku ${cmd}` : `dokku ${cmd}`;
  console.log(`${prefix}${dokkuCmd}`);

  try {
    const result = execSync(dokkuCmd, {
      encoding: 'utf8',
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (logOutput) {
      console.log(result);
    }
    return result;
  } catch (error: any) {
    if (ignoreAlreadyExists) {
      if (
        error.stderr?.includes('already exists') ||
        error.stdout?.includes('already exists')
      ) {
        return error.stdout || '';
      }
    }
    if (swallowErrors) {
      if (!quiet) {
        console.error(`Command failed: ${error.message}`);
      }
      return '';
    }
    if (!quiet) {
      console.error(`Failed:`, error.stderr || error.message);
    }
    throw error;
  }
}

/**
 * Get the running container ID for a directory service.
 * Tries Dokku app label first, falls back to legacy container name.
 */
export function getDirectoryContainerId(serviceName: string): string {
  const appName = `dokku-sso-dir-${serviceName}`;
  try {
    const containerId = execSync(
      `docker ps -q -f "label=com.dokku.app-name=${appName}" -f status=running | head -1`,
      { encoding: 'utf-8' },
    ).trim();
    if (containerId) return containerId;
  } catch {}
  // Fall back to legacy container name
  return `dokku.sso.directory.${serviceName}`;
}

/**
 * Get the running container ID for a frontend service.
 * Reads the APP_NAME from the service directory, then finds the container by Dokku label.
 */
export function getFrontendContainerId(serviceName: string): string {
  // Read the Dokku app name from the service directory
  let appName: string;
  try {
    const cmd = USE_SUDO
      ? `sudo cat /var/lib/dokku/services/sso/frontend/${serviceName}/APP_NAME`
      : `cat /var/lib/dokku/services/sso/frontend/${serviceName}/APP_NAME`;
    appName = execSync(cmd, { encoding: 'utf-8' }).trim();
  } catch {
    // Default app name for authelia provider
    appName = 'authelia';
  }

  const containerId = execSync(
    `docker ps -q -f "label=com.dokku.app-name=${appName}" -f status=running | head -1`,
    { encoding: 'utf-8' },
  ).trim();

  if (!containerId) {
    throw new Error(
      `No running container for frontend service ${serviceName} (app: ${appName}). ` +
      `Running containers: ${execSync('docker ps --format "{{.Names}}"', { encoding: 'utf-8' }).trim()}`
    );
  }
  return containerId;
}

/** Get the IP address of a Docker container, optionally for a specific network. */
export function getContainerIp(containerNameOrId: string, network?: string): string {
  try {
    if (network) {
      const ip = execSync(
        `docker inspect -f '{{(index .NetworkSettings.Networks "${network}").IPAddress}}' ${containerNameOrId}`,
        { encoding: 'utf-8' },
      ).trim();
      if (ip) return ip;
    }
    const ips = execSync(
      `docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' ${containerNameOrId}`,
      { encoding: 'utf-8' },
    ).trim();
    return ips.split(' ')[0];
  } catch {
    // Dump debugging info before failing
    try {
      console.error(`[getContainerIp] Failed for "${containerNameOrId}" (network: ${network || 'any'})`);
      console.error('[getContainerIp] Running containers:', execSync('docker ps --format "table {{.ID}}\t{{.Names}}\t{{.Status}}"', { encoding: 'utf-8' }).trim());
      if (network) {
        console.error(`[getContainerIp] Network ${network}:`, execSync(`docker network inspect ${network} --format='{{range .Containers}}{{.Name}} {{end}}'`, { encoding: 'utf-8' }).trim());
      }
    } catch {}
    throw new Error(`Could not get IP for container ${containerNameOrId}`);
  }
}

/**
 * Parse `dokku sso:credentials <service>` output into a key-value map.
 *
 * The service name must be passed explicitly so this helper stays stateless.
 */
export function getLdapCredentials(serviceName: string): Record<string, string> {
  const output = dokku(`sso:credentials ${serviceName}`);
  const creds: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const match = line.match(/^(\w+)=(.+)$/);
    if (match) {
      creds[match[1]] = match[2];
    }
  }
  return creds;
}

/**
 * Create a user in LLDAP via `docker exec curl` + GraphQL, then set the
 * password with `lldap_set_password`.
 */
export function createLdapUser(
  lldapContainer: string,
  adminPassword: string,
  userId: string,
  email: string,
  password: string,
): void {
  // Get auth token
  console.log('Getting LLDAP auth token...');
  const tokenResult = execSync(
    `docker exec ${lldapContainer} curl -s -X POST ` +
      `-H "Content-Type: application/json" ` +
      `-d '{"username":"admin","password":"${adminPassword}"}' ` +
      `"http://localhost:17170/auth/simple/login"`,
    { encoding: 'utf-8' },
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
    { encoding: 'utf-8' },
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
      { encoding: 'utf-8', stdio: 'pipe' },
    );
    console.log(`Password set for user: ${userId}`);
  } catch (e: any) {
    console.error('lldap_set_password error:', e.stderr || e.message);
    throw e;
  }

  console.log(`Created LDAP user: ${userId}`);
}

/** Poll `sso:status` / `sso:frontend:status` until healthy/running. */
export async function waitForHealthy(
  service: string,
  type: 'directory' | 'frontend',
  maxWait = 60000,
): Promise<boolean> {
  const start = Date.now();
  const cmd =
    type === 'directory'
      ? `sso:status ${service}`
      : `sso:frontend:status ${service}`;

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

/** Poll an HTTPS endpoint (via curl -k) until it responds. */
export async function waitForHttps(
  url: string,
  maxWait = 60000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      execSync(`curl -sk -o /dev/null -w "%{http_code}" "${url}"`, {
        encoding: 'utf-8',
        timeout: 5000,
      });
      return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

// ─── dokku-library integration helpers ───────────────────────────────────────
// These helpers support tests that use `library:checkout` to deploy apps as
// proper dokku apps instead of raw Docker containers.

export interface TestUser {
  username: string;
  email: string;
  password: string;
}

export interface AuthCredentials {
  authService: string;
  frontendService: string;
  ldapUrl: string;
  adminPassword: string;
}

/**
 * Set up SSO directory + frontend services for testing.
 * Returns credentials needed for test user creation and login.
 *
 * Force-destroys any existing services first to ensure a clean state,
 * since previous test runs may leave partial state behind.
 */
export function setupAuthServices(
  authService = 'test-auth',
  frontendService = 'test-frontend',
): AuthCredentials {
  // Clean up any stale state from previous runs to avoid "already exists"
  // errors with missing config files
  teardownAuthServices(authService, frontendService);

  dokku(`sso:create ${authService}`, { timeout: 180000, ignoreAlreadyExists: true });
  // Use --directory to link LDAP before first deploy, avoiding a fragile redeploy via frontend:apply
  dokku(`sso:frontend:create ${frontendService} --directory ${authService}`, { timeout: 180000, ignoreAlreadyExists: true });

  const credentials = dokku(`sso:credentials ${authService}`, { logOutput: false });
  const ldapUrl =
    credentials.match(/LDAP_URL=(.+)/)?.[1] ?? `ldap://${authService}:3890`;
  const adminPassword =
    credentials.match(/ADMIN_PASSWORD=(.+)/)?.[1] ?? 'admin';

  return { authService, frontendService, ldapUrl, adminPassword };
}

/** Tear down SSO services completely. */
export function teardownAuthServices(
  authService = 'test-auth',
  frontendService = 'test-frontend',
): void {
  dokku(`sso:frontend:destroy ${frontendService} -f`, {
    timeout: 60000,
    swallowErrors: true,
    quiet: true,
  });
  dokku(`sso:destroy ${authService} -f`, {
    timeout: 60000,
    swallowErrors: true,
    quiet: true,
  });
  // If sso:destroy failed (e.g., provider_destroy failed before rm -rf),
  // manually clean up the service directory to prevent stale state
  try {
    execSync(
      USE_SUDO
        ? `sudo rm -rf /var/lib/dokku/services/sso/directory/${authService}`
        : `rm -rf /var/lib/dokku/services/sso/directory/${authService}`,
      { encoding: 'utf-8', stdio: 'pipe' },
    );
  } catch {}
}

/** Create a test user in the LDAP directory via the sso plugin. */
export function createLdapTestUser(
  authService: string,
  user: TestUser,
): void {
  dokku(
    `sso:create-user ${authService} ${user.username} ${user.email} ${user.password}`,
    { timeout: 30000 },
  );
}

/** Wait for SSO services to become healthy. */
export async function waitForAuthHealthy(
  authService = 'test-auth',
  timeout = 120000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const result = dokku(`sso:info ${authService}`, { logOutput: false, quiet: true });
      if (result.includes('running') || result.includes('healthy')) {
        return true;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 5000));
  }
  return false;
}

/** Poll an HTTP endpoint until it responds (any success/redirect/401 status). */
export async function waitForHttp(
  url: string,
  timeout = 60000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5000),
        redirect: 'manual',
      });
      if (
        response.ok ||
        response.status === 302 ||
        response.status === 301 ||
        response.status === 401
      ) {
        return true;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 5000));
  }
  return false;
}

/** Get the app URL from dokku domains. */
export function getAppUrl(appName: string): string {
  const domains = dokku(`domains:report ${appName} --domains-app-vhosts`, {
    logOutput: false,
    quiet: true,
  });
  const domain = domains.trim().split(/\s+/)[0];
  return `http://${domain}`;
}

/** Check if a dokku app exists. */
export function appExists(appName: string): boolean {
  try {
    dokku(`apps:exists ${appName}`, { logOutput: false, quiet: true });
    return true;
  } catch {
    return false;
  }
}

/** Clean up an app deployed via library:checkout. */
export function cleanupApp(appName: string): void {
  try {
    dokku(`library:cleanup ${appName} --force`, {
      timeout: 120000,
      swallowErrors: true,
      quiet: true,
    });
  } catch {
    try {
      dokku(`apps:destroy ${appName} --force`, { swallowErrors: true, quiet: true });
    } catch {}
  }
}

/** Check if the dokku-library plugin is installed. */
export function libraryInstalled(): boolean {
  try {
    const result = dokku('library:list', { logOutput: false, quiet: true });
    return !result.includes('is not a dokku command');
  } catch {
    return false;
  }
}

/** Check if a dokku plugin is available. */
export function pluginAvailable(plugin: string): boolean {
  try {
    execSync(`ls /var/lib/dokku/plugins/available/${plugin}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * True if /etc/hosts already maps this exact hostname.
 *
 * Compares hostnames, not substrings. `test-radarr-auth.test.local` ends with
 * `auth.test.local`, so a substring test reports the auth domain as already
 * present the moment the app domain is added. The auth domain then never gets
 * an entry, and the forward-auth redirect lands on a host the browser cannot
 * resolve -- while every app whose name happens not to end in the auth domain
 * works fine.
 */
export function hostsFileHasEntry(hostsContents: string, domain: string): boolean {
  return hostsContents
    .split('\n')
    .map((line) => line.split('#')[0].trim())
    .filter(Boolean)
    .some((line) => line.split(/\s+/).slice(1).includes(domain));
}

/**
 * Give an app a self-signed certificate, so it is reachable over https.
 *
 * Authelia refuses an insecure `rd` target and silently falls back to its
 * default_redirection_url, so a forward-auth protected app has to be served
 * over TLS for the post-login return trip to reach it. The Authelia app
 * generates itself a certificate for the same reason; apps protected by it
 * need one too. Playwright is configured with ignoreHTTPSErrors.
 */
export function addSelfSignedCert(app: string, domain: string): void {
  try {
    const certDir = execSync('mktemp -d', { encoding: 'utf-8' }).trim();
    execSync(
      `openssl req -x509 -nodes -days 3650 -newkey rsa:2048 ` +
        `-keyout ${certDir}/server.key -out ${certDir}/server.crt ` +
        `-subj "/CN=${domain}" -addext "subjectAltName=DNS:${domain}" 2>/dev/null`,
      { encoding: 'utf-8' },
    );
    // dokku certs:add reads a tar stream of server.crt + server.key on stdin.
    execSync(`tar cf - -C ${certDir} server.crt server.key | dokku certs:add ${app}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    execSync(`rm -rf ${certDir}`);
  } catch (e: any) {
    console.log(`addSelfSignedCert(${app}) failed: ${e.message}`);
  }
}

/** Add a hostname to /etc/hosts pointing to 127.0.0.1. */
export function addHostsEntry(domain: string): void {
  try {
    const hosts = execSync('cat /etc/hosts', { encoding: 'utf-8' });
    if (!hostsFileHasEntry(hosts, domain)) {
      execSync(`echo "127.0.0.1 ${domain}" | sudo tee -a /etc/hosts`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }
  } catch {}
}

/** Get a dokku config value for an app. */
export function getConfig(appName: string, key: string): string {
  return dokku(`config:get ${appName} ${key}`, { logOutput: false, quiet: true }).trim();
}

/** Wait for a dokku app to be running (via ps:report). */
export async function waitForAppHealthy(
  appName: string,
  timeout = 60000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const result = dokku(`ps:report ${appName} --running`, {
        logOutput: false,
        quiet: true,
      });
      if (result.trim() === 'true') {
        return true;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 5000));
  }
  return false;
}

/** Complete the Authelia login form in a Playwright page. */
export async function loginViaAuthelia(
  page: Page,
  username: string,
  password: string,
): Promise<void> {
  await page.waitForSelector('input[name="username"], #username-textfield', {
    timeout: 15000,
  });

  const usernameField = page.locator(
    'input[name="username"], #username-textfield',
  );
  const passwordField = page.locator(
    'input[name="password"], #password-textfield',
  );

  await usernameField.fill(username);
  await passwordField.fill(password);

  await page.locator('button[type="submit"], #sign-in-button').click();

  await page.waitForURL((url) => !isAutheliaUrl(url.href), { timeout: 15000 });
}

/** Verify that accessing a URL redirects to Authelia login. */
/** The Authelia service domain used across the E2E suite. */
export const AUTH_DOMAIN = 'auth.test.local';

/**
 * True if this URL is Authelia's own portal.
 *
 * Compares the hostname; a substring test on the whole URL would call
 * `test-radarr-auth.test.local` an Authelia URL, because it ends with the auth
 * domain. Any app whose name ends that way would look like it never left the
 * login page.
 */
export function isAutheliaUrl(href: string, authDomain: string = AUTH_DOMAIN): boolean {
  try {
    const { hostname } = new URL(href);
    return hostname === authDomain || hostname.startsWith('authelia.');
  } catch {
    return false;
  }
}

export async function verifyAutheliaRedirect(
  page: Page,
  appUrl: string,
): Promise<boolean> {
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  const href = page.url();
  if (isAutheliaUrl(href)) return true;
  try {
    const url = new URL(href);
    return url.searchParams.has('rd') || url.pathname.includes('/api/verify');
  } catch {
    return false;
  }
}

// ─── Preset helpers (used by gitlab-ldap and other non-library tests) ────────

/**
 * Get the path to a preset file in the integrations directory.
 */
export function getPresetPath(presetName: string): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(__dirname, '../../integrations', `${presetName}.sh`);
}

/**
 * Call a preset bash function and return its output.
 */
export function callPresetFunction(
  presetName: string,
  functionName: string,
  args: string[] = [],
): string {
  const presetPath = getPresetPath(presetName);
  const escapedArgs = args.map(arg => `"${arg.replace(/"/g, '\\"')}"`).join(' ');
  const cmd = `bash -c 'source "${presetPath}" && ${functionName} ${escapedArgs}'`;

  try {
    return execSync(cmd, { encoding: 'utf-8' });
  } catch (error: any) {
    console.error(`Failed to call preset function ${functionName}:`, error.stderr || error.message);
    throw error;
  }
}

/**
 * Generate GitLab LDAP ruby configuration using the preset.
 */
export function generateGitlabLdapConfig(
  ldapHost: string,
  ldapPort: number,
  baseDn: string,
  bindDn: string,
  bindPassword: string,
): string {
  return callPresetFunction('gitlab', 'preset_generate_ldap_rb', [
    ldapHost,
    ldapPort.toString(),
    baseDn,
    bindDn,
    bindPassword,
  ]);
}

/**
 * Generate GitLab OIDC ruby configuration using the preset.
 */
export function generateGitlabOidcConfig(
  clientId: string,
  clientSecret: string,
  authDomain: string,
  gitlabDomain: string,
): string {
  return callPresetFunction('gitlab', 'preset_generate_oidc_rb', [
    clientId,
    clientSecret,
    authDomain,
    gitlabDomain,
  ]);
}
