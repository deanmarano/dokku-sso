import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const PLUGIN_DIR = join(__dirname, '../..');

/** Select an adapter for an app whose proxy the stub reports as `proxy`. */
function load(proxy: string): { exitCode: number; out: string } {
  const root = mkdtempSync(join(tmpdir(), 'sso-loader-'));
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'dokku'), `#!/usr/bin/env bash\necho "${proxy}"\n`);
  chmodSync(join(bin, 'dokku'), 0o755);

  const r = spawnSync(
    'bash',
    [
      '-c',
      `export DOKKU_BIN="${bin}/dokku"; source "${PLUGIN_DIR}/providers/loader.sh"; ` +
        `load_proxy_adapter myapp && echo "LOADED=$PROXY_NAME"`,
    ],
    { encoding: 'utf-8' },
  );
  rmSync(root, { recursive: true, force: true });
  return { exitCode: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

describe('load_proxy_adapter', () => {
  it('loads the nginx adapter for an nginx app', () => {
    const r = load('nginx');
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain('LOADED=nginx');
  });

  it('loads the traefik adapter for a traefik app', () => {
    const r = load('traefik');
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain('LOADED=traefik');
  });

  it('falls back to nginx when the proxy cannot be determined', () => {
    const r = load('');
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain('LOADED=nginx');
  });

  it('refuses a proxy it has no adapter for, and says the app is exposed', () => {
    // Silently doing nothing here is what let apps sit unprotected; the
    // caller must be able to fail on this.
    const r = load('caddy');
    expect(r.exitCode).not.toBe(0);
    expect(r.out).toContain('caddy');
    expect(r.out).toContain('without authentication');
    expect(r.out).toMatch(/Supported:.*nginx/);
  });
});
