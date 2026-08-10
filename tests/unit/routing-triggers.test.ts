import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const PLUGIN_DIR = join(__dirname, '../..');

/**
 * These triggers are consumed by dokku-routing, which parses them as
 * tab-separated fields. The shape matters as much as the content, so the
 * tests assert on exact columns rather than substrings.
 */
function runTrigger(
  name: string,
  tmpDir: string,
  ...args: string[]
): { exitCode: number; stdout: string } {
  try {
    const stdout = execFileSync(join(PLUGIN_DIR, name), args, {
      encoding: 'utf-8',
      env: {
        ...process.env,
        DOKKU_LIB_ROOT: tmpDir,
        DOKKU_ROOT: join(tmpDir, 'dokku'),
      },
    });
    return { exitCode: 0, stdout };
  } catch (e: any) {
    return { exitCode: e.status ?? 1, stdout: e.stdout ?? '' };
  }
}

const SERVICE = 'production';
const PROTECTED_APP = 'protected-app';
const OPEN_APP = 'open-app';

describe('routing triggers', () => {
  let tmpDir: string;
  let serviceRoot: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sso-routing-'));
    serviceRoot = join(tmpDir, 'services/sso/frontend', SERVICE);
    mkdirSync(join(serviceRoot, 'config'), { recursive: true });
    mkdirSync(join(serviceRoot, 'bypass'), { recursive: true });
    writeFileSync(join(serviceRoot, 'PROTECTED'), `${PROTECTED_APP}\n`);
    writeFileSync(join(serviceRoot, 'PROVIDER'), 'authelia\n');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('routing-app-capabilities', () => {
    it('declares forward auth for a protected app', () => {
      const { exitCode, stdout } = runTrigger('routing-app-capabilities', tmpDir, PROTECTED_APP);
      expect(exitCode).toBe(0);

      const [capability, detail, source] = stdout.trim().split('\n')[0].split('\t');
      expect(capability).toBe('forward-auth');
      expect(detail).toBe(`${SERVICE} via authelia`);
      expect(source).toBe('sso:protect');
    });

    it('says nothing about an app it does not protect', () => {
      const { exitCode, stdout } = runTrigger('routing-app-capabilities', tmpDir, OPEN_APP);
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe('');
    });

    it('says nothing when given no app', () => {
      const { exitCode, stdout } = runTrigger('routing-app-capabilities', tmpDir);
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe('');
    });

    it('reports bypass paths, which the next proxy has to reproduce', () => {
      writeFileSync(join(serviceRoot, 'bypass', PROTECTED_APP), '/api/*\n/feed/*\n');

      const { stdout } = runTrigger('routing-app-capabilities', tmpDir, PROTECTED_APP);
      const bypass = stdout
        .trim()
        .split('\n')
        .map((l) => l.split('\t'))
        .find((f) => f[0] === 'vendor-settings');

      expect(bypass).toBeDefined();
      expect(bypass![1]).toBe('auth bypass for /api/* /feed/*');
      expect(bypass![2]).toBe('sso:bypass');
    });

    it('omits bypass when none is configured', () => {
      const { stdout } = runTrigger('routing-app-capabilities', tmpDir, PROTECTED_APP);
      expect(stdout).not.toContain('vendor-settings');
    });

    it('prefers config/FRONTEND_PROVIDER when present', () => {
      writeFileSync(join(serviceRoot, 'config/FRONTEND_PROVIDER'), 'authentik\n');

      const { stdout } = runTrigger('routing-app-capabilities', tmpDir, PROTECTED_APP);
      expect(stdout).toContain(`${SERVICE} via authentik`);
    });

    it('emits exactly three tab-separated fields per line', () => {
      writeFileSync(join(serviceRoot, 'bypass', PROTECTED_APP), '/api/*\n');

      const { stdout } = runTrigger('routing-app-capabilities', tmpDir, PROTECTED_APP);
      for (const line of stdout.trim().split('\n')) {
        expect(line.split('\t')).toHaveLength(3);
      }
    });
  });

  describe('routing-owned-config', () => {
    it('claims the files it generates for a protected app', () => {
      const { exitCode, stdout } = runTrigger('routing-owned-config', tmpDir, PROTECTED_APP);
      expect(exitCode).toBe(0);

      const paths = stdout.trim().split('\n');
      expect(paths).toContain(
        join(tmpDir, 'dokku', PROTECTED_APP, 'nginx.conf.d/forward-auth.conf')
      );
      expect(paths).toContain(
        join(tmpDir, 'dokku', PROTECTED_APP, 'nginx.conf.d/forward-auth.directives')
      );
    });

    it('claims nothing for an app it does not protect', () => {
      const { exitCode, stdout } = runTrigger('routing-owned-config', tmpDir, OPEN_APP);
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe('');
    });

    it('only ever emits absolute paths', () => {
      const { stdout } = runTrigger('routing-owned-config', tmpDir, PROTECTED_APP);
      for (const line of stdout.trim().split('\n')) {
        expect(line.startsWith('/')).toBe(true);
      }
    });
  });

  describe('routing-proxy-support', () => {
    it('supports nginx and nothing else, since the hook is nginx-only', () => {
      const { exitCode, stdout } = runTrigger('routing-proxy-support', tmpDir);
      expect(exitCode).toBe(0);

      const rows = stdout
        .trim()
        .split('\n')
        .map((l) => l.split('\t'));
      const support = Object.fromEntries(rows.map((f) => [f[1], f[2]]));

      expect(support.nginx).toBe('full');
      expect(support.traefik).toBe('none');
      expect(support.caddy).toBe('none');
      expect(support.openresty).toBe('none');
      expect(support.haproxy).toBe('none');
    });

    it('emits four tab-separated fields naming this plugin', () => {
      const { stdout } = runTrigger('routing-proxy-support', tmpDir);
      for (const line of stdout.trim().split('\n')) {
        const fields = line.split('\t');
        expect(fields).toHaveLength(4);
        expect(fields[0]).toBe('sso');
        expect(fields[3]).not.toBe('');
      }
    });
  });
});
