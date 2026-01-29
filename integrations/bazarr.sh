#!/usr/bin/env bash
# Bazarr integration preset
# https://bazarr.media

PRESET_NAME="bazarr"
PRESET_DESCRIPTION="Bazarr subtitle manager"
PRESET_SCOPES=""
PRESET_REQUIRE_PKCE=false
PRESET_PUBLIC=false
PRESET_OIDC_SUPPORTED=false
PRESET_LDAP_SUPPORTED=false
PRESET_PROXY_AUTH=true

# No OIDC redirect
preset_redirect_uri() {
  echo ""
}

# No OIDC env vars
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

Bazarr Setup Instructions:
==========================

Bazarr does not support OIDC or LDAP natively.
Use Authelia forward auth to protect it.

Protect the App:
----------------
dokku auth:protect $APP \\
  --service $SERVICE \\
  --bypass-path "/api/*"

Bypass paths allow:
- /api/* - API access for Radarr/Sonarr integration

API Key Authentication:
-----------------------
Find your API key in: Settings > General > Security

Bazarr integrates with Radarr and Sonarr to automatically
download subtitles for your media.

Header Authentication (Optional):
---------------------------------
Bazarr supports external authentication via headers.
In Settings > General > Security:
- Authentication: External

Additional Bypass Paths (if needed):
------------------------------------
--bypass-path "/ping"  # Health checks

EOF
}

# No LDAP support
preset_ldap_config() {
  cat <<EOF
Bazarr LDAP Support:
====================

Bazarr does not support LDAP authentication.
Use forward auth (dokku auth:protect) instead.

EOF
}
