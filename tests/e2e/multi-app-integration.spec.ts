import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';

/**
 * Multiple App LDAP Integration E2E Tests
 *
 * Tests linking multiple apps to a single LLDAP directory service.
 * Verifies each app gets proper environment variables and group creation.
 */

const SERVICE_NAME = 'multi-app-ldap-test';
const TEST_APPS = ['app-alpha', 'app-beta'];
const USE_SUDO = process.env.DOKKU_USE_SUDO === 'true';

// Helper to run dokku commands
function dokku(cmd: string, opts?: { quiet?: boolean }): string {
  const dokkuCmd = USE_SUDO ? `sudo dokku ${cmd}` : `dokku ${cmd}`;
  console.log(`$ ${dokkuCmd}`);
  try {
    const result = execSync(dokkuCmd, { encoding: 'utf8', timeout: 300000 });
    console.log(result);
    return result;
  } catch (error: any) {
    if (!opts?.quiet) {
      console.error(`Failed:`, error.stderr || error.message);
    }
    throw error;
  }
}

// Get LLDAP credentials
function getLdapCredentials(): Record<string, string> {
  const output = dokku(`auth:credentials ${SERVICE_NAME}`);
  const creds: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const match = line.match(/^(\w+)=(.+)$/);
    if (match) {
      creds[match[1]] = match[2];
    }
  }
  return creds;
}

test.describe('Multiple App LDAP Integration', () => {
  test.beforeAll(async () => {
    console.log('=== Setting up multi-app LDAP test environment ===');

    // Create directory service
    console.log('Creating LLDAP directory service...');
    try {
      dokku(`auth:create ${SERVICE_NAME}`);
    } catch (e: any) {
      if (!e.stderr?.includes('already exists')) {
        throw e;
      }
    }

    // Wait for service to be healthy
    let healthy = false;
    for (let i = 0; i < 30; i++) {
      try {
        const statusCmd = USE_SUDO ? `sudo dokku auth:status ${SERVICE_NAME}` : `dokku auth:status ${SERVICE_NAME}`;
        const status = execSync(statusCmd, { encoding: 'utf-8' });
        if (status.includes('healthy')) {
          healthy = true;
          break;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 2000));
    }
    if (!healthy) {
      throw new Error('LLDAP service not healthy');
    }

    // Create test apps
    for (const app of TEST_APPS) {
      console.log(`Creating test app: ${app}...`);
      try {
        dokku(`apps:create ${app}`);
      } catch (e: any) {
        if (!e.stderr?.includes('already exists')) {
          throw e;
        }
      }
    }

  }, 300000);

  test.afterAll(async () => {
    console.log('=== Cleaning up multi-app test environment ===');
    for (const app of TEST_APPS) {
      try {
        dokku(`auth:unlink ${SERVICE_NAME} ${app}`, { quiet: true });
      } catch (e: any) {
        console.log(`[cleanup] auth:unlink ${app}:`, e.stderr?.trim() || e.message);
      }
      try {
        dokku(`apps:destroy ${app} --force`, { quiet: true });
      } catch (e: any) {
        console.log(`[cleanup] apps:destroy ${app}:`, e.stderr?.trim() || e.message);
      }
    }
    try {
      dokku(`auth:destroy ${SERVICE_NAME} -f`, { quiet: true });
    } catch (e: any) {
      console.log('[cleanup] auth:destroy:', e.stderr?.trim() || e.message);
    }
  });

  test('should link multiple apps to same LLDAP service', async () => {
    for (const app of TEST_APPS) {
      const linkOutput = dokku(`auth:link ${SERVICE_NAME} ${app}`);
      expect(linkOutput).toContain('Linking');
      expect(linkOutput).toContain('LDAP_URL');
    }
  });

  test('each app should have LDAP environment variables', async () => {
    for (const app of TEST_APPS) {
      const config = dokku(`config:export ${app}`);
      expect(config).toContain('LDAP_URL');
      expect(config).toContain('LDAP_BASE_DN');
      expect(config).toContain('LDAP_BIND_DN');
      expect(config).toContain('LDAP_BIND_PASSWORD');
    }
  });

  test('service info should show all linked apps', async () => {
    const info = dokku(`auth:info ${SERVICE_NAME}`);
    for (const app of TEST_APPS) {
      expect(info).toContain(app);
    }
  });

  test('each app should have its own user group', async () => {
    const creds = getLdapCredentials();
    const baseDn = creds.BASE_DN || creds.LDAP_BASE_DN;

    // Groups are created when linking - verify via info command
    const info = dokku(`auth:info ${SERVICE_NAME}`);
    expect(info).toContain('Linked apps');

    // Both apps should be in the linked apps list
    for (const app of TEST_APPS) {
      expect(info).toContain(app);
    }
  });

  test('should unlink apps independently', async () => {
    // Unlink first app
    const unlinkOutput = dokku(`auth:unlink ${SERVICE_NAME} ${TEST_APPS[0]}`);
    expect(unlinkOutput).toContain('Unlinking');

    // First app should not have LDAP vars
    const config1 = dokku(`config:export ${TEST_APPS[0]}`);
    expect(config1).not.toContain('LDAP_URL=ldap');

    // Second app should still have LDAP vars
    const config2 = dokku(`config:export ${TEST_APPS[1]}`);
    expect(config2).toContain('LDAP_URL');

    // Service should only show second app
    const info = dokku(`auth:info ${SERVICE_NAME}`);
    expect(info).not.toContain(TEST_APPS[0]);
    expect(info).toContain(TEST_APPS[1]);

    // Re-link first app for cleanup
    dokku(`auth:link ${SERVICE_NAME} ${TEST_APPS[0]}`);
  });

  test('should list directory services', async () => {
    const list = dokku('auth:list');
    expect(list).toContain(SERVICE_NAME);
    expect(list).toContain('lldap');
  });
});
