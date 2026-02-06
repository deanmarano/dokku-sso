#!/usr/bin/env bash
# Immich OIDC integration preset
# https://immich.app/docs/administration/oauth

PRESET_NAME="immich"
PRESET_DESCRIPTION="Immich photo management"
PRESET_SCOPES="openid profile email"
PRESET_REQUIRE_PKCE=false
PRESET_PUBLIC=false

# Generate redirect URI from app domain
# Immich uses multiple redirect URIs for web and mobile
preset_redirect_uri() {
  local DOMAIN="$1"
  # Web callback and mobile app callback
  echo "https://${DOMAIN}/auth/login,https://${DOMAIN}/user-settings,app.immich:/"
}

# Environment variables for Immich
preset_env_vars() {
  local SERVICE="$1"
  local APP="$2"
  local CLIENT_ID="$3"
  local CLIENT_SECRET="$4"
  local AUTH_DOMAIN="$5"

  cat <<EOF
OAUTH_ENABLED=true
OAUTH_ISSUER_URL=https://${AUTH_DOMAIN}
OAUTH_CLIENT_ID=$CLIENT_ID
OAUTH_CLIENT_SECRET=$CLIENT_SECRET
OAUTH_SCOPE=openid profile email
OAUTH_AUTO_REGISTER=true
OAUTH_BUTTON_TEXT=Login with Authelia
EOF
}

# Post-integration instructions
preset_instructions() {
  local SERVICE="$1"
  local APP="$2"
  local CLIENT_ID="$3"
  local AUTH_DOMAIN="$4"

  cat <<EOF

Immich OIDC Setup Instructions:
===============================

The environment variables have been set. Immich should now show
"Login with Authelia" on the login page.

Additional Configuration (via Admin UI):
----------------------------------------
1. Go to Administration > Settings > OAuth Authentication
2. Verify the settings match:
   - Enabled: Yes
   - Issuer URL: https://${AUTH_DOMAIN}
   - Client ID: $CLIENT_ID
   - Scope: openid profile email
   - Auto Register: Yes (recommended)

Optional Settings:
------------------
- Auto Launch: Opens OAuth login automatically
- Mobile Redirect URI Override: app.immich:/
- Storage Label Claim: preferred_username (for consistent folder names)

Note: The first user to log in via OAuth becomes the admin if no
admin account exists yet.

EOF
}

# LDAP is not supported by Immich
preset_ldap_config() {
  cat <<EOF
Immich LDAP Support:
====================

Immich does not natively support LDAP authentication.
Use OIDC integration instead.

EOF
}
