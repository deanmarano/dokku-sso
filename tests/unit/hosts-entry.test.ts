import { describe, it, expect } from 'vitest';
import { hostsFileHasEntry } from '../e2e/helpers';

const BASE = `127.0.0.1 localhost
::1 ip6-localhost ip6-loopback
`;

describe('hostsFileHasEntry', () => {
  it('finds a hostname that is mapped', () => {
    expect(hostsFileHasEntry(`${BASE}127.0.0.1 auth.test.local\n`, 'auth.test.local')).toBe(true);
  });

  it('does not find a hostname that is absent', () => {
    expect(hostsFileHasEntry(BASE, 'auth.test.local')).toBe(false);
  });

  it('does not mistake a longer hostname for the one asked about', () => {
    // The bug this replaced: test-radarr-auth.test.local ends with
    // auth.test.local, so the auth domain was treated as already present and
    // never added, and only apps whose names end that way were affected.
    const hosts = `${BASE}127.0.0.1 test-radarr-auth.test.local\n`;
    expect(hostsFileHasEntry(hosts, 'test-radarr-auth.test.local')).toBe(true);
    expect(hostsFileHasEntry(hosts, 'auth.test.local')).toBe(false);
  });

  it('finds a hostname listed as an alias beside others', () => {
    expect(
      hostsFileHasEntry(`${BASE}127.0.0.1 first.test.local auth.test.local\n`, 'auth.test.local')
    ).toBe(true);
  });

  it('ignores commented-out entries', () => {
    expect(hostsFileHasEntry(`${BASE}# 127.0.0.1 auth.test.local\n`, 'auth.test.local')).toBe(false);
  });

  it('does not treat an IP address as a hostname', () => {
    expect(hostsFileHasEntry(BASE, '127.0.0.1')).toBe(false);
  });
});
