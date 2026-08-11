import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const PLUGIN_DIR = join(__dirname, '../..');

/**
 * Byte-for-byte snapshots of the nginx config that protecting an app produces.
 *
 * These exist to make moving the nginx logic out of the Authelia provider and
 * into a proxy adapter safe: the snapshots were taken against the code before
 * the move, so any difference afterwards is a behaviour change, not a
 * refactor. Nothing here depends on the environment -- the generated config
 * embeds no absolute paths -- so the comparison can be exact.
 *
 * If a snapshot changes, that is a real change to how protected apps are
 * served. Read the diff before updating it.
 */
function protect(
  root: string,
  opts: { bypassPaths?: string[]; app?: string; service?: string } = {},
): { conf: string; directives: string } {
  const { bypassPaths, app = 'myapp', service = 'production' } = opts;

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
`,
  );
  chmodSync(dokkuStub, 0o755);

  const serviceRoot = join(root, 'frontend', service);
  mkdirSync(join(serviceRoot, 'config'), { recursive: true });
  writeFileSync(join(serviceRoot, 'config', 'DOMAIN'), 'auth.example.com\n');

  if (bypassPaths) {
    mkdirSync(join(serviceRoot, 'bypass'), { recursive: true });
    writeFileSync(join(serviceRoot, 'bypass', app), bypassPaths.join('\n') + '\n');
  }

  execSync(
    `PLUGIN_DATA_ROOT="${root}" DOKKU_ROOT="${root}/dokku" DOKKU_BIN="${dokkuStub}" ` +
      `bash -c 'source "${PLUGIN_DIR}/providers/loader.sh"; source "${PLUGIN_DIR}/providers/frontend/authelia/provider.sh" && ` +
      `provider_protect_app "${service}" "${app}"'`,
    { encoding: 'utf-8', timeout: 20000, stdio: 'pipe' },
  );

  const confDir = join(root, 'dokku', app, 'nginx.conf.d');
  return {
    conf: readFileSync(join(confDir, 'forward-auth.conf'), 'utf-8'),
    directives: readFileSync(join(confDir, 'forward-auth.directives'), 'utf-8'),
  };
}

describe('nginx protection output', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sso-nginx-golden-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('generates the server-level config for a protected app', () => {
    expect(protect(root).conf).toMatchSnapshot();
  });

  it('generates the directives injected into location /', () => {
    expect(protect(root).directives).toMatchSnapshot();
  });

  it('generates bypass locations for exempted paths', () => {
    expect(protect(root, { bypassPaths: ['/api/', '/feed/'] }).conf).toMatchSnapshot();
  });

  it('leaves the injected directives alone when paths are bypassed', () => {
    // Bypass changes the server-level config only; what goes into location /
    // is the same either way.
    const withBypass = protect(root, { bypassPaths: ['/api/'] });
    rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), 'sso-nginx-golden-'));
    const without = protect(root);

    expect(withBypass.directives).toBe(without.directives);
  });
});
