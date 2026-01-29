#!/usr/bin/env bash
# Sonarr integration preset
# https://sonarr.tv

PRESET_NAME="sonarr"
PRESET_DESCRIPTION="Sonarr TV series collection manager"
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

Sonarr Setup Instructions:
==========================

Sonarr does not support OIDC or LDAP natively.
Use Authelia forward auth to protect it.

Protect the App:
----------------
dokku auth:protect $APP \\
  --service $SERVICE \\
  --bypass-path "/api/*" \\
  --bypass-path "/feed/*"

Bypass paths allow:
- /api/* - API access for Overseerr, download clients, etc.
- /feed/* - RSS feeds for external readers (calendar, etc.)

API Key Authentication:
-----------------------
Find your API key in: Settings > General > Security

For external apps, use:
  https://<domain>/api/v3/...?apikey=<your-api-key>

Header Authentication (Optional):
---------------------------------
Sonarr supports external authentication via headers.
In Settings > General > Authentication:
- Authentication: External
- Authentication Required: Disabled for API

Additional Bypass Paths (if needed):
------------------------------------
--bypass-path "/ping"       # Health checks
--bypass-path "/initialize" # First-run setup
--bypass-path "/calendar/*" # Calendar integrations

EOF
}

# No LDAP support
preset_ldap_config() {
  cat <<EOF
Sonarr LDAP Support:
====================

Sonarr does not support LDAP authentication.
Use forward auth (dokku auth:protect) instead.

EOF
}
