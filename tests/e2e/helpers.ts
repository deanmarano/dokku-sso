import { execSync } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';

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

/** Get the first IP address of a Docker container. */
export function getContainerIp(containerName: string): string {
  try {
    const ips = execSync(
      `docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' ${containerName}`,
      { encoding: 'utf-8' },
    ).trim();
    return ips.split(' ')[0];
  } catch {
    throw new Error(`Could not get IP for container ${containerName}`);
  }
}

/**
 * Parse `dokku auth:credentials <service>` output into a key-value map.
 *
 * The service name must be passed explicitly so this helper stays stateless.
 */
export function getLdapCredentials(serviceName: string): Record<string, string> {
  const output = dokku(`auth:credentials ${serviceName}`);
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

/** Poll `auth:status` / `auth:frontend:status` until healthy/running. */
export async function waitForHealthy(
  service: string,
  type: 'directory' | 'frontend',
  maxWait = 60000,
): Promise<boolean> {
  const start = Date.now();
  const cmd =
    type === 'directory'
      ? `auth:status ${service}`
      : `auth:frontend:status ${service}`;

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

/**
 * Get the path to a preset file in the integrations directory.
 */
export function getPresetPath(presetName: string): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(__dirname, '../../integrations', `${presetName}.sh`);
}

/**
 * Call a preset bash function and return its output.
 *
 * @param presetName - The preset name (e.g., 'grafana')
 * @param functionName - The function to call (e.g., 'preset_generate_ldap_toml')
 * @param args - Arguments to pass to the function
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
 * Generate Grafana LDAP config (ldap.toml) using the preset.
 */
export function generateGrafanaLdapConfig(
  ldapHost: string,
  ldapPort: number,
  baseDn: string,
  bindDn: string,
  bindPassword: string,
): string {
  return callPresetFunction('grafana', 'preset_generate_ldap_toml', [
    ldapHost,
    ldapPort.toString(),
    baseDn,
    bindDn,
    bindPassword,
  ]);
}

/**
 * Get Grafana LDAP environment variables from the preset.
 */
export function getGrafanaLdapEnvVars(): Record<string, string> {
  const output = callPresetFunction('grafana', 'preset_ldap_env_vars');
  const envVars: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const match = line.match(/^(\w+)=(.+)$/);
    if (match) {
      envVars[match[1]] = match[2];
    }
  }
  return envVars;
}
