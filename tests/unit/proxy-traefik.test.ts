import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const PLUGIN_DIR = join(__dirname, '../..');

/**
 * Drive the Traefik adapter against a stubbed `dokku` and `docker`.
 *
 * Traefik protection is entirely labels, so the labels are the behaviour: the
 * stub records every `traefik:labels:add/remove` call and the assertions below
 * are on that record.
 */
interface Run {
  exitCode: number;
  stdout: string;
  labels: Record<string, string>;
  removed: string[];
  dockerCalls: string[];
}

function runAdapter(
  fn: 'protect' | 'unprotect',
  opts: { bypassPaths?: string[]; deployed?: boolean; traefikOnNetwork?: boolean } = {},
): Run {
  const { bypassPaths, deployed = true, traefikOnNetwork = false } = opts;
  const root = mkdtempSync(join(tmpdir(), 'sso-traefik-'));
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });

  const labelLog = join(root, 'labels.log');
  const dockerLog = join(root, 'docker.log');

  writeFileSync(
    join(binDir, 'dokku'),
    `#!/usr/bin/env bash
case "$1" in
  traefik:labels:add)    echo "ADD $2 $3 $4" >> ${labelLog} ;;
  traefik:labels:remove) echo "REMOVE $2 $3" >> ${labelLog} ;;
  traefik:labels:show)   cat ${labelLog} 2>/dev/null || true ;;
  domains:report)        echo "app.example.com" ;;
  ps:report)             echo "${deployed}" ;;
  ps:rebuild)            echo "REBUILT $2" >> ${labelLog} ;;
  *) : ;;
esac
`,
  );
  writeFileSync(
    join(binDir, 'docker'),
    `#!/usr/bin/env bash
echo "$@" >> ${dockerLog}
case "$1" in
  ps)      echo "traefik-container" ;;
  network) ${traefikOnNetwork ? 'echo "traefik-container other"' : 'echo "other"'} ;;
esac
`,
  );
  chmodSync(join(binDir, 'dokku'), 0o755);
  chmodSync(join(binDir, 'docker'), 0o755);

  const descriptor = join(root, 'descriptor');
  writeFileSync(
    descriptor,
    [
      'service=production',
      'auth_domain=auth.example.com',
      'auth_app=authelia',
      'auth_scheme=https',
      'internal_host=authelia.web',
      'internal_port=9091',
      'forward_auth_path=/api/authz/forward-auth',
      'response_headers=Remote-User,Remote-Groups,Remote-Email,Remote-Name',
      '',
    ].join('\n'),
  );

  const bypassFile = join(root, 'bypass');
  if (bypassPaths) writeFileSync(bypassFile, bypassPaths.join('\n') + '\n');

  const call =
    fn === 'protect'
      ? `proxy_protect_app myapp "${descriptor}" "${bypassFile}"`
      : `proxy_unprotect_app myapp`;

  const r = spawnSync(
    'bash',
    [
      '-c',
      `export PATH="${binDir}:$PATH" DOKKU_BIN="${binDir}/dokku" SSO_NETWORK=dokku.sso.network; ` +
        `source "${PLUGIN_DIR}/providers/loader.sh"; ` +
        `source "${PLUGIN_DIR}/providers/proxy/traefik/proxy.sh"; ${call}`,
    ],
    { encoding: 'utf-8' },
  );

  const log = existsSync(labelLog) ? readFileSync(labelLog, 'utf-8') : '';
  const labels: Record<string, string> = {};
  const removed: string[] = [];
  for (const line of log.split('\n')) {
    const add = line.match(/^ADD \S+ (\S+) (.*)$/);
    if (add) labels[add[1]] = add[2];
    const rm = line.match(/^REMOVE \S+ (\S+)$/);
    if (rm) removed.push(rm[1]);
  }

  const result: Run = {
    exitCode: r.status ?? 1,
    stdout: (r.stdout ?? '') + (r.stderr ?? '') + log,
    labels,
    removed,
    dockerCalls: existsSync(dockerLog) ? readFileSync(dockerLog, 'utf-8').split('\n') : [],
  };
  rmSync(root, { recursive: true, force: true });
  return result;
}

describe('traefik adapter: protecting an app', () => {
  let run: Run;
  beforeEach(() => {
    run = runAdapter('protect');
  });

  it('defines the forwardAuth middleware on the auth app', () => {
    expect(run.labels['traefik.http.middlewares.sso-production.forwardauth.address']).toBe(
      'http://authelia.web:9091/api/authz/forward-auth',
    );
    expect(run.labels['traefik.http.middlewares.sso-production.forwardauth.trustForwardHeader']).toBe('true');
    expect(run.labels['traefik.http.middlewares.sso-production.forwardauth.authResponseHeaders']).toBe(
      'Remote-User,Remote-Groups,Remote-Email,Remote-Name',
    );
  });

  it('addresses the auth app internally, never by its public URL', () => {
    // Going via the public name is the NAT hairpin the nginx adapter had to
    // work around; it hangs on hosts whose router will not route back to them.
    const address = run.labels['traefik.http.middlewares.sso-production.forwardauth.address'];
    expect(address).not.toContain('auth.example.com');
    expect(address).toContain('authelia.web');
  });

  it('attaches the middleware to BOTH routers', () => {
    // Traefik only redirects http to https when a letsencrypt email is set, so
    // protecting only the https router can leave plain http wide open.
    expect(run.labels['traefik.http.routers.myapp-web-https.middlewares']).toBe('sso-production@docker');
    expect(run.labels['traefik.http.routers.myapp-web-http.middlewares']).toBe('sso-production@docker');
  });

  it('rebuilds the app, since labels only apply to a new container', () => {
    expect(run.stdout).toContain('REBUILT myapp');
  });

  it('attaches traefik to the sso network so it can reach the auth app', () => {
    expect(run.dockerCalls.join('\n')).toContain('network connect dokku.sso.network traefik-container');
  });

  it('does not re-attach a traefik that is already on the network', () => {
    const already = runAdapter('protect', { traefikOnNetwork: true });
    expect(already.dockerCalls.join('\n')).not.toContain('network connect');
  });

  it('skips the rebuild for an app that is not deployed', () => {
    const undeployed = runAdapter('protect', { deployed: false });
    expect(undeployed.stdout).not.toContain('REBUILT');
    expect(undeployed.stdout).toContain('applies on its first deploy');
  });
});

describe('traefik adapter: bypass paths', () => {
  it('adds a higher-priority router with no middleware attached', () => {
    const run = runAdapter('protect', { bypassPaths: ['/api/', '/feed/'] });

    expect(run.labels['traefik.http.routers.myapp-sso-bypass.rule']).toBe(
      '(Host(`app.example.com`)) && (PathPrefix(`/api/`) || PathPrefix(`/feed/`))',
    );
    expect(run.labels['traefik.http.routers.myapp-sso-bypass.priority']).toBe('100');
    expect(run.labels['traefik.http.routers.myapp-sso-bypass.service']).toBe('myapp-web-https');
    // The whole point: this router must not carry the auth middleware.
    expect(run.labels['traefik.http.routers.myapp-sso-bypass.middlewares']).toBeUndefined();
  });

  it('clears the bypass router when no paths are configured', () => {
    const run = runAdapter('protect');
    expect(run.removed).toContain('traefik.http.routers.myapp-sso-bypass.rule');
    expect(run.labels['traefik.http.routers.myapp-sso-bypass.rule']).toBeUndefined();
  });
});

describe('traefik adapter: unprotecting an app', () => {
  it('removes the middleware from both routers and clears the bypass router', () => {
    const run = runAdapter('unprotect');

    expect(run.removed).toContain('traefik.http.routers.myapp-web-https.middlewares');
    expect(run.removed).toContain('traefik.http.routers.myapp-web-http.middlewares');
    expect(run.removed).toContain('traefik.http.routers.myapp-sso-bypass.rule');
    expect(run.removed).toContain('traefik.http.routers.myapp-sso-bypass.priority');
  });

  it('rebuilds so the running container loses the middleware', () => {
    expect(runAdapter('unprotect').stdout).toContain('REBUILT myapp');
  });
});
