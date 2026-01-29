#!/usr/bin/env bash
# Readarr integration preset
# https://readarr.com

PRESET_NAME="readarr"
PRESET_DESCRIPTION="Readarr book/audiobook collection manager"
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

Readarr Setup Instructions:
===========================

Readarr does not support OIDC or LDAP natively.
Use Authelia forward auth to protect it.

Protect the App:
----------------
dokku auth:protect $APP \\
  --service $SERVICE \\
  --bypass-path "/api/*" \\
  --bypass-path "/feed/*"

Bypass paths allow:
- /api/* - API access for automation tools
- /feed/* - RSS feeds

API Key Authentication:
-----------------------
Find your API key in: Settings > General > Security

For external apps, use:
  https://<domain>/api/v1/...?apikey=<your-api-key>

Note: Readarr uses API v1.

Header Authentication (Optional):
---------------------------------
Readarr supports external authentication via headers.
In Settings > General > Authentication:
- Authentication: External
- Authentication Required: Disabled for API

Integration with Calibre:
-------------------------
If using Calibre-Web for reading, consider:
dokku auth:integrate <service> calibreweb --preset calibreweb

Additional Bypass Paths (if needed):
------------------------------------
--bypass-path "/ping"       # Health checks
--bypass-path "/initialize" # First-run setup

EOF
}

# No LDAP support
preset_ldap_config() {
  cat <<EOF
Readarr LDAP Support:
=====================

Readarr does not support LDAP authentication.
Use forward auth (dokku auth:protect) instead.

EOF
}
