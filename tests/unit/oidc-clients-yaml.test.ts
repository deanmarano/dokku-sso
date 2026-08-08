import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const PLUGIN_DIR = join(__dirname, '../..');
const PROVIDER_PATH = join(PLUGIN_DIR, 'providers/frontend/authelia/provider.sh');

/**
 * Run generate_oidc_clients_yaml against a temp service root.
 *
 * The real function shells out to the Authelia image to hash the client
 * secret, so a stub `docker` is placed first on PATH.
 */
function generateClientsYaml(dataRoot: string, service: string): string {
  const binDir = join(dataRoot, 'stub-bin');
  mkdirSync(binDir, { recursive: true });
  const dockerStub = join(binDir, 'docker');
  writeFileSync(dockerStub, '#!/usr/bin/env bash\necho "Digest: $argon2id$stubhash"\n');
  chmodSync(dockerStub, 0o755);

  const cmd =
    `PATH="${binDir}:$PATH" PLUGIN_DATA_ROOT="${dataRoot}" ` +
    `bash -c 'source "${PROVIDER_PATH}" && generate_oidc_clients_yaml "${service}"'`;
  return execSync(cmd, { encoding: 'utf-8', timeout: 20000 });
}

function writeClient(dataRoot: string, service: string, id: string, redirectUri: string) {
  const clientsDir = join(dataRoot, 'frontend', service, 'config', 'oidc_clients');
  mkdirSync(clientsDir, { recursive: true });
  writeFileSync(join(clientsDir, id), `SECRET=supersecret\nREDIRECT_URI=${redirectUri}\n`);
}

describe('generate_oidc_clients_yaml', () => {
  let dataRoot: string;

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'oidc-clients-test-'));
  });

  afterEach(() => {
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('should emit a single redirect_uris entry for a single URI', () => {
    writeClient(dataRoot, 'production', 'grafana', 'https://grafana.example.com/login/generic_oauth');
    const yaml = generateClientsYaml(dataRoot, 'production');

    expect(yaml).toContain('          - https://grafana.example.com/login/generic_oauth');
  });

  it('should split a comma-separated list into one entry per URI', () => {
    writeClient(
      dataRoot,
      'production',
      'immich',
      'https://immich.example.com/auth/login,https://immich.example.com/user-settings,app.immich:/'
    );
    const yaml = generateClientsYaml(dataRoot, 'production');

    expect(yaml).toContain('          - https://immich.example.com/auth/login');
    expect(yaml).toContain('          - https://immich.example.com/user-settings');
    expect(yaml).toContain('          - app.immich:/');
    // The joined form must never survive into the config: Authelia matches
    // redirect_uris exactly, so it would match no real callback.
    expect(yaml).not.toContain('/auth/login,');
  });

  it('should tolerate whitespace after commas', () => {
    writeClient(
      dataRoot,
      'production',
      'immich',
      'https://immich.example.com/auth/login, app.immich:/'
    );
    const yaml = generateClientsYaml(dataRoot, 'production');

    expect(yaml).toContain('          - https://immich.example.com/auth/login');
    expect(yaml).toContain('          - app.immich:/');
    expect(yaml).not.toMatch(/- {2,}app\.immich/);
  });

  it('should keep redirect_uris under the owning client', () => {
    writeClient(dataRoot, 'production', 'immich', 'https://immich.example.com/auth/login,app.immich:/');
    const yaml = generateClientsYaml(dataRoot, 'production');

    const lines = yaml.split('\n');
    const clientIdx = lines.findIndex((l) => l.includes('client_id: immich'));
    const redirectIdx = lines.findIndex((l) => l.trim() === 'redirect_uris:');
    const scopesIdx = lines.findIndex((l) => l.trim() === 'scopes:');

    expect(clientIdx).toBeGreaterThanOrEqual(0);
    expect(redirectIdx).toBeGreaterThan(clientIdx);
    expect(scopesIdx).toBeGreaterThan(redirectIdx);
    // Both URIs sit between redirect_uris: and scopes:
    expect(scopesIdx - redirectIdx).toBe(3);
  });
});
