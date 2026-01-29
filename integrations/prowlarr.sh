#!/usr/bin/env bash
# Prowlarr integration preset
# https://prowlarr.com

PRESET_NAME="prowlarr"
PRESET_DESCRIPTION="Prowlarr indexer manager"
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

Prowlarr Setup Instructions:
============================

Prowlarr does not support OIDC or LDAP natively.
Use Authelia forward auth to protect it.

Protect the App:
----------------
dokku auth:protect $APP \\
  --service $SERVICE \\
  --bypass-path "/api/*" \\
  --bypass-path "/{indexer}/*"

Bypass paths allow:
- /api/* - API access for Radarr, Sonarr, etc.
- /{indexer}/* - Indexer proxying (Radarr/Sonarr access indexers through Prowlarr)

API Key Authentication:
-----------------------
Find your API key in: Settings > General > Security

Prowlarr syncs with your *arr apps automatically.
Make sure the API key is configured in each app's
Settings > Indexers > Prowlarr sync.

Header Authentication (Optional):
---------------------------------
Prowlarr supports external authentication via headers.
In Settings > General > Authentication:
- Authentication: External
- Authentication Required: Disabled for API

Important Note:
---------------
Prowlarr acts as an indexer proxy for other *arr apps.
Make sure the bypass paths allow your other apps to
communicate with Prowlarr's indexer endpoints.

Additional Bypass Paths (if needed):
------------------------------------
--bypass-path "/ping"       # Health checks
--bypass-path "/initialize" # First-run setup

EOF
}

# No LDAP support
preset_ldap_config() {
  cat <<EOF
Prowlarr LDAP Support:
======================

Prowlarr does not support LDAP authentication.
Use forward auth (dokku auth:protect) instead.

EOF
}
