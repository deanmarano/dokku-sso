#!/usr/bin/env bash
# Home Assistant integration preset
# https://www.home-assistant.io/docs/authentication/providers/

PRESET_NAME="homeassistant"
PRESET_DESCRIPTION="Home Assistant home automation"
PRESET_SCOPES=""
PRESET_REQUIRE_PKCE=false
PRESET_PUBLIC=false
PRESET_OIDC_SUPPORTED=false
PRESET_LDAP_SUPPORTED=false
PRESET_PROXY_AUTH=true

# No OIDC redirect (Home Assistant has limited OIDC support)
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

Home Assistant Setup Instructions:
==================================

Home Assistant has limited external authentication support.
The main options are:

Option 1: Forward Auth (Header Authentication)
----------------------------------------------
Add to configuration.yaml:

homeassistant:
  auth_providers:
    - type: trusted_networks
      trusted_networks:
        - 172.16.0.0/12  # Docker network
      allow_bypass_login: true
    - type: homeassistant

http:
  use_x_forwarded_for: true
  trusted_proxies:
    - 172.16.0.0/12  # Docker network

Then protect with Authelia:
  dokku auth:protect $APP \\
    --service $SERVICE \\
    --bypass-path "/api/*" \\
    --bypass-path "/auth/*" \\
    --bypass-path "/local/*"

Note: This trusts the proxy network, so ensure only Authelia
can reach Home Assistant directly.

Option 2: Authelia as OIDC (Community Integration)
--------------------------------------------------
Use HACS (Home Assistant Community Store) to install:
https://github.com/christiaangoossens/hass-oidc-auth

This adds OIDC support to Home Assistant.

Bypass Paths Explained:
-----------------------
- /api/* - REST API for integrations, mobile app
- /auth/* - Built-in auth endpoints
- /local/* - Local static files

Mobile App:
-----------
The mobile app needs direct API access.
Either bypass /api/* or use local auth for the app.

EOF
}

# No native LDAP support
preset_ldap_config() {
  cat <<EOF
Home Assistant LDAP Support:
============================

Home Assistant does not natively support LDAP.

Options:
1. Use Authelia forward auth (trusted_networks provider)
2. Use HACS OIDC integration (community)
3. Use command_line auth provider with LDAP script

Command Line Auth Example:
--------------------------
In configuration.yaml:

homeassistant:
  auth_providers:
    - type: command_line
      command: /config/scripts/ldap_auth.sh
      args: []
      meta: true

Create ldap_auth.sh script that validates against LDAP.

EOF
}
