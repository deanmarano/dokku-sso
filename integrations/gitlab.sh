#!/usr/bin/env bash
# GitLab OIDC integration preset
# https://docs.gitlab.com/ee/administration/auth/oidc.html

PRESET_NAME="gitlab"
PRESET_DESCRIPTION="GitLab DevOps platform"
PRESET_SCOPES="openid profile email"
PRESET_REQUIRE_PKCE=false
PRESET_PUBLIC=false
PRESET_LDAP_SUPPORTED=true

# Generate redirect URI from app domain
preset_redirect_uri() {
  local DOMAIN="$1"
  echo "https://${DOMAIN}/users/auth/openid_connect/callback"
}

# Environment variables for GitLab Omnibus
preset_env_vars() {
  local SERVICE="$1"
  local APP="$2"
  local CLIENT_ID="$3"
  local CLIENT_SECRET="$4"
  local AUTH_DOMAIN="$5"

  # GitLab uses gitlab.rb, not env vars
  echo ""
}

# Post-integration instructions
preset_instructions() {
  local SERVICE="$1"
  local APP="$2"
  local CLIENT_ID="$3"
  local AUTH_DOMAIN="$4"

  cat <<EOF

GitLab OIDC Setup Instructions:
===============================

Add to /etc/gitlab/gitlab.rb (Omnibus):
---------------------------------------
gitlab_rails['omniauth_enabled'] = true
gitlab_rails['omniauth_allow_single_sign_on'] = ['openid_connect']
gitlab_rails['omniauth_block_auto_created_users'] = false
gitlab_rails['omniauth_providers'] = [
  {
    name: "openid_connect",
    label: "Authelia",
    args: {
      name: "openid_connect",
      scope: ["openid", "profile", "email"],
      response_type: "code",
      issuer: "https://${AUTH_DOMAIN}",
      client_auth_method: "query",
      discovery: true,
      uid_field: "preferred_username",
      pkce: true,
      client_options: {
        identifier: "$CLIENT_ID",
        secret: "<client_secret>",
        redirect_uri: "https://<gitlab-domain>/users/auth/openid_connect/callback"
      }
    }
  }
]

Then reconfigure GitLab:
  sudo gitlab-ctl reconfigure

For Docker-based GitLab:
------------------------
Mount the above configuration or use environment variables:
  GITLAB_OMNIBUS_CONFIG: |
    gitlab_rails['omniauth_enabled'] = true
    # ... rest of config above

Admin Setup:
------------
1. First user to log in via OIDC will NOT be admin by default
2. Create admin account locally first, then link OIDC identity
3. Or set: gitlab_rails['omniauth_auto_link_user'] = ["openid_connect"]

EOF
}

# LDAP configuration for GitLab
preset_ldap_config() {
  local SERVICE="$1"
  local LDAP_HOST="$2"
  local LDAP_PORT="$3"
  local BASE_DN="$4"
  local BIND_DN="$5"

  cat <<EOF
GitLab LDAP Setup Instructions:
===============================

Add to /etc/gitlab/gitlab.rb:
-----------------------------
gitlab_rails['ldap_enabled'] = true
gitlab_rails['ldap_servers'] = {
  'main' => {
    'label' => 'LLDAP',
    'host' => '$LDAP_HOST',
    'port' => $LDAP_PORT,
    'uid' => 'uid',
    'encryption' => 'plain',
    'bind_dn' => '$BIND_DN',
    'password' => '<bind_password>',
    'base' => 'ou=people,$BASE_DN',
    'verify_certificates' => false,
    'active_directory' => false,
    'allow_username_or_email_login' => true,
    'attributes' => {
      'username' => 'uid',
      'email' => 'mail',
      'name' => 'displayName',
      'first_name' => 'givenName',
      'last_name' => 'sn'
    },
    'group_base' => 'ou=groups,$BASE_DN',
    'admin_group' => 'gitlab_admin'
  }
}

Then reconfigure:
  sudo gitlab-ctl reconfigure

Sync LDAP groups (EE only):
---------------------------
gitlab_rails['ldap_servers']['main']['group_base'] = 'ou=groups,$BASE_DN'
gitlab_rails['ldap_sync_worker_cron'] = "0 */12 * * *"

EOF
}
