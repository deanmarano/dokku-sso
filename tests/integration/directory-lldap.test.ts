import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DokkuAuth } from '../helpers/dokku';
import { LDAPClient } from '../helpers/ldap';

describe('LLDAP Directory Provider', () => {
  let dokku: DokkuAuth;

  beforeAll(() => {
    dokku = new DokkuAuth();
  });

  afterAll(async () => {
    await dokku.cleanup();
  });

  describe('Service Creation', () => {
    it('should create service and container should be healthy', async () => {
      const info = await dokku.createDirectory('create-test');

      // Provider can be ID ('lldap') or display name ('LLDAP (Lightweight LDAP)')
      expect(info.provider?.toLowerCase()).toContain('lldap');
      expect(info.status).toBe('running');
      expect(info.ldap_url).toMatch(/^ldap:\/\//);
      expect(info.base_dn).toBeTruthy();
    });

    it('should have admin credentials', async () => {
      await dokku.createDirectory('creds-test');
      const creds = dokku.getCredentials('creds-test');

      expect(creds.ADMIN_PASSWORD).toBeTruthy();
      expect(creds.ADMIN_PASSWORD.length).toBeGreaterThanOrEqual(16);
      expect(creds.BIND_DN).toContain('admin');
    });

    it('should list created services', async () => {
      await dokku.createDirectory('list-test');
      const output = dokku.run('list');

      expect(output).toContain('list-test');
      expect(output).toContain('lldap');
    });
  });

  describe('LDAP Operations', () => {
    let ldapClient: LDAPClient;
    let serviceName: string;

    beforeAll(async () => {
      const info = await dokku.createDirectory('ldap-ops-test');
      serviceName = 'ldap-ops-test';
      const creds = dokku.getCredentials(serviceName);

      // Get container IP since hostname may not resolve from test runner
      const containerName = `dokku.auth.directory.${serviceName}`;
      const { execSync } = await import('child_process');
      let containerIp: string;
      try {
        containerIp = execSync(
          `docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${containerName}`,
          { encoding: 'utf-8' }
        ).trim();
      } catch {
        // Fallback to hostname if docker inspect fails
        containerIp = containerName;
      }

      const ldapUrl = `ldap://${containerIp}:3890`;

      ldapClient = new LDAPClient(
        ldapUrl,
        creds.BIND_DN,
        creds.ADMIN_PASSWORD
      );
      await ldapClient.connect();
    });

    afterAll(async () => {
      await ldapClient?.close();
    });

    it('should bind as admin', async () => {
      const admin = await ldapClient.searchUser('admin');
      expect(admin).not.toBeNull();
    });

    it('should have default users group', async () => {
      const members = await ldapClient.getGroupMembers('dokku-auth-default-users');
      // Group exists (may or may not have members yet)
      expect(Array.isArray(members)).toBe(true);
    });
  });

  describe('Service Status', () => {
    it('should report healthy status', async () => {
      await dokku.createDirectory('status-test');
      const exitCode = dokku.status('status-test', true);
      expect(exitCode).toBe(0);
    });

    it('should return non-zero for non-existent service', () => {
      const exitCode = dokku.status('non-existent-service', true);
      expect(exitCode).not.toBe(0);
    });
  });
});
