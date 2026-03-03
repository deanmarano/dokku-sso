#!/usr/bin/env bash
# Grafana OIDC integration preset
# https://grafana.com/docs/grafana/latest/setup-grafana/configure-security/configure-authentication/generic-oauth/

PRESET_NAME="grafana"
PRESET_DESCRIPTION="Grafana monitoring dashboard"
PRESET_SCOPES="openid profile email groups"
PRESET_REQUIRE_PKCE=false
PRESET_PUBLIC=false
PRESET_LDAP_SUPPORTED=true

# Generate redirect URI from app domain
preset_redirect_uri() {
  local DOMAIN="$1"
  echo "https://${DOMAIN}/login/generic_oauth"
}

# Environment variables for Grafana
preset_env_vars() {
  local SERVICE="$1"
  local APP="$2"
  local CLIENT_ID="$3"
  local CLIENT_SECRET="$4"
  local AUTH_DOMAIN="$5"

  cat <<EOF
GF_AUTH_GENERIC_OAUTH_ENABLED=true
GF_AUTH_GENERIC_OAUTH_NAME=Authelia
GF_AUTH_GENERIC_OAUTH_CLIENT_ID=$CLIENT_ID
GF_AUTH_GENERIC_OAUTH_CLIENT_SECRET=$CLIENT_SECRET
GF_AUTH_GENERIC_OAUTH_SCOPES=openid profile email groups
GF_AUTH_GENERIC_OAUTH_AUTH_URL=https://${AUTH_DOMAIN}/api/oidc/authorization
GF_AUTH_GENERIC_OAUTH_TOKEN_URL=https://${AUTH_DOMAIN}/api/oidc/token
GF_AUTH_GENERIC_OAUTH_API_URL=https://${AUTH_DOMAIN}/api/oidc/userinfo
GF_AUTH_GENERIC_OAUTH_LOGIN_ATTRIBUTE_PATH=preferred_username
GF_AUTH_GENERIC_OAUTH_GROUPS_ATTRIBUTE_PATH=groups
GF_AUTH_GENERIC_OAUTH_NAME_ATTRIBUTE_PATH=name
GF_AUTH_GENERIC_OAUTH_ROLE_ATTRIBUTE_PATH=contains(groups[*], 'admins') && 'Admin' || 'Viewer'
GF_AUTH_GENERIC_OAUTH_USE_PKCE=true
GF_AUTH_GENERIC_OAUTH_AUTO_LOGIN=true
GF_AUTH_GENERIC_OAUTH_ALLOW_SIGN_UP=true
GF_AUTH_DISABLE_LOGIN_FORM=true
EOF
}

# Post-integration instructions
preset_instructions() {
  local SERVICE="$1"
  local APP="$2"
  local CLIENT_ID="$3"
  local AUTH_DOMAIN="$4"

  cat <<EOF

Grafana OIDC Setup Instructions:
================================

Environment variables have been configured (if --set-env was used).

Additional Configuration (optional):
------------------------------------

1. Role Mapping via Groups:
   Add to environment or grafana.ini:

   GF_AUTH_GENERIC_OAUTH_ROLE_ATTRIBUTE_PATH=contains(groups[*], 'grafana_admin') && 'Admin' || contains(groups[*], 'grafana_editor') && 'Editor' || 'Viewer'

2. Create groups in LLDAP:
   - grafana_admin: Full admin access
   - grafana_editor: Can edit dashboards
   - (default): Viewer access

3. To enable auto-login (skip Grafana login page):
   GF_AUTH_GENERIC_OAUTH_AUTO_LOGIN=true

4. To disable local Grafana authentication:
   GF_AUTH_DISABLE_LOGIN_FORM=true

EOF
}

# LDAP configuration instructions for Grafana
preset_ldap_config() {
  local SERVICE="$1"
  local LDAP_HOST="$2"
  local LDAP_PORT="$3"
  local BASE_DN="$4"
  local BIND_DN="$5"

  cat <<EOF
Grafana LDAP Setup Instructions:
================================

Create /etc/grafana/ldap.toml (mount as volume):

$(preset_generate_ldap_toml "$LDAP_HOST" "$LDAP_PORT" "$BASE_DN" "$BIND_DN" "<password>")

Then set environment variables:
$(preset_ldap_env_vars)

EOF
}

# Generate the actual ldap.toml content (for automation)
preset_generate_ldap_toml() {
  local LDAP_HOST="$1"
  local LDAP_PORT="$2"
  local BASE_DN="$3"
  local BIND_DN="$4"
  local BIND_PASSWORD="$5"

  cat <<EOF
[[servers]]
host = "$LDAP_HOST"
port = $LDAP_PORT
use_ssl = false
start_tls = false
ssl_skip_verify = true
bind_dn = "$BIND_DN"
bind_password = "$BIND_PASSWORD"
search_base_dns = ["ou=people,$BASE_DN"]
search_filter = "(uid=%s)"

[servers.attributes]
name = "displayName"
surname = "sn"
username = "uid"
member_of = "memberOf"
email = "mail"

[[servers.group_mappings]]
group_dn = "cn=grafana_admin,ou=groups,$BASE_DN"
org_role = "Admin"

[[servers.group_mappings]]
group_dn = "cn=grafana_editor,ou=groups,$BASE_DN"
org_role = "Editor"

[[servers.group_mappings]]
group_dn = "*"
org_role = "Viewer"
EOF
}

# Environment variables for LDAP mode
preset_ldap_env_vars() {
  cat <<EOF
GF_AUTH_LDAP_ENABLED=true
GF_AUTH_LDAP_CONFIG_FILE=/etc/grafana/ldap.toml
GF_AUTH_LDAP_ALLOW_SIGN_UP=true
EOF
}
