import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120000, // 2 minutes per test (app deploys can be slow)
  expect: {
    timeout: 30000,
  },
  fullyParallel: false, // Run tests sequentially for auth flows
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // Single worker for auth tests
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'test-results/html' }],
    ['json', { outputFile: 'test-results/results.json' }],
  ],

  // Global setup/teardown
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',

  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:17170',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    ignoreHTTPSErrors: true, // Self-signed certs in test env

    // Longer timeouts for app interactions
    actionTimeout: 15000,
    navigationTimeout: 30000,
  },

  projects: [
    // Fast tests - LLDAP and Authelia UI only
    {
      name: 'auth-ui',
      testMatch: ['lldap-login.spec.ts', 'authelia-login.spec.ts'],
      use: { ...devices['Desktop Chrome'] },
    },

    // Full stack tests - includes CLI operations
    {
      name: 'full-stack',
      testMatch: ['full-stack.spec.ts'],
      use: { ...devices['Desktop Chrome'] },
    },

    // Gitea integration tests
    {
      name: 'gitea-integration',
      testMatch: ['gitea-integration.spec.ts'],
      use: { ...devices['Desktop Chrome'] },
      timeout: 600000, // 10 minutes
    },

    // Multi-app integration tests
    {
      name: 'multi-app-integration',
      testMatch: ['multi-app-integration.spec.ts'],
      use: { ...devices['Desktop Chrome'] },
      timeout: 600000, // 10 minutes
    },

    // Nextcloud LDAP tests
    {
      name: 'nextcloud-ldap',
      testMatch: ['nextcloud-ldap.spec.ts'],
      use: { ...devices['Desktop Chrome'] },
      timeout: 600000, // 10 minutes
    },

    // OIDC client tests (infrastructure)
    {
      name: 'oidc',
      testMatch: ['oidc-client.spec.ts'],
      use: { ...devices['Desktop Chrome'] },
      timeout: 600000, // 10 minutes for full OIDC setup
    },

    // OIDC application tests (full flow with oauth2-proxy)
    {
      name: 'oidc-app',
      testMatch: ['oidc-app.spec.ts'],
      use: { ...devices['Desktop Chrome'] },
      timeout: 600000, // 10 minutes for full OIDC setup
    },

    // LDAP authentication tests - user creation and authentication
    {
      name: 'gitea-ldap',
      testMatch: ['gitea-ldap-login.spec.ts'],
      use: { ...devices['Desktop Chrome'] },
      timeout: 300000, // 5 minutes
    },

    // Grafana LDAP integration tests
    {
      name: 'grafana-ldap',
      testMatch: ['grafana-ldap.spec.ts'],
      use: { ...devices['Desktop Chrome'] },
      timeout: 600000, // 10 minutes
    },

    // Grafana OIDC integration tests
    {
      name: 'grafana-oidc',
      testMatch: ['grafana-oidc.spec.ts'],
      use: { ...devices['Desktop Chrome'] },
      timeout: 600000, // 10 minutes
    },

    // GitLab LDAP integration tests
    {
      name: 'gitlab-ldap',
      testMatch: ['gitlab-ldap.spec.ts'],
      use: { ...devices['Desktop Chrome'] },
      timeout: 900000, // 15 minutes (GitLab startup is slow)
    },

    // GLAuth directory provider tests
    {
      name: 'glauth',
      testMatch: ['glauth.spec.ts'],
      use: { ...devices['Desktop Chrome'] },
      timeout: 300000, // 5 minutes
    },

    // OpenLDAP directory provider tests
    {
      name: 'openldap',
      testMatch: ['openldap.spec.ts'],
      use: { ...devices['Desktop Chrome'] },
      timeout: 300000, // 5 minutes
    },

    // Authentik frontend provider tests
    {
      name: 'authentik',
      testMatch: ['authentik.spec.ts'],
      use: { ...devices['Desktop Chrome'] },
      timeout: 600000, // 10 minutes (Authentik startup is slow)
    },

    // Authentik + Grafana LDAP integration tests
    {
      name: 'authentik-grafana-ldap',
      testMatch: ['authentik-grafana-ldap.spec.ts'],
      use: { ...devices['Desktop Chrome'] },
      timeout: 600000, // 10 minutes
    },

    // Authentik + Grafana OIDC integration tests
    {
      name: 'authentik-grafana-oidc',
      testMatch: ['authentik-grafana-oidc.spec.ts'],
      use: { ...devices['Desktop Chrome'] },
      timeout: 600000, // 10 minutes
    },

    // Radarr forward auth tests (Authelia protecting Radarr)
    {
      name: 'radarr-forward-auth',
      testMatch: ['radarr-forward-auth.spec.ts'],
      use: { ...devices['Desktop Chrome'] },
      timeout: 300000, // 5 minutes
    },

    // Jellyfin LDAP integration tests
    {
      name: 'jellyfin-ldap',
      testMatch: ['jellyfin-ldap.spec.ts'],
      use: { ...devices['Desktop Chrome'] },
      timeout: 600000, // 10 minutes
    },

    // Immich OIDC integration tests
    {
      name: 'immich-oidc',
      testMatch: ['immich-oidc.spec.ts'],
      use: { ...devices['Desktop Chrome'] },
      timeout: 600000, // 10 minutes
    },
  ],

  // Output directory for test artifacts
  outputDir: 'test-results/artifacts',
});
