import { describe, it, expect } from 'vitest';
import { isAutheliaUrl } from '../e2e/helpers';

describe('isAutheliaUrl', () => {
  it('recognises the Authelia portal', () => {
    expect(isAutheliaUrl('https://auth.test.local/')).toBe(true);
    expect(isAutheliaUrl('https://auth.test.local/?rd=https://app.test.local/')).toBe(true);
  });

  it('does not mistake an app whose name ends with the auth domain', () => {
    // The bug this replaced: test-radarr-auth.test.local ends with
    // auth.test.local, so a substring test reported the browser as still
    // sitting on the login page after it had already navigated to the app.
    expect(isAutheliaUrl('https://test-radarr-auth.test.local/')).toBe(false);
    expect(isAutheliaUrl('http://test-radarr-auth.test.local/movies')).toBe(false);
  });

  it('recognises an authelia-prefixed host', () => {
    expect(isAutheliaUrl('https://authelia.example.com/')).toBe(true);
  });

  it('does not match an app that merely mentions authelia in its path', () => {
    expect(isAutheliaUrl('http://app.test.local/docs/authelia')).toBe(false);
  });

  it('returns false for a value that is not a URL', () => {
    expect(isAutheliaUrl('about:blank')).toBe(false);
    expect(isAutheliaUrl('')).toBe(false);
  });
});
