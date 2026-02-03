import { execSync } from 'child_process';

/**
 * Global setup for E2E tests
 *
 * Creates the shared LLDAP service and test users before any tests run.
 */

const SHARED_SERVICE = process.env.E2E_SERVICE_NAME || 'e2e-shared';
const SKIP_SETUP = process.env.SKIP_GLOBAL_SETUP === 'true';
const USE_SUDO = process.env.DOKKU_USE_SUDO === 'true';

function dokku(cmd: string): string {
  const dokkuCmd = USE_SUDO ? `sudo dokku ${cmd}` : `dokku ${cmd}`;
  console.log(`[setup] ${dokkuCmd}`);
  try {
    return execSync(dokkuCmd, {
      encoding: 'utf8',
      timeout: 300000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (error: any) {
    // Don't fail on "already exists" errors
    if (error.stderr?.includes('already exists') || error.stdout?.includes('already exists')) {
      return error.stdout || '';
    }
    console.error(`Command failed: ${error.stderr || error.message}`);
    throw error;
  }
}

async function waitForService(maxWait = 60000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const status = dokku(`auth:status ${SHARED_SERVICE}`);
      if (status.includes('healthy')) {
        return true;
      }
    } catch {
      // Service might not exist yet
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  return false;
}

async function globalSetup() {
  console.log('=== E2E Global Setup ===');

  if (SKIP_SETUP) {
    console.log('Skipping global setup (SKIP_GLOBAL_SETUP=true)');
    console.log('Make sure to manually create the test service:');
    console.log(`  dokku auth:create ${SHARED_SERVICE}`);
    return;
  }

  console.log(`Using shared service: ${SHARED_SERVICE}`);

  // First, install the plugin if not already installed
  try {
    dokku('plugin:list');
    const plugins = dokku('plugin:list');
    if (!plugins.includes('auth')) {
      console.log('Installing auth plugin...');
      dokku('plugin:install file:///plugin-src --name auth');
    }
  } catch (error) {
    console.log('Could not check/install plugin, continuing...');
  }

  // Check if service already exists
  try {
    const status = dokku(`auth:status ${SHARED_SERVICE}`);
    if (status.includes('healthy')) {
      console.log('Shared service already healthy');
      return;
    } else {
      console.log('Shared service exists but not healthy, applying config...');
      dokku(`auth:provider:apply ${SHARED_SERVICE}`);
    }
  } catch {
    // Service doesn't exist, create it
    console.log('Creating shared LLDAP service...');
    dokku(`auth:create ${SHARED_SERVICE}`);
  }

  // Wait for service to be ready
  console.log('Waiting for service to be ready...');
  const ready = await waitForService();

  if (!ready) {
    console.error('Service did not become ready in time');
    // Try to get logs for debugging
    try {
      const logs = dokku(`auth:logs ${SHARED_SERVICE} -n 50`);
      console.log('Service logs:', logs);
    } catch {}
    throw new Error('Shared service is not healthy');
  }

  // Verify service
  try {
    const doctorResult = dokku(`auth:doctor ${SHARED_SERVICE}`);
    console.log('Doctor result:', doctorResult);
  } catch (error) {
    console.log('Doctor check had issues, continuing anyway...');
  }

  console.log('=== Setup Complete ===');
}

export default globalSetup;
