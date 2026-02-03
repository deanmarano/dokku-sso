import { execSync } from 'child_process';

/**
 * LLDAP User Management Fixtures
 *
 * Helpers for creating/managing test users in LLDAP via GraphQL API
 */

export interface LdapUser {
  id: string;
  email: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
}

export class LLDAPClient {
  private serviceName: string;
  private containerName: string;
  private adminPassword: string | null = null;
  private token: string | null = null;

  constructor(serviceName: string) {
    this.serviceName = serviceName;
    this.containerName = `dokku.auth.directory.${serviceName}`;
  }

  private exec(cmd: string): string {
    return execSync(cmd, { encoding: 'utf8', timeout: 30000 }).trim();
  }

  private docker(cmd: string): string {
    return this.exec(`docker exec ${this.containerName} ${cmd}`);
  }

  private getAdminPassword(): string {
    if (!this.adminPassword) {
      // Try to read from config directory
      try {
        this.adminPassword = this.docker('cat /data/../config/ADMIN_PASSWORD 2>/dev/null');
      } catch {
        // Fallback: read from dokku service config
        const configDir = this.exec(
          `dokku config:get-all ${this.serviceName} 2>/dev/null | grep ADMIN_PASSWORD | cut -d= -f2`
        );
        this.adminPassword = configDir || '';
      }

      if (!this.adminPassword) {
        throw new Error('Could not retrieve LLDAP admin password');
      }
    }
    return this.adminPassword;
  }

  async getToken(): Promise<string> {
    if (!this.token) {
      const password = this.getAdminPassword();
      const response = this.docker(
        `curl -s -X POST "http://localhost:17170/auth/simple/login" ` +
        `-H "Content-Type: application/json" ` +
        `-d '{"username":"admin","password":"${password}"}'`
      );

      const data = JSON.parse(response);
      if (!data.token) {
        throw new Error(`Failed to get auth token: ${response}`);
      }
      this.token = data.token;
    }
    return this.token;
  }

  async graphql(query: string, variables?: Record<string, any>): Promise<any> {
    const token = await this.getToken();
    const body = JSON.stringify({ query, variables });

    const response = this.docker(
      `curl -s -X POST "http://localhost:17170/api/graphql" ` +
      `-H "Content-Type: application/json" ` +
      `-H "Authorization: Bearer ${token}" ` +
      `-d '${body.replace(/'/g, "'\\''")}'`
    );

    const data = JSON.parse(response);
    if (data.errors) {
      throw new Error(`GraphQL error: ${JSON.stringify(data.errors)}`);
    }
    return data.data;
  }

  async createUser(user: LdapUser): Promise<LdapUser> {
    const result = await this.graphql(`
      mutation CreateUser($user: CreateUserInput!) {
        createUser(user: $user) {
          id
          email
          displayName
        }
      }
    `, {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName || user.id,
        firstName: user.firstName,
        lastName: user.lastName,
      }
    });

    return result.createUser;
  }

  async deleteUser(userId: string): Promise<void> {
    await this.graphql(`
      mutation DeleteUser($userId: String!) {
        deleteUser(userId: $userId) {
          ok
        }
      }
    `, { userId });
  }

  async getUser(userId: string): Promise<LdapUser | null> {
    try {
      const result = await this.graphql(`
        query GetUser($userId: String!) {
          user(userId: $userId) {
            id
            email
            displayName
          }
        }
      `, { userId });

      return result.user;
    } catch {
      return null;
    }
  }

  async listUsers(): Promise<LdapUser[]> {
    const result = await this.graphql(`
      query {
        users {
          id
          email
          displayName
        }
      }
    `);

    return result.users;
  }

  async createGroup(groupName: string): Promise<void> {
    await this.graphql(`
      mutation CreateGroup($name: String!) {
        createGroup(name: $name) {
          id
          displayName
        }
      }
    `, { name: groupName });
  }

  async addUserToGroup(userId: string, groupName: string): Promise<void> {
    // First get group ID
    const groupsResult = await this.graphql(`
      query {
        groups {
          id
          displayName
        }
      }
    `);

    const group = groupsResult.groups.find((g: any) => g.displayName === groupName);
    if (!group) {
      throw new Error(`Group not found: ${groupName}`);
    }

    await this.graphql(`
      mutation AddUserToGroup($userId: String!, $groupId: Int!) {
        addUserToGroup(userId: $userId, groupId: $groupId) {
          ok
        }
      }
    `, { userId, groupId: group.id });
  }

  async listGroups(): Promise<{ id: number; displayName: string }[]> {
    const result = await this.graphql(`
      query {
        groups {
          id
          displayName
        }
      }
    `);

    return result.groups;
  }
}

/**
 * Create standard test users for E2E tests
 */
export async function setupTestUsers(serviceName: string): Promise<{
  client: LLDAPClient;
  users: LdapUser[];
}> {
  const client = new LLDAPClient(serviceName);

  const testUsers: LdapUser[] = [
    {
      id: 'testuser',
      email: 'testuser@test.local',
      displayName: 'Test User',
      firstName: 'Test',
      lastName: 'User',
    },
    {
      id: 'alice',
      email: 'alice@test.local',
      displayName: 'Alice Smith',
      firstName: 'Alice',
      lastName: 'Smith',
    },
    {
      id: 'bob',
      email: 'bob@test.local',
      displayName: 'Bob Jones',
      firstName: 'Bob',
      lastName: 'Jones',
    },
  ];

  const createdUsers: LdapUser[] = [];

  for (const user of testUsers) {
    // Check if user exists
    const existing = await client.getUser(user.id);
    if (!existing) {
      const created = await client.createUser(user);
      createdUsers.push(created);
      console.log(`Created test user: ${user.id}`);
    } else {
      createdUsers.push(existing);
      console.log(`Test user exists: ${user.id}`);
    }
  }

  // Add users to default group
  try {
    for (const user of createdUsers) {
      await client.addUserToGroup(user.id, 'dokku-auth-default-users');
    }
  } catch (e) {
    console.log('Could not add users to default group:', e);
  }

  return { client, users: createdUsers };
}

/**
 * Clean up test users
 */
export async function cleanupTestUsers(serviceName: string): Promise<void> {
  const client = new LLDAPClient(serviceName);

  const testUserIds = ['testuser', 'alice', 'bob'];

  for (const userId of testUserIds) {
    try {
      await client.deleteUser(userId);
      console.log(`Deleted test user: ${userId}`);
    } catch (e) {
      // User might not exist
    }
  }
}
