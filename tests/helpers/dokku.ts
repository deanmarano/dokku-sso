import { execSync, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// When running in VM, DOKKU_HOST should be unset or 'local' for direct execution
// When running remotely, set DOKKU_HOST to the target host
const DOKKU_HOST = process.env.DOKKU_HOST || 'local';
const DOKKU_SSH_PORT = process.env.DOKKU_SSH_PORT || '22';
// Set DOKKU_USE_SUDO=true to prefix local commands with sudo
const USE_SUDO = process.env.DOKKU_USE_SUDO === 'true';

export interface ServiceInfo {
  service: string;
  provider: string;
  status: string;
  container_name: string;
  ldap_url: string;
  base_dn: string;
  web_url: string;
  linked_apps: string;
}

export interface Credentials {
  ADMIN_PASSWORD: string;
  BIND_DN: string;
  BASE_DN: string;
  JWT_SECRET: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class DokkuAuth {
  private services: Array<{ type: 'directory' | 'frontend'; name: string }> = [];

  /** Check if running against remote Dokku */
  private isRemote(): boolean {
    return DOKKU_HOST !== 'local' && DOKKU_HOST !== 'localhost' && DOKKU_HOST !== '127.0.0.1';
  }

  /** Execute a dokku command and return exit code, stdout, stderr */
  async exec(command: string): Promise<ExecResult> {
    // Handle both "auth:create foo" and "create foo" formats
    const fullCmd = command.startsWith('auth:') ? command : `auth:${command}`;
    const localCmd = USE_SUDO ? `sudo dokku ${fullCmd}` : `dokku ${fullCmd}`;
    const cmd = this.isRemote()
      ? `ssh -o StrictHostKeyChecking=no -p ${DOKKU_SSH_PORT} dokku@${DOKKU_HOST} ${fullCmd}`
      : localCmd;

    try {
      const { stdout, stderr } = await execAsync(cmd);
      return { exitCode: 0, stdout, stderr };
    } catch (error: any) {
      return {
        exitCode: error.code || 1,
        stdout: error.stdout || '',
        stderr: error.stderr || error.message || '',
      };
    }
  }

  /** Run a dokku auth command (local or remote via SSH)
   * First arg is the subcommand (e.g., 'create', 'info'), rest are arguments
   * Becomes: dokku auth:create <service> or dokku auth:info <service>
   */
  run(...args: string[]): string {
    const [subcommand, ...rest] = args;
    const fullCmd = `auth:${subcommand}`;
    const localCmd = USE_SUDO ? `sudo dokku ${fullCmd} ${rest.join(' ')}` : `dokku ${fullCmd} ${rest.join(' ')}`;
    const cmd = this.isRemote()
      ? `ssh -o StrictHostKeyChecking=no -p ${DOKKU_SSH_PORT} dokku@${DOKKU_HOST} ${fullCmd} ${rest.join(' ')}`
      : localCmd;

    return execSync(cmd, { encoding: 'utf-8' });
  }

  /** Run a dokku command asynchronously */
  async runAsync(...args: string[]): Promise<string> {
    const [subcommand, ...rest] = args;
    const fullCmd = `auth:${subcommand}`;
    const localCmd = USE_SUDO ? `sudo dokku ${fullCmd} ${rest.join(' ')}` : `dokku ${fullCmd} ${rest.join(' ')}`;
    const cmd = this.isRemote()
      ? `ssh -o StrictHostKeyChecking=no -p ${DOKKU_SSH_PORT} dokku@${DOKKU_HOST} ${fullCmd} ${rest.join(' ')}`
      : localCmd;

    const { stdout } = await execAsync(cmd);
    return stdout;
  }

  /** Run a generic dokku command (not auth:*) */
  runDokku(...args: string[]): string {
    const localCmd = USE_SUDO ? `sudo dokku ${args.join(' ')}` : `dokku ${args.join(' ')}`;
    const cmd = this.isRemote()
      ? `ssh -o StrictHostKeyChecking=no -p ${DOKKU_SSH_PORT} dokku@${DOKKU_HOST} ${args.join(' ')}`
      : localCmd;

    return execSync(cmd, { encoding: 'utf-8' });
  }

  /** Create a directory service */
  async createDirectory(name: string, provider = 'lldap'): Promise<ServiceInfo> {
    this.run('create', name);

    if (provider !== 'lldap') {
      this.run('provider:set', name, provider);
      this.run('provider:apply', name);
    }

    this.services.push({ type: 'directory', name });
    await this.waitForHealthy(name);

    return this.getInfo(name);
  }

  /** Create a frontend service */
  async createFrontend(
    name: string,
    options: { directory?: string; provider?: string } = {}
  ): Promise<ServiceInfo> {
    this.run('frontend:create', name);

    if (options.provider && options.provider !== 'authelia') {
      this.run('frontend:provider:set', name, options.provider);
      this.run('frontend:provider:apply', name);
    }

    if (options.directory) {
      this.run('frontend:use-directory', name, options.directory);
    }

    this.services.push({ type: 'frontend', name });
    return this.getFrontendInfo(name);
  }

  /** Get service info as structured object */
  getInfo(name: string): ServiceInfo {
    const output = this.run('info', name);
    return this.parseInfoOutput(output);
  }

  /** Get frontend service info */
  getFrontendInfo(name: string): ServiceInfo {
    const output = this.run('frontend:info', name);
    return this.parseInfoOutput(output);
  }

  /** Parse key: value style output into object */
  private parseInfoOutput(output: string): ServiceInfo {
    const info: Record<string, string> = {};
    for (const line of output.split('\n')) {
      // Match "       Key: Value" format
      const match = line.match(/^\s+(\w[\w\s]*?):\s*(.*)$/);
      if (match) {
        const key = match[1].toLowerCase().replace(/\s+/g, '_');
        info[key] = match[2].trim();
      }
    }
    return info as unknown as ServiceInfo;
  }

  /** Get service credentials */
  getCredentials(name: string): Credentials {
    const output = this.run('credentials', name);
    const creds: Record<string, string> = {};

    for (const line of output.trim().split('\n')) {
      const [key, ...valueParts] = line.split('=');
      if (key) creds[key] = valueParts.join('=');
    }

    return creds as Credentials;
  }

  /** Link an app to a directory service */
  link(service: string, app: string): void {
    this.run('link', service, app);
  }

  /** Unlink an app from a directory service */
  unlink(service: string, app: string): void {
    this.run('unlink', service, app);
  }

  /** Check service status */
  status(name: string, quiet = false): number {
    try {
      const args = quiet ? ['status', name, '-q'] : ['status', name];
      this.run(...args);
      return 0;
    } catch (error: any) {
      return error.status || 1;
    }
  }

  /** Wait for service to be healthy */
  async waitForHealthy(name: string, timeoutMs = 60000): Promise<void> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      if (this.status(name, true) === 0) {
        return;
      }
      await new Promise(r => setTimeout(r, 2000));
    }

    throw new Error(`Service ${name} not healthy after ${timeoutMs}ms`);
  }

  /** Cleanup all created services */
  async cleanup(): Promise<void> {
    for (const { type, name } of [...this.services].reverse()) {
      try {
        if (type === 'frontend') {
          this.run('frontend:destroy', name, '--force');
        } else {
          this.run('destroy', name, '--force');
        }
      } catch {
        // Already destroyed
      }
    }
    this.services = [];
  }

  /** Install the plugin on the Dokku host */
  static installPlugin(sourcePath: string): void {
    if (DOKKU_HOST !== 'localhost' && DOKKU_HOST !== '127.0.0.1') {
      execSync(`scp -r -P ${DOKKU_SSH_PORT} ${sourcePath} dokku@${DOKKU_HOST}:/tmp/dokku-auth`);
      execSync(`ssh -p ${DOKKU_SSH_PORT} dokku@${DOKKU_HOST} sudo dokku plugin:install file:///tmp/dokku-auth --name auth`);
    } else {
      execSync(`sudo dokku plugin:install file://${sourcePath} --name auth`);
    }
  }
}

/** Create a test dokku app */
export async function createTestApp(name: string): Promise<string> {
  const dokku = new DokkuAuth();
  dokku.runDokku('apps:create', name);
  // Note: We don't deploy the app - linking works without a running app
  return name;
}

/** Destroy a test dokku app */
export async function destroyTestApp(name: string): Promise<void> {
  try {
    const dokku = new DokkuAuth();
    dokku.runDokku('apps:destroy', name, '--force');
  } catch {
    // Already destroyed
  }
}

/** Get app config as object */
export function getAppConfig(app: string): Record<string, string> {
  const dokku = new DokkuAuth();
  const output = dokku.runDokku('config:export', app);
  const config: Record<string, string> = {};

  for (const line of output.trim().split('\n')) {
    const match = line.match(/^export ([^=]+)='(.*)'/);
    if (match) config[match[1]] = match[2];
  }

  return config;
}
