import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

const PLUGIN_DIR = join(__dirname, '../..');

describe('Plugin Configuration', () => {
  it('should have required plugin files', () => {
    expect(existsSync(join(PLUGIN_DIR, 'commands'))).toBe(true);
    expect(existsSync(join(PLUGIN_DIR, 'config'))).toBe(true);
    expect(existsSync(join(PLUGIN_DIR, 'install'))).toBe(true);
    expect(existsSync(join(PLUGIN_DIR, 'plugin.toml'))).toBe(true);
  });

  it('should have provider loader', () => {
    expect(existsSync(join(PLUGIN_DIR, 'providers/loader.sh'))).toBe(true);
  });

  it('should have LLDAP provider', () => {
    expect(existsSync(join(PLUGIN_DIR, 'providers/directory/lldap/provider.sh'))).toBe(true);
  });

  it('should have core subcommands', () => {
    const subcommands = ['create', 'destroy', 'list', 'info', 'status', 'logs', 'link', 'unlink'];
    for (const cmd of subcommands) {
      expect(existsSync(join(PLUGIN_DIR, `subcommands/${cmd}`))).toBe(true);
    }
  });

  it('commands file should be executable', () => {
    const result = execSync(`test -x ${join(PLUGIN_DIR, 'commands')} && echo yes || echo no`, {
      encoding: 'utf-8'
    });
    expect(result.trim()).toBe('yes');
  });

  it('subcommands should be executable', () => {
    const subcommands = ['create', 'destroy', 'list', 'info'];
    for (const cmd of subcommands) {
      const result = execSync(`test -x ${join(PLUGIN_DIR, `subcommands/${cmd}`)} && echo yes || echo no`, {
        encoding: 'utf-8'
      });
      expect(result.trim()).toBe('yes');
    }
  });
});
