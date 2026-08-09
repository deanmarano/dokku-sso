import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const PLUGIN_DIR = join(__dirname, '../..');
const PROVIDER_PATH = join(PLUGIN_DIR, 'providers/frontend/authelia/provider.sh');

/**
 * Run provider_protect_app against a temp service root.
 *
 * Stubs the `dokku` binary so ports:report returns a known ports map and
 * config:set is a no-op, and points DOKKU_ROOT at the temp dir so the
 * generated nginx config lands somewhere inspectable.
 */
function protectApp(root: string, service: string, app: string): string {
  const binDir = join(root, 'stub-bin');
  mkdirSync(binDir, { recursive: true });
  const dokkuStub = join(binDir, 'dokku');
  writeFileSync(
    dokkuStub,
    `#!/usr/bin/env bash
case "$1" in
  ports:report) echo "http:80:8123 https:443:8123" ;;
  *) : ;;
esac
`
  );
  chmodSync(dokkuStub, 0o755);

  const serviceRoot = join(root, 'frontend', service);
  mkdirSync(join(serviceRoot, 'config'), { recursive: true });
  writeFileSync(join(serviceRoot, 'config', 'DOMAIN'), 'auth.example.com\n');

  const cmd =
    `PLUGIN_DATA_ROOT="${root}" DOKKU_ROOT="${root}/dokku" DOKKU_BIN="${dokkuStub}" ` +
    `bash -c 'source "${PROVIDER_PATH}" && provider_protect_app "${service}" "${app}"'`;
  execSync(cmd, { encoding: 'utf-8', timeout: 20000, stdio: 'pipe' });

  return readFileSync(join(root, 'dokku', app, 'nginx.conf.d', 'forward-auth.conf'), 'utf-8');
}

function writeBypass(root: string, service: string, app: string, paths: string[]) {
  const dir = join(root, 'frontend', service, 'bypass');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, app), paths.join('\n') + '\n');
}

describe('sso:bypass path generation', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sso-bypass-test-'));
    mkdirSync(join(root, 'dokku', 'homeassistant'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('should emit no bypass locations when none are registered', () => {
    const conf = protectApp(root, 'production', 'homeassistant');

    expect(conf).toContain('location /authelia-auth');
    expect(conf).not.toContain('dokku sso:bypass');
  });

  it('should emit a location per bypass path with auth_request off', () => {
    writeBypass(root, 'production', 'homeassistant', ['/api/', '/auth/']);
    const conf = protectApp(root, 'production', 'homeassistant');

    expect(conf).toContain('location /api/ {');
    expect(conf).toContain('location /auth/ {');
    expect(conf.match(/auth_request off;/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('should re-declare the proxy so bypassed paths still reach the app', () => {
    writeBypass(root, 'production', 'homeassistant', ['/api/']);
    const conf = protectApp(root, 'production', 'homeassistant');

    // Upstream name is <app>-<container port>, matching Dokku's own template.
    expect(conf).toContain('proxy_pass http://homeassistant-8123;');
  });

  it('should keep websockets alive past the default 60s read timeout', () => {
    writeBypass(root, 'production', 'homeassistant', ['/api/']);
    const conf = protectApp(root, 'production', 'homeassistant');

    expect(conf).toContain('proxy_read_timeout 3600s;');
    expect(conf).toContain('proxy_set_header Upgrade $http_upgrade;');
  });

  it('should still protect the ACME challenge path and login redirect', () => {
    writeBypass(root, 'production', 'homeassistant', ['/api/']);
    const conf = protectApp(root, 'production', 'homeassistant');

    expect(conf).toContain('location /.well-known/acme-challenge/');
    expect(conf).toContain('location @forward_auth_login');
  });
});
