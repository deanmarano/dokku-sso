#!/usr/bin/env bash
# Jellyseerr integration preset (supports OIDC!)
# https://github.com/Fallenbagel/jellyseerr
# Fork of Overseerr for Jellyfin

PRESET_NAME="jellyseerr"
PRESET_DESCRIPTION="Jellyseerr media request manager (OIDC)"
PRESET_SCOPES="openid profile email"
PRESET_REQUIRE_PKCE=false
PRESET_PUBLIC=false
PRESET_OIDC_SUPPORTED=true
PRESET_LDAP_SUPPORTED=false
PRESET_PROXY_AUTH=true

# OIDC redirect URI (same as Overseerr)
preset_redirect_uri() {
  local DOMAIN="$1"
  echo "https://${DOMAIN}/api/v1/auth/oidc-callback"
}

# No env var configuration - requires UI setup
preset_env_vars() {
  echo ""
}

# Post-integration instructions
preset_instructions() {
  local SERVICE="$1"
  local APP="$2"
  local CLIENT_ID="$3"
  local AUTH_DOMAIN="$4"

  cat <<EOF

Jellyseerr OIDC Setup Instructions:
===================================

Jellyseerr is a fork of Overseerr with Jellyfin support.
OIDC configuration is identical to Overseerr.

1. In Jellyseerr, go to Settings > Users > OIDC

2. Configure the following:
   - Enable OIDC: checked
   - OIDC Name: Authelia (or your preferred name)
   - OIDC Client ID: $CLIENT_ID
   - OIDC Client Secret: <from dokku auth:oidc:show $SERVICE $CLIENT_ID>
   - OIDC Authorization URL: https://${AUTH_DOMAIN}/api/oidc/authorization
   - OIDC Token URL: https://${AUTH_DOMAIN}/api/oidc/token
   - OIDC Userinfo URL: https://${AUTH_DOMAIN}/api/oidc/userinfo
   - Redirect URL: https://<your-jellyseerr-domain>/api/v1/auth/oidc-callback

3. Save and test the configuration

Optional - Forward Auth (additional protection):
------------------------------------------------
dokku auth:protect $APP \\
  --service $SERVICE \\
  --bypass-path "/api/v1/auth/*" \\
  --bypass-path "/api/v1/status"

Jellyfin Integration:
---------------------
Jellyseerr can also use Jellyfin authentication.
OIDC provides a unified auth experience if you have
multiple services using Authelia/LLDAP.

EOF
}

# No LDAP support
preset_ldap_config() {
  cat <<EOF
Jellyseerr LDAP Support:
========================

Jellyseerr does not support LDAP directly.
Use OIDC authentication instead (supported!).

dokku auth:oidc:add <service> jellyseerr --preset jellyseerr --domain <domain>

EOF
}
