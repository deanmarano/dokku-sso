import { execSync } from 'child_process';
import { cleanupTestUsers } from './fixtures/lldap-users';

/**
 * Global teardown for E2E tests
 *
 * Optionally cleans up the shared service after all tests complete.
 * Set E2E_CLEANUP=true to destroy the shared service.
 */

const SHARED_SERVICE = process.env.E2E_SERVICE_NAME || 'e2e-shared';
const CLEANUP = process.env.E2E_CLEANUP === 'true';

function dokku(cmd: string): string {
  console.log(`[teardown] dokku ${cmd}`);
  try {
    return execSync(`dokku ${cmd}`, { encoding: 'utf8', timeout: 120000 });
  } catch (error: any) {
    console.error(`Command failed: ${error.message}`);
    return '';
  }
}

async function globalTeardown() {
  console.log('=== E2E Global Teardown ===');

  if (!CLEANUP) {
    console.log('Keeping shared service (set E2E_CLEANUP=true to destroy)');
    return;
  }

  // Clean up test users
  console.log('Cleaning up test users...');
  try {
    await cleanupTestUsers(SHARED_SERVICE);
  } catch (error) {
    console.error('Failed to clean up test users:', error);
  }

  // Destroy shared service
  console.log('Destroying shared service...');
  dokku(`auth:destroy ${SHARED_SERVICE} -f`);

  console.log('=== Teardown Complete ===');
}

export default globalTeardown;
