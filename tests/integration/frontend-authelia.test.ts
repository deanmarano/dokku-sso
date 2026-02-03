import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DokkuAuth } from '../helpers/dokku';

describe('Frontend Service (Authelia)', () => {
  const auth = new DokkuAuth();
  const serviceName = `test-frontend-${Date.now()}`;
  const directoryName = `test-dir-${Date.now()}`;

  beforeAll(async () => {
    // Create a directory service first
    await auth.exec(`auth:create ${directoryName}`);
  }, 120000);

  afterAll(async () => {
    await auth.exec(`auth:frontend:destroy ${serviceName} -f`).catch(() => {});
    await auth.exec(`auth:destroy ${directoryName} -f`).catch(() => {});
  }, 60000);

  it('should create a frontend service', async () => {
    const result = await auth.exec(`auth:frontend:create ${serviceName}`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Frontend service');
    expect(result.stdout).toContain('created');
  }, 120000);

  it('should list frontend services', async () => {
    const result = await auth.exec('auth:frontend:list');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(serviceName);
  });

  it('should show frontend info', async () => {
    const result = await auth.exec(`auth:frontend:info ${serviceName}`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Authelia');
    expect(result.stdout).toContain('Container');
  });

  it('should configure domain', async () => {
    const result = await auth.exec(`auth:frontend:config ${serviceName} DOMAIN=auth.test.local`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('DOMAIN=auth.test.local');
  });

  it('should link to directory service', async () => {
    const result = await auth.exec(`auth:frontend:use-directory ${serviceName} ${directoryName}`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Directory configured');
  });

  it('should enable OIDC', async () => {
    const result = await auth.exec(`auth:oidc:enable ${serviceName}`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('OIDC enabled');
  });

  it('should add OIDC client', async () => {
    const result = await auth.exec(`auth:oidc:add-client ${serviceName} test-app test-secret https://app.test.local/callback`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Client added');
    expect(result.stdout).toContain('test-app');
  });

  it('should list OIDC clients', async () => {
    const result = await auth.exec(`auth:oidc:list ${serviceName}`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('test-app');
  });

  it('should remove OIDC client', async () => {
    const result = await auth.exec(`auth:oidc:remove-client ${serviceName} test-app`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Client removed');
  });

  it('should disable OIDC', async () => {
    const result = await auth.exec(`auth:oidc:disable ${serviceName}`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('OIDC disabled');
  });

  it('should destroy frontend service', async () => {
    const result = await auth.exec(`auth:frontend:destroy ${serviceName} -f`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('destroyed');
  });
});
