import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import { dokku, waitForHealthy } from './helpers';

/**
 * Authentik Frontend Provider E2E Test
 *
 * Tests the Authentik provider:
 * 1. Creating a frontend service with Authentik provider
 * 2. Verifying server and worker containers are running
 * 3. Testing health endpoint
 * 4. Verifying info output shows Authentik provider
 *
 * Requires: dokku postgres and redis plugins installed
 */

const SERVICE_NAME = 'authentik-e2e-test';
const DIRECTORY_SERVICE = 'authentik-dir-test';

test.describe('Authentik Frontend Provider', () => {
  test.beforeAll(async () => {
    console.log('=== Setting up Authentik test ===');

    // Create directory service first (Authentik needs LDAP backend)
    console.log('Creating directory service...');
    try {
      dokku(`auth:create ${DIRECTORY_SERVICE}`);
    } catch (e: any) {
      if (!e.stderr?.includes('already exists')) {
        throw e;
      }
    }

    // Wait for directory to be healthy
    const dirHealthy = await waitForHealthy(DIRECTORY_SERVICE, 'directory');
    if (!dirHealthy) {
      throw new Error('Directory service not healthy');
    }

    // Create Authentik frontend service
    console.log('Creating Authentik frontend service...');
    try {
      dokku(`auth:frontend:create ${SERVICE_NAME} --provider authentik`);
    } catch (e: any) {
      if (!e.stderr?.includes('already exists')) {
        throw e;
      }
    }

    // Wait for frontend to be healthy (Authentik takes a while to start)
    const healthy = await waitForHealthy(SERVICE_NAME, 'frontend', 180000);
    if (!healthy) {
      // Get logs for debugging
      try {
        const logs = dokku(`auth:frontend:logs ${SERVICE_NAME} -n 50`);
        console.log('Authentik logs:', logs);
      } catch {}
      throw new Error('Authentik service not healthy');
    }

    console.log('=== Setup complete ===');
  }, 600000); // 10 minute timeout

  test.afterAll(async () => {
    console.log('=== Cleaning up Authentik test ===');
    try {
      dokku(`auth:frontend:destroy ${SERVICE_NAME} -f`, { quiet: true });
    } catch (e: any) {
      console.log('[cleanup] auth:frontend:destroy:', e.stderr?.trim() || e.message);
    }
    try {
      dokku(`auth:destroy ${DIRECTORY_SERVICE} -f`, { quiet: true });
    } catch (e: any) {
      console.log('[cleanup] auth:destroy:', e.stderr?.trim() || e.message);
    }
  });

  test('service status shows healthy', async () => {
    const status = dokku(`auth:frontend:status ${SERVICE_NAME}`);
    expect(status.toLowerCase()).toMatch(/healthy|running/);
  });

  test('service info shows Authentik provider', async () => {
    const info = dokku(`auth:frontend:info ${SERVICE_NAME}`);
    expect(info.toLowerCase()).toContain('authentik');
  });

  test('server container is running', async () => {
    const serverContainer = `dokku.auth.frontend.${SERVICE_NAME}`;
    const result = execSync(
      `docker ps --format '{{.Names}}' | grep -q "^${serverContainer}$" && echo "running"`,
      { encoding: 'utf-8', shell: '/bin/bash' }
    );
    expect(result.trim()).toBe('running');
  });

  test('worker container is running', async () => {
    const workerContainer = `dokku.auth.frontend.${SERVICE_NAME}.worker`;
    const result = execSync(
      `docker ps --format '{{.Names}}' | grep -q "^${workerContainer}$" && echo "running"`,
      { encoding: 'utf-8', shell: '/bin/bash' }
    );
    expect(result.trim()).toBe('running');
  });

  test('health endpoint responds', async () => {
    const serverContainer = `dokku.auth.frontend.${SERVICE_NAME}`;

    // Authentik health endpoint
    const result = execSync(
      `docker exec ${serverContainer} wget -q -O- http://localhost:9000/-/health/ready/ 2>/dev/null || ` +
        `docker exec ${serverContainer} curl -sf http://localhost:9000/-/health/ready/`,
      { encoding: 'utf-8', timeout: 30000 }
    );

    // Authentik returns empty body with 204 or just "ok" depending on version
    // The important thing is the command succeeded (didn't throw)
    console.log('Health check response:', result);
  });

  test('info shows PostgreSQL and Redis services', async () => {
    const info = dokku(`auth:frontend:info ${SERVICE_NAME}`);
    expect(info.toLowerCase()).toContain('postgresql');
    expect(info.toLowerCase()).toContain('redis');
  });

  test('can link to directory service', async () => {
    // Link to directory (this should output LDAP config instructions)
    const result = dokku(`auth:frontend:use-directory ${SERVICE_NAME} ${DIRECTORY_SERVICE}`);
    expect(result.toLowerCase()).toContain('ldap');
  });
});
