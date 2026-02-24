import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const PLUGIN_DIR = join(__dirname, '../..');
const TRIGGER_SCRIPT = join(PLUGIN_DIR, 'nginx-pre-reload');

/**
 * Runs the nginx-pre-reload trigger against a temp directory structure.
 * Replaces the hardcoded PLUGIN_DATA_ROOT with the test's temp path.
 */
function runTrigger(tmpDir: string, app: string): { exitCode: number; stdout: string; stderr: string } {
  const dokkuRoot = join(tmpDir, 'dokku');
  const servicesRoot = join(tmpDir, 'services');

  // Create a modified version of the trigger with test paths
  const script = readFileSync(TRIGGER_SCRIPT, 'utf-8')
    .replace(
      'local PLUGIN_DATA_ROOT="/var/lib/dokku/services"',
      `local PLUGIN_DATA_ROOT="${servicesRoot}"`
    )
    .replace(
      'source "$PLUGIN_CORE_AVAILABLE_PATH/common/functions" 2>/dev/null || true',
      '# sourcing disabled for test'
    );

  const testScript = join(tmpDir, 'nginx-pre-reload-test');
  writeFileSync(testScript, script, { mode: 0o755 });

  try {
    const stdout = execSync(`bash "${testScript}" "${app}"`, {
      encoding: 'utf-8',
      env: { ...process.env, DOKKU_ROOT: dokkuRoot },
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (e: any) {
    return {
      exitCode: e.status ?? 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
}

/**
 * Sets up a temp directory with the expected dokku structure.
 */
function setupTestDir() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'nginx-pre-reload-test-'));
  const dokkuRoot = join(tmpDir, 'dokku');
  const servicesRoot = join(tmpDir, 'services');
  mkdirSync(dokkuRoot, { recursive: true });
  mkdirSync(servicesRoot, { recursive: true });
  return { tmpDir, dokkuRoot, servicesRoot };
}

/**
 * Creates an app with an nginx.conf and optionally a forward-auth.conf.
 */
function createApp(
  dokkuRoot: string,
  appName: string,
  nginxConf: string,
  forwardAuthConf?: string
) {
  const appDir = join(dokkuRoot, appName);
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, 'nginx.conf'), nginxConf);

  if (forwardAuthConf) {
    const confDir = join(appDir, 'nginx.conf.d');
    mkdirSync(confDir, { recursive: true });
    writeFileSync(join(confDir, 'forward-auth.conf'), forwardAuthConf);
  }
}

/**
 * Creates a frontend service with a PROTECTED file listing the given apps.
 */
function createFrontendService(
  servicesRoot: string,
  serviceName: string,
  protectedApps: string[]
) {
  const serviceDir = join(servicesRoot, 'sso', 'frontend', serviceName);
  mkdirSync(serviceDir, { recursive: true });
  if (protectedApps.length > 0) {
    writeFileSync(join(serviceDir, 'PROTECTED'), protectedApps.join('\n') + '\n');
  }
}

// Sample nginx.conf that matches Dokku's default template structure
const SAMPLE_NGINX_CONF = `server {
  listen      [::]:80;
  listen      80;
  server_name myapp.example.com;

  include /home/dokku/myapp/nginx.conf.d/*.conf;
  location / {
    return 301 https://\\$host:443\\$request_uri;
  }
}

server {
  listen      [::]:443 ssl http2;
  listen      443 ssl http2;
  server_name myapp.example.com;

  location    / {
    proxy_pass  http://myapp-5000;
  }

  error_page 400 402 403 /400-error.html;
  location /400-error.html {
    root /var/lib/dokku/data/nginx-vhosts/dokku-errors;
    internal;
  }

  error_page 404 /404-error.html;
  location /404-error.html {
    root /var/lib/dokku/data/nginx-vhosts/dokku-errors;
    internal;
  }

  error_page 500 501 503 504 /500-error.html;
  location /500-error.html {
    root /var/lib/dokku/data/nginx-vhosts/dokku-errors;
    internal;
  }

  error_page 502 /502-error.html;
  location /502-error.html {
    root /var/lib/dokku/data/nginx-vhosts/dokku-errors;
    internal;
  }
  include /home/dokku/myapp/nginx.conf.d/*.conf;
}`;

const AUTHELIA_FORWARD_AUTH_CONF = `# Authelia forward auth - managed by dokku-sso plugin
# Server-level locations
location /authelia-auth {
    internal;
    proxy_pass https://auth.example.com/api/authz/auth-request;
    proxy_pass_request_body off;
    proxy_ssl_verify off;
    proxy_set_header Content-Length "";
    proxy_set_header X-Original-Method $request_method;
    proxy_set_header X-Original-URL $scheme://$http_host$request_uri;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header X-Forwarded-Uri $request_uri;
}

location @forward_auth_login {
    auth_request off;
    return 302 https://auth.example.com/?rd=$scheme://$http_host$request_uri;
}

# Directives below are injected into location / by the nginx-pre-reload trigger
auth_request /authelia-auth;
auth_request_set $authelia_user $upstream_http_remote_user;
auth_request_set $authelia_groups $upstream_http_remote_groups;
auth_request_set $authelia_name $upstream_http_remote_name;
auth_request_set $authelia_email $upstream_http_remote_email;
error_page 401 = @forward_auth_login;`;

const AUTHENTIK_FORWARD_AUTH_CONF = `# Authentik forward auth - managed by dokku-sso plugin
# Server-level locations
location /outpost.goauthentik.io {
    internal;
    proxy_pass https://authentik.example.com/outpost.goauthentik.io/auth/nginx;
    proxy_pass_request_body off;
    proxy_ssl_verify off;
    proxy_set_header Content-Length "";
    proxy_set_header X-Original-Method $request_method;
    proxy_set_header X-Original-URL $scheme://$http_host$request_uri;
}

location @forward_auth_login {
    auth_request off;
    return 302 https://authentik.example.com/outpost.goauthentik.io/start?rd=$scheme://$http_host$request_uri;
}

# Directives below are injected into location / by the nginx-pre-reload trigger
auth_request /outpost.goauthentik.io;
auth_request_set $authentik_user $upstream_http_remote_user;
auth_request_set $authentik_groups $upstream_http_remote_groups;
auth_request_set $authentik_name $upstream_http_remote_name;
auth_request_set $authentik_email $upstream_http_remote_email;
error_page 401 = @forward_auth_login;`;

describe('nginx-pre-reload trigger', () => {
  let tmpDir: string;
  let dokkuRoot: string;
  let servicesRoot: string;

  beforeEach(() => {
    ({ tmpDir, dokkuRoot, servicesRoot } = setupTestDir());
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should be executable', () => {
    const result = execSync(`test -x "${TRIGGER_SCRIPT}" && echo yes || echo no`, {
      encoding: 'utf-8',
    });
    expect(result.trim()).toBe('yes');
  });

  it('should exit cleanly when no app is provided', () => {
    const result = runTrigger(tmpDir, '');
    expect(result.exitCode).toBe(0);
  });

  it('should exit cleanly when app has no nginx.conf', () => {
    mkdirSync(join(dokkuRoot, 'myapp'), { recursive: true });
    const result = runTrigger(tmpDir, 'myapp');
    expect(result.exitCode).toBe(0);
  });

  it('should exit cleanly when app is not protected', () => {
    createApp(dokkuRoot, 'myapp', SAMPLE_NGINX_CONF);
    const result = runTrigger(tmpDir, 'myapp');
    expect(result.exitCode).toBe(0);

    // nginx.conf should be unmodified
    const conf = readFileSync(join(dokkuRoot, 'myapp', 'nginx.conf'), 'utf-8');
    expect(conf).toBe(SAMPLE_NGINX_CONF);
  });

  it('should exit cleanly when app is protected but forward-auth.conf is missing', () => {
    createApp(dokkuRoot, 'myapp', SAMPLE_NGINX_CONF);
    createFrontendService(servicesRoot, 'auth-service', ['myapp']);
    const result = runTrigger(tmpDir, 'myapp');
    expect(result.exitCode).toBe(0);

    // nginx.conf should be unmodified
    const conf = readFileSync(join(dokkuRoot, 'myapp', 'nginx.conf'), 'utf-8');
    expect(conf).toBe(SAMPLE_NGINX_CONF);
  });

  describe('Authelia injection', () => {
    it('should inject auth directives into location / blocks', () => {
      createApp(dokkuRoot, 'myapp', SAMPLE_NGINX_CONF, AUTHELIA_FORWARD_AUTH_CONF);
      createFrontendService(servicesRoot, 'auth-service', ['myapp']);

      const result = runTrigger(tmpDir, 'myapp');
      expect(result.exitCode).toBe(0);

      const conf = readFileSync(join(dokkuRoot, 'myapp', 'nginx.conf'), 'utf-8');

      // auth_request should be injected into location / blocks
      expect(conf).toContain('auth_request /authelia-auth;');
      expect(conf).toContain('auth_request_set $authelia_user $upstream_http_remote_user;');
      expect(conf).toContain('auth_request_set $authelia_groups $upstream_http_remote_groups;');
      expect(conf).toContain('auth_request_set $authelia_name $upstream_http_remote_name;');
      expect(conf).toContain('auth_request_set $authelia_email $upstream_http_remote_email;');
      expect(conf).toContain('error_page 401 = @forward_auth_login;');
    });

    it('should inject into both HTTP and HTTPS location / blocks', () => {
      createApp(dokkuRoot, 'myapp', SAMPLE_NGINX_CONF, AUTHELIA_FORWARD_AUTH_CONF);
      createFrontendService(servicesRoot, 'auth-service', ['myapp']);

      runTrigger(tmpDir, 'myapp');

      const conf = readFileSync(join(dokkuRoot, 'myapp', 'nginx.conf'), 'utf-8');

      // Count occurrences of auth_request injection - should appear in both location / blocks
      const matches = conf.match(/auth_request \/authelia-auth;/g);
      expect(matches).not.toBeNull();
      expect(matches!.length).toBe(2);
    });

    it('should add auth_request off to error page locations', () => {
      createApp(dokkuRoot, 'myapp', SAMPLE_NGINX_CONF, AUTHELIA_FORWARD_AUTH_CONF);
      createFrontendService(servicesRoot, 'auth-service', ['myapp']);

      runTrigger(tmpDir, 'myapp');

      const conf = readFileSync(join(dokkuRoot, 'myapp', 'nginx.conf'), 'utf-8');

      // Each error page location should have auth_request off
      const errorLocations = ['400-error.html', '404-error.html', '500-error.html', '502-error.html'];
      for (const loc of errorLocations) {
        const pattern = new RegExp(`location /${loc} \\{\\n\\s+auth_request off;`);
        expect(conf).toMatch(pattern);
      }
    });

    it('should indent injected directives correctly', () => {
      createApp(dokkuRoot, 'myapp', SAMPLE_NGINX_CONF, AUTHELIA_FORWARD_AUTH_CONF);
      createFrontendService(servicesRoot, 'auth-service', ['myapp']);

      runTrigger(tmpDir, 'myapp');

      const conf = readFileSync(join(dokkuRoot, 'myapp', 'nginx.conf'), 'utf-8');
      const lines = conf.split('\n');

      // Find injected auth_request lines and check they have 4-space indent
      const authRequestLines = lines.filter(l => l.includes('auth_request /authelia-auth;'));
      for (const line of authRequestLines) {
        expect(line).toMatch(/^\s{4}auth_request \/authelia-auth;/);
      }
    });
  });

  describe('Authentik injection', () => {
    it('should inject Authentik auth directives into location / blocks', () => {
      createApp(dokkuRoot, 'myapp', SAMPLE_NGINX_CONF, AUTHENTIK_FORWARD_AUTH_CONF);
      createFrontendService(servicesRoot, 'auth-service', ['myapp']);

      const result = runTrigger(tmpDir, 'myapp');
      expect(result.exitCode).toBe(0);

      const conf = readFileSync(join(dokkuRoot, 'myapp', 'nginx.conf'), 'utf-8');

      expect(conf).toContain('auth_request /outpost.goauthentik.io;');
      expect(conf).toContain('auth_request_set $authentik_user $upstream_http_remote_user;');
      expect(conf).toContain('error_page 401 = @forward_auth_login;');
    });
  });

  describe('duplicate detection', () => {
    it('should skip injection if auth_request /authelia-auth already in nginx.conf', () => {
      const confWithAuth = SAMPLE_NGINX_CONF.replace(
        'proxy_pass  http://myapp-5000;',
        'auth_request /authelia-auth;\n    proxy_pass  http://myapp-5000;'
      );
      createApp(dokkuRoot, 'myapp', confWithAuth, AUTHELIA_FORWARD_AUTH_CONF);
      createFrontendService(servicesRoot, 'auth-service', ['myapp']);

      runTrigger(tmpDir, 'myapp');

      const conf = readFileSync(join(dokkuRoot, 'myapp', 'nginx.conf'), 'utf-8');

      // Should only have the one we put in, not additional injections
      const matches = conf.match(/auth_request \/authelia-auth;/g);
      expect(matches!.length).toBe(1);
    });

    it('should skip injection if auth_request /outpost already in nginx.conf', () => {
      const confWithAuth = SAMPLE_NGINX_CONF.replace(
        'proxy_pass  http://myapp-5000;',
        'auth_request /outpost.goauthentik.io;\n    proxy_pass  http://myapp-5000;'
      );
      createApp(dokkuRoot, 'myapp', confWithAuth, AUTHENTIK_FORWARD_AUTH_CONF);
      createFrontendService(servicesRoot, 'auth-service', ['myapp']);

      runTrigger(tmpDir, 'myapp');

      const conf = readFileSync(join(dokkuRoot, 'myapp', 'nginx.conf'), 'utf-8');

      const matches = conf.match(/auth_request \/outpost/g);
      expect(matches!.length).toBe(1);
    });
  });

  describe('directive extraction', () => {
    it('should not extract auth_request off from inside location blocks', () => {
      createApp(dokkuRoot, 'myapp', SAMPLE_NGINX_CONF, AUTHELIA_FORWARD_AUTH_CONF);
      createFrontendService(servicesRoot, 'auth-service', ['myapp']);

      runTrigger(tmpDir, 'myapp');

      const conf = readFileSync(join(dokkuRoot, 'myapp', 'nginx.conf'), 'utf-8');

      // The injected block should NOT contain "auth_request off"
      // (that's from @forward_auth_login location, should not be extracted)
      const lines = conf.split('\n');
      const locationSlashBlocks: string[] = [];
      let inLocationSlash = false;
      let braceDepth = 0;

      for (const line of lines) {
        if (/location\s+\/\s*\{/.test(line) || /location\s{4}\/\s*\{/.test(line)) {
          inLocationSlash = true;
          braceDepth = 1;
          continue;
        }
        if (inLocationSlash) {
          if (line.includes('{')) braceDepth++;
          if (line.includes('}')) braceDepth--;
          if (braceDepth === 0) {
            inLocationSlash = false;
            continue;
          }
          locationSlashBlocks.push(line);
        }
      }

      const injectedLines = locationSlashBlocks.filter(l => l.trim().startsWith('auth_request'));
      // Should have auth_request /authelia-auth but NOT auth_request off
      expect(injectedLines.some(l => l.includes('auth_request /authelia-auth'))).toBe(true);
      expect(injectedLines.some(l => l.includes('auth_request off'))).toBe(false);
    });
  });

  describe('multiple services', () => {
    it('should find app protected by any frontend service', () => {
      createApp(dokkuRoot, 'myapp', SAMPLE_NGINX_CONF, AUTHELIA_FORWARD_AUTH_CONF);
      // App is protected by the second service, not the first
      createFrontendService(servicesRoot, 'service-a', ['other-app']);
      createFrontendService(servicesRoot, 'service-b', ['myapp']);

      const result = runTrigger(tmpDir, 'myapp');
      expect(result.exitCode).toBe(0);

      const conf = readFileSync(join(dokkuRoot, 'myapp', 'nginx.conf'), 'utf-8');
      expect(conf).toContain('auth_request /authelia-auth;');
    });

    it('should not inject when app is not in any PROTECTED file', () => {
      createApp(dokkuRoot, 'myapp', SAMPLE_NGINX_CONF, AUTHELIA_FORWARD_AUTH_CONF);
      createFrontendService(servicesRoot, 'service-a', ['other-app']);
      createFrontendService(servicesRoot, 'service-b', ['another-app']);

      runTrigger(tmpDir, 'myapp');

      const conf = readFileSync(join(dokkuRoot, 'myapp', 'nginx.conf'), 'utf-8');
      expect(conf).not.toContain('auth_request');
    });
  });

  describe('location matching', () => {
    it('should inject into location / with varying whitespace', () => {
      // Dokku generates "location    / {" (with extra spaces)
      const confWithSpaces = SAMPLE_NGINX_CONF.replace(
        'location    / {',
        'location      / {'
      );
      createApp(dokkuRoot, 'myapp', confWithSpaces, AUTHELIA_FORWARD_AUTH_CONF);
      createFrontendService(servicesRoot, 'auth-service', ['myapp']);

      runTrigger(tmpDir, 'myapp');

      const conf = readFileSync(join(dokkuRoot, 'myapp', 'nginx.conf'), 'utf-8');
      expect(conf).toContain('auth_request /authelia-auth;');
    });

    it('should not inject into non-root location blocks', () => {
      createApp(dokkuRoot, 'myapp', SAMPLE_NGINX_CONF, AUTHELIA_FORWARD_AUTH_CONF);
      createFrontendService(servicesRoot, 'auth-service', ['myapp']);

      runTrigger(tmpDir, 'myapp');

      const conf = readFileSync(join(dokkuRoot, 'myapp', 'nginx.conf'), 'utf-8');

      // error page locations should NOT have auth_request /authelia-auth injected
      // They should only have auth_request off
      const lines = conf.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('-error.html {')) {
          // Next line should be auth_request off, not auth_request /authelia-auth
          expect(lines[i + 1].trim()).toBe('auth_request off;');
        }
      }
    });
  });
});
