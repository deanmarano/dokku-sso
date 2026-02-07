import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import {
  dokku,
  getContainerIp,
  getLdapCredentials,
  createLdapUser,
  waitForHealthy,
} from './helpers';

/**
 * Jellyfin LDAP Integration E2E Test
 *
 * Tests Jellyfin media server with LDAP authentication via the LDAP-Auth plugin:
 * 1. Create LLDAP directory service
 * 2. Deploy Jellyfin container with LDAP plugin pre-configured
 * 3. Create test user in LLDAP
 * 4. Test LDAP authentication via Jellyfin API
 *
 * Note: Jellyfin uses LDAP via a plugin, not OIDC.
 */

const SERVICE_NAME = 'jellyfin-ldap-test';
const JELLYFIN_CONTAINER = 'jellyfin-ldap-test';

let LDAP_CONTAINER_IP: string;
let AUTH_NETWORK: string;

// Test user credentials
const TEST_USER = 'jellyfinuser';
const TEST_PASSWORD = 'JellyfinPass123!';
const TEST_EMAIL = 'jellyfinuser@test.local';

test.describe('Jellyfin LDAP Integration', () => {
  test.setTimeout(600000); // 10 minute timeout

  test.beforeAll(async () => {
    console.log('=== Setting up Jellyfin LDAP test ===');

    // 1. Create LLDAP directory service
    console.log('Creating LLDAP directory service...');
    try {
      dokku(`auth:create ${SERVICE_NAME}`);
    } catch (e: any) {
      if (!e.stderr?.includes('already exists')) {
        throw e;
      }
    }

    // Wait for LLDAP to be healthy
    const healthy = await waitForHealthy(SERVICE_NAME, 'directory');
    if (!healthy) {
      throw new Error('LLDAP service not healthy');
    }

    // Get container IP and credentials
    LDAP_CONTAINER_IP = getContainerIp(`dokku.auth.directory.${SERVICE_NAME}`);
    console.log(`LLDAP container IP: ${LDAP_CONTAINER_IP}`);

    const creds = getLdapCredentials(SERVICE_NAME);

    // Get auth network
    AUTH_NETWORK = execSync(
      `docker inspect dokku.auth.directory.${SERVICE_NAME} --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}'`,
      { encoding: 'utf-8' }
    )
      .trim()
      .split('\n')[0];
    console.log(`Auth network: ${AUTH_NETWORK}`);

    // 2. Create test user in LLDAP
    console.log('Creating test user in LLDAP...');
    const lldapContainer = `dokku.auth.directory.${SERVICE_NAME}`;
    createLdapUser(
      lldapContainer,
      creds.ADMIN_PASSWORD,
      TEST_USER,
      TEST_EMAIL,
      TEST_PASSWORD
    );

    // 3. Create Jellyfin config directory with LDAP plugin
    console.log('Setting up Jellyfin LDAP plugin...');
    const jellyfinConfigDir = '/tmp/jellyfin-ldap-config';
    // Plugin needs version subdirectory: /plugins/LDAP Authentication/<version>/
    const pluginVersion = '18.0.0.0';
    const pluginDir = `${jellyfinConfigDir}/plugins/LDAP Authentication/${pluginVersion}`;
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(`${jellyfinConfigDir}/plugins/configurations`, { recursive: true });

    // Download LDAP plugin from Jellyfin's official repository
    // Plugin GUID: 958aad66-3571-4f06-b21d-97a497be2005
    console.log('Downloading LDAP Authentication plugin...');
    const pluginUrl = `https://repo.jellyfin.org/releases/plugin/ldap-authentication/ldap-authentication_${pluginVersion}.zip`;

    execSync(
      `curl -sL "${pluginUrl}" -o /tmp/ldap-plugin.zip && ` +
        `unzip -o /tmp/ldap-plugin.zip -d "${pluginDir}"`,
      { encoding: 'utf-8' }
    );
    console.log('LDAP plugin downloaded and extracted');

    // List what we extracted
    try {
      const files = execSync(`ls -la "${pluginDir}"`, { encoding: 'utf-8' });
      console.log('Plugin directory contents:', files);
    } catch {}

    // The zip file includes a meta.json - copy it to the parent directory
    // (Jellyfin looks for meta.json in /plugins/<name>/meta.json, not in version subdir)
    try {
      execSync(`cp "${pluginDir}/meta.json" "${jellyfinConfigDir}/plugins/LDAP Authentication/meta.json"`, {
        encoding: 'utf-8',
      });
      console.log('Copied meta.json to parent directory');

      // Show the meta.json content
      const metaContent = fs.readFileSync(`${jellyfinConfigDir}/plugins/LDAP Authentication/meta.json`, 'utf-8');
      console.log('meta.json content:', metaContent);
    } catch (e) {
      console.log('Error copying meta.json:', e);
      // Fallback: create our own meta.json
      const pluginMeta = {
        guid: '958aad66-3571-4f06-b21d-97a497be2005',
        name: 'LDAP Authentication',
        version: pluginVersion,
        status: 'Active',
      };
      fs.writeFileSync(
        `${jellyfinConfigDir}/plugins/LDAP Authentication/meta.json`,
        JSON.stringify(pluginMeta, null, 2)
      );
    }

    // LDAP plugin configuration XML
    const ldapPluginConfig = `<?xml version="1.0" encoding="utf-8"?>
<PluginConfiguration xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <LdapServer>${LDAP_CONTAINER_IP}</LdapServer>
  <LdapPort>3890</LdapPort>
  <UseSsl>false</UseSsl>
  <UseStartTls>false</UseStartTls>
  <SkipSslVerify>true</SkipSslVerify>
  <LdapBindUser>uid=admin,ou=people,${creds.BASE_DN}</LdapBindUser>
  <LdapBindPassword>${creds.ADMIN_PASSWORD}</LdapBindPassword>
  <LdapBaseDn>ou=people,${creds.BASE_DN}</LdapBaseDn>
  <LdapSearchFilter>(uid={0})</LdapSearchFilter>
  <LdapSearchAttributes>uid,mail,displayName</LdapSearchAttributes>
  <LdapUidAttribute>uid</LdapUidAttribute>
  <LdapUsernameAttribute>uid</LdapUsernameAttribute>
  <CreateUsersFromLdap>true</CreateUsersFromLdap>
  <EnableLdapAdminFilterMemberUid>false</EnableLdapAdminFilterMemberUid>
  <LdapAdminFilter></LdapAdminFilter>
  <EnableAllFolders>true</EnableAllFolders>
  <PasswordResetUrl></PasswordResetUrl>
</PluginConfiguration>`;

    fs.writeFileSync(
      `${jellyfinConfigDir}/plugins/configurations/LDAP-Auth.xml`,
      ldapPluginConfig
    );
    console.log('Wrote LDAP plugin configuration');

    // 4. Deploy Jellyfin container
    console.log('Deploying Jellyfin container...');
    try {
      execSync(`docker rm -f ${JELLYFIN_CONTAINER}`, { encoding: 'utf-8', stdio: 'pipe' });
    } catch {}

    // Mount the entire config directory so Jellyfin sees the plugin
    execSync(
      `docker run -d --name ${JELLYFIN_CONTAINER} ` +
        `--network ${AUTH_NETWORK} ` +
        `-e JELLYFIN_PublishedServerUrl=http://localhost:8096 ` +
        `-v ${jellyfinConfigDir}:/config ` +
        `jellyfin/jellyfin:latest`,
      { encoding: 'utf-8' }
    );

    // Wait for Jellyfin to be ready
    console.log('Waiting for Jellyfin to be ready...');
    let jellyfinReady = false;
    for (let i = 0; i < 60; i++) {
      try {
        const result = execSync(
          `docker exec ${JELLYFIN_CONTAINER} curl -sf http://localhost:8096/health`,
          { encoding: 'utf-8', timeout: 5000 }
        );
        if (result.includes('Healthy')) {
          jellyfinReady = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!jellyfinReady) {
      const logs = execSync(`docker logs ${JELLYFIN_CONTAINER} 2>&1 | tail -50`, {
        encoding: 'utf-8',
      });
      console.log('Jellyfin logs:', logs);
      throw new Error('Jellyfin not ready');
    }
    console.log('Jellyfin is ready');

    // 5. Complete initial setup wizard via API
    console.log('Completing Jellyfin initial setup...');

    // Get startup config
    try {
      const startupConfig = execSync(
        `docker exec ${JELLYFIN_CONTAINER} curl -s http://localhost:8096/Startup/Configuration`,
        { encoding: 'utf-8' }
      );
      console.log('Startup config:', startupConfig);
    } catch {}

    // Complete startup wizard - set initial config
    try {
      execSync(
        `docker exec ${JELLYFIN_CONTAINER} curl -s -X POST ` +
          `-H "Content-Type: application/json" ` +
          `-d '{"UICulture":"en-US","MetadataCountryCode":"US","PreferredMetadataLanguage":"en"}' ` +
          `"http://localhost:8096/Startup/Configuration"`,
        { encoding: 'utf-8' }
      );
    } catch {}

    // Create initial admin user (required for Jellyfin to work)
    try {
      execSync(
        `docker exec ${JELLYFIN_CONTAINER} curl -s -X POST ` +
          `-H "Content-Type: application/json" ` +
          `-d '{"Name":"admin","Password":"admin123"}' ` +
          `"http://localhost:8096/Startup/User"`,
        { encoding: 'utf-8' }
      );
    } catch {}

    // Complete startup
    try {
      execSync(
        `docker exec ${JELLYFIN_CONTAINER} curl -s -X POST ` +
          `"http://localhost:8096/Startup/Complete"`,
        { encoding: 'utf-8' }
      );
    } catch {}

    // Restart Jellyfin to ensure plugin is loaded
    console.log('Restarting Jellyfin to load LDAP plugin...');
    execSync(`docker restart ${JELLYFIN_CONTAINER}`, { encoding: 'utf-8' });

    // Wait for Jellyfin to be ready again
    let restartReady = false;
    for (let i = 0; i < 60; i++) {
      try {
        const result = execSync(
          `docker exec ${JELLYFIN_CONTAINER} curl -sf http://localhost:8096/health`,
          { encoding: 'utf-8', timeout: 5000 }
        );
        if (result.includes('Healthy')) {
          restartReady = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!restartReady) {
      throw new Error('Jellyfin not ready after restart');
    }

    // Give it a moment for plugins to fully initialize
    await new Promise((r) => setTimeout(r, 5000));

    // Debug: Check plugin directory structure inside container
    try {
      const pluginDir = execSync(
        `docker exec ${JELLYFIN_CONTAINER} ls -laR /config/plugins/ 2>/dev/null || echo "No plugins directory"`,
        { encoding: 'utf-8' }
      );
      console.log('Container plugin directory structure:', pluginDir);
    } catch (e) {
      console.log('Could not list plugins dir:', e);
    }

    // Debug: Check meta.json content
    try {
      const metaJson = execSync(
        `docker exec ${JELLYFIN_CONTAINER} cat "/config/plugins/LDAP Authentication/meta.json" 2>/dev/null || echo "No meta.json"`,
        { encoding: 'utf-8' }
      );
      console.log('meta.json content:', metaJson);
    } catch {}

    // Debug: Check for plugin loading errors in logs
    try {
      const logs = execSync(
        `docker logs ${JELLYFIN_CONTAINER} 2>&1 | grep -i -E "(plugin|ldap|error|warn)" | tail -20 || true`,
        { encoding: 'utf-8' }
      );
      console.log('Plugin-related logs:', logs);
    } catch {}

    // Verify LDAP plugin is loaded via API
    try {
      const plugins = execSync(
        `docker exec ${JELLYFIN_CONTAINER} curl -s http://localhost:8096/Plugins`,
        { encoding: 'utf-8' }
      );
      console.log('Loaded plugins API:', plugins);
    } catch {}

    console.log('=== Setup complete ===');
  });

  test.afterAll(async () => {
    console.log('=== Cleaning up Jellyfin LDAP test ===');
    try {
      execSync(`docker rm -f ${JELLYFIN_CONTAINER}`, { encoding: 'utf-8', stdio: 'pipe' });
    } catch {}
    try {
      dokku(`auth:destroy ${SERVICE_NAME} -f`, { quiet: true });
    } catch (e: any) {
      console.log('[cleanup] auth:destroy:', e.stderr?.trim() || e.message);
    }
  });

  test('Jellyfin health endpoint responds', async () => {
    const result = execSync(
      `docker exec ${JELLYFIN_CONTAINER} curl -sf http://localhost:8096/health`,
      { encoding: 'utf-8', timeout: 10000 }
    );
    expect(result).toContain('Healthy');
  });

  test('Jellyfin system info is accessible', async () => {
    const result = execSync(
      `docker exec ${JELLYFIN_CONTAINER} curl -sf http://localhost:8096/System/Info/Public`,
      { encoding: 'utf-8', timeout: 10000 }
    );
    const info = JSON.parse(result);
    expect(info).toHaveProperty('ServerName');
    expect(info).toHaveProperty('Version');
    console.log('Jellyfin version:', info.Version);
  });

  test('LDAP user can authenticate via Jellyfin API', async () => {
    // Authenticate using Jellyfin's API with LDAP credentials
    const authResult = execSync(
      `docker exec ${JELLYFIN_CONTAINER} curl -s -X POST ` +
        `-H "Content-Type: application/json" ` +
        `-H "X-Emby-Authorization: MediaBrowser Client=\\"Test\\", Device=\\"Test\\", DeviceId=\\"test123\\", Version=\\"1.0.0\\"" ` +
        `-d '{"Username":"${TEST_USER}","Pw":"${TEST_PASSWORD}"}' ` +
        `"http://localhost:8096/Users/AuthenticateByName"`,
      { encoding: 'utf-8', timeout: 30000 }
    );

    console.log('LDAP Auth result:', authResult);

    // Check if it's an error response
    if (authResult.startsWith('Error') || authResult.includes('"Message"')) {
      // Get Jellyfin logs for debugging
      const logs = execSync(`docker logs ${JELLYFIN_CONTAINER} 2>&1 | tail -30`, {
        encoding: 'utf-8',
      });
      console.log('Jellyfin logs:', logs);

      // Also check LDAP connection
      const ldapLogs = execSync(`docker logs dokku.auth.directory.${SERVICE_NAME} 2>&1 | tail -20`, {
        encoding: 'utf-8',
      });
      console.log('LLDAP logs:', ldapLogs);

      throw new Error(`LDAP authentication failed: ${authResult}`);
    }

    const auth = JSON.parse(authResult);
    expect(auth.AccessToken).toBeTruthy();
    expect(auth.User.Name).toBe(TEST_USER);
    console.log('LDAP authentication successful!');
  });

  test('Local admin can authenticate', async () => {
    // Verify the local admin we created during setup can log in
    const authResult = execSync(
      `docker exec ${JELLYFIN_CONTAINER} curl -s -X POST ` +
        `-H "Content-Type: application/json" ` +
        `-H "X-Emby-Authorization: MediaBrowser Client=\\"Test\\", Device=\\"Test\\", DeviceId=\\"test456\\", Version=\\"1.0.0\\"" ` +
        `-d '{"Username":"admin","Pw":"admin123"}' ` +
        `"http://localhost:8096/Users/AuthenticateByName"`,
      { encoding: 'utf-8', timeout: 30000 }
    );

    const auth = JSON.parse(authResult);
    expect(auth.AccessToken).toBeTruthy();
    expect(auth.User.Name).toBe('admin');
    console.log('Local admin authentication successful');
  });
});
