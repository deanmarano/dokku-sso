import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DokkuAuth, createTestApp, destroyTestApp, getAppConfig } from '../helpers/dokku';

describe('App Linking', () => {
  let dokku: DokkuAuth;
  let testApp: string;
  const serviceName = `link-svc-${Date.now()}`;
  const appName = `link-app-${Date.now()}`;

  beforeAll(async () => {
    dokku = new DokkuAuth();
    // Clean up any stale resources first
    try { await destroyTestApp(appName); } catch (e: any) {
      console.log('[cleanup] destroyTestApp:', e.message);
    }
    await dokku.createDirectory(serviceName);
    testApp = await createTestApp(appName);
  });

  afterAll(async () => {
    try { await destroyTestApp(testApp); } catch (e: any) {
      console.log('[cleanup] destroyTestApp:', e.message);
    }
    await dokku.cleanup();
  });

  it('should set LDAP environment variables', () => {
    dokku.link(serviceName, testApp);
    const config = getAppConfig(testApp);

    expect(config.LDAP_URL).toMatch(/^ldap:\/\//);
    expect(config.LDAP_BASE_DN).toBeTruthy();
    expect(config.LDAP_BIND_DN).toContain('admin');
    expect(config.LDAP_BIND_PASSWORD).toBeTruthy();
  });

  it('should show app in linked apps list', async () => {
    const result = await dokku.exec(`auth:info ${serviceName}`);
    expect(result.stdout).toContain('Linked apps:');
    expect(result.stdout).toContain(testApp);
  });

  it('should remove env vars on unlink', () => {
    dokku.unlink(serviceName, testApp);
    const config = getAppConfig(testApp);

    expect(config.LDAP_URL).toBeUndefined();
    expect(config.LDAP_BASE_DN).toBeUndefined();
  });
});
