import { describe, it, expect } from 'vitest';
import { pluginListHas } from '../e2e/helpers';

// Real `dokku plugin:list` output: name, version, state, description.
const LIST = `  00_dokku-standard    0.38.25 enabled    dokku core standard plugin
  apps                 0.38.25 enabled    dokku core apps plugin
  letsencrypt          0.20.4 enabled    Automated installation of TLS certificates
`;

describe('pluginListHas', () => {
  it('finds a plugin by name', () => {
    expect(pluginListHas(`${LIST}  sso  0.1.0 enabled    SSO for dokku apps\n`, 'sso')).toBe(true);
  });

  it('does not find a plugin that is absent', () => {
    expect(pluginListHas(LIST, 'sso')).toBe(false);
  });

  it('does not accept the same plugin installed under another name', () => {
    // This is the mixup that skipped protection in CI: installed as dokku-sso,
    // while everything asking about it asks for sso.
    const list = `${LIST}  dokku-sso   0.1.0 enabled    SSO for dokku apps\n`;
    expect(pluginListHas(list, 'sso')).toBe(false);
    expect(pluginListHas(list, 'dokku-sso')).toBe(true);
  });

  it('does not match a name that only appears in a description', () => {
    const list = `${LIST}  oauth2      1.0.0 enabled    adds sso to your apps\n`;
    expect(pluginListHas(list, 'sso')).toBe(false);
  });

  it('does not match a longer plugin name that contains the one asked about', () => {
    expect(pluginListHas(`${LIST}  sso-extras   0.1.0 enabled    extras\n`, 'sso')).toBe(false);
  });
});
