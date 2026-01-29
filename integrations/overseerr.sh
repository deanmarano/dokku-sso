#!/usr/bin/env bash
# Overseerr integration preset (supports OIDC!)
# https://overseerr.dev

PRESET_NAME="overseerr"
PRESET_DESCRIPTION="Overseerr media request manager (OIDC)"
PRESET_SCOPES="openid profile email"
PRESET_REQUIRE_PKCE=false
PRESET_PUBLIC=false
PRESET_OIDC_SUPPORTED=true
PRESET_LDAP_SUPPORTED=false
PRESET_PROXY_AUTH=true

# OIDC redirect URI
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

Overseerr OIDC Setup Instructions:
==================================

1. In Overseerr, go to Settings > Users > OIDC

2. Configure the following:
   - Enable OIDC: checked
   - OIDC Name: Authelia (or your preferred name)
   - OIDC Client ID: $CLIENT_ID
   - OIDC Client Secret: <from dokku auth:oidc:show $SERVICE $CLIENT_ID>
   - OIDC Authorization URL: https://${AUTH_DOMAIN}/api/oidc/authorization
   - OIDC Token URL: https://${AUTH_DOMAIN}/api/oidc/token
   - OIDC Userinfo URL: https://${AUTH_DOMAIN}/api/oidc/userinfo
   - Redirect URL: https://<your-overseerr-domain>/api/v1/auth/oidc-callback

3. Save and test the configuration

Optional - Forward Auth (additional protection):
------------------------------------------------
You can also add forward auth for extra protection:

dokku auth:protect $APP \\
  --service $SERVICE \\
  --bypass-path "/api/v1/auth/*" \\
  --bypass-path "/api/v1/status"

This protects the UI while allowing OIDC callbacks.

Plex/Jellyfin Integration:
--------------------------
Overseerr can also use Plex or Jellyfin authentication.
OIDC provides a unified auth experience across your homelab.

EOF
}

# No LDAP support
preset_ldap_config() {
  cat <<EOF
Overseerr LDAP Support:
=======================

Overseerr does not support LDAP directly.
Use OIDC authentication instead (supported!).

dokku auth:oidc:add <service> overseerr --preset overseerr --domain <domain>

EOF
}
