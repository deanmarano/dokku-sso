import ldap from 'ldapjs';

export class LDAPClient {
  private client: ldap.Client | null = null;
  private baseDn: string;

  constructor(
    private url: string,
    private bindDn: string,
    private password: string
  ) {
    // Extract base DN (dc=...) from bind DN like uid=admin,ou=people,dc=dokku,dc=local
    const parts = bindDn.split(',');
    const dcIndex = parts.findIndex(p => p.toLowerCase().startsWith('dc='));
    this.baseDn = dcIndex >= 0 ? parts.slice(dcIndex).join(',') : parts.slice(1).join(',');
  }

  /** Connect and bind to LDAP server */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client = ldap.createClient({ url: this.url });

      this.client.on('error', reject);

      this.client.bind(this.bindDn, this.password, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** Search for a user by uid */
  async searchUser(uid: string): Promise<ldap.SearchEntry | null> {
    if (!this.client) throw new Error('Not connected');

    return new Promise((resolve, reject) => {
      const results: ldap.SearchEntry[] = [];

      this.client!.search(
        `ou=people,${this.baseDn}`,
        { filter: `(uid=${uid})`, scope: 'sub' },
        (err, res) => {
          if (err) return reject(err);

          res.on('searchEntry', (entry) => results.push(entry));
          res.on('error', reject);
          res.on('end', () => resolve(results[0] || null));
        }
      );
    });
  }

  /** Test if a user can authenticate with given password */
  async userCanBind(uid: string, password: string): Promise<boolean> {
    return new Promise((resolve) => {
      const testClient = ldap.createClient({ url: this.url });

      testClient.bind(`uid=${uid},ou=people,${this.baseDn}`, password, (err) => {
        testClient.unbind();
        resolve(!err);
      });
    });
  }

  /** Get members of a group */
  async getGroupMembers(groupName: string): Promise<string[]> {
    if (!this.client) throw new Error('Not connected');

    return new Promise((resolve, reject) => {
      const members: string[] = [];

      this.client!.search(
        `ou=groups,${this.baseDn}`,
        { filter: `(cn=${groupName})`, scope: 'sub' },
        (err, res) => {
          if (err) return reject(err);

          res.on('searchEntry', (entry) => {
            const memberAttr = entry.attributes.find((a: any) => a.type === 'member');
            if (memberAttr) {
              members.push(...memberAttr.values);
            }
          });
          res.on('error', reject);
          res.on('end', () => resolve(members));
        }
      );
    });
  }

  /** Get the base DN */
  getBaseDn(): string {
    return this.baseDn;
  }

  /** Close the connection */
  async close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.client) {
        this.client.unbind(() => resolve());
      } else {
        resolve();
      }
    });
  }
}

/** Create user via LLDAP GraphQL API */
export async function createLLDAPUser(
  webUrl: string,
  adminPassword: string,
  user: { id: string; email: string; displayName: string; password: string }
): Promise<void> {
  // Get auth token
  const loginRes = await fetch(`${webUrl}/auth/simple/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: adminPassword }),
  });

  if (!loginRes.ok) {
    throw new Error(`Login failed: ${loginRes.status}`);
  }

  const { token } = await loginRes.json() as { token: string };

  // Create user
  const createRes = await fetch(`${webUrl}/api/graphql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      query: `
        mutation {
          createUser(user: {
            id: "${user.id}",
            email: "${user.email}",
            displayName: "${user.displayName}"
          }) { id }
        }
      `,
    }),
  });

  if (!createRes.ok) {
    throw new Error(`Create user failed: ${createRes.status}`);
  }

  // Set password
  await fetch(`${webUrl}/api/graphql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      query: `
        mutation {
          setUserPassword(userId: "${user.id}", password: "${user.password}")
        }
      `,
    }),
  });
}
