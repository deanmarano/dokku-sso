import { dokku, waitForHealthy } from './helpers';

/**
 * Global setup for E2E tests
 *
 * Creates the shared LLDAP service and test users before any tests run.
 */

const SHARED_SERVICE = process.env.E2E_SERVICE_NAME || 'e2e-shared';
const SKIP_SETUP = process.env.SKIP_GLOBAL_SETUP === 'true';

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
    dokku('plugin:list', { quiet: true, prefix: '[setup] ', logOutput: false });
    const plugins = dokku('plugin:list', { quiet: true, prefix: '[setup] ', logOutput: false });
    if (!plugins.includes('auth')) {
      console.log('Installing auth plugin...');
      dokku('plugin:install file:///plugin-src --name auth', { quiet: true, prefix: '[setup] ', logOutput: false });
    }
  } catch (error) {
    console.log('Could not check/install plugin, continuing...');
  }

  // Check if service already exists
  try {
    const status = dokku(`auth:status ${SHARED_SERVICE}`, { quiet: true, prefix: '[setup] ', logOutput: false });
    if (status.includes('healthy')) {
      console.log('Shared service already healthy');
      return;
    } else {
      console.log('Shared service exists but not healthy, applying config...');
      dokku(`auth:provider:apply ${SHARED_SERVICE}`, { prefix: '[setup] ' });
    }
  } catch {
    // Service doesn't exist, create it
    console.log('Creating shared LLDAP service...');
    dokku(`auth:create ${SHARED_SERVICE}`, { prefix: '[setup] ' });
  }

  // Wait for service to be ready
  console.log('Waiting for service to be ready...');
  const ready = await waitForHealthy(SHARED_SERVICE, 'directory');

  if (!ready) {
    console.error('Service did not become ready in time');
    // Try to get logs for debugging
    try {
      const logs = dokku(`auth:logs ${SHARED_SERVICE} -n 50`, { prefix: '[setup] ' });
      console.log('Service logs:', logs);
    } catch {}
    throw new Error('Shared service is not healthy');
  }

  // Verify service
  try {
    const doctorResult = dokku(`auth:doctor ${SHARED_SERVICE}`, { quiet: true, prefix: '[setup] ', logOutput: false });
    console.log('Doctor result:', doctorResult);
  } catch (error) {
    console.log('Doctor check had issues, continuing anyway...');
  }

  console.log('=== Setup Complete ===');
}

export default globalSetup;
