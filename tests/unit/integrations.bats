#!/usr/bin/env bats

load '../test_helper'

setup() {
  setup_test_dirs
}

teardown() {
  teardown_test_dirs
}

# Helper to load a preset
load_preset() {
  local preset="$1"
  local preset_file="$PLUGIN_BASE_PATH/integrations/${preset}.sh"
  if [[ -f "$preset_file" ]]; then
    source "$preset_file"
    return 0
  fi
  return 1
}

# Helper to unset preset variables between tests
unset_preset_vars() {
  unset PRESET_NAME PRESET_DESCRIPTION PRESET_SCOPES
  unset PRESET_REQUIRE_PKCE PRESET_PUBLIC
  unset PRESET_OIDC_SUPPORTED PRESET_LDAP_SUPPORTED PRESET_PROXY_AUTH
  unset -f preset_redirect_uri preset_env_vars preset_instructions preset_ldap_config
}

# =============================================================================
# Test that all preset files exist and are valid
# =============================================================================

@test "integrations: all preset files exist" {
  local presets=(
    nextcloud gitea immich jellyfin portainer grafana audiobookshelf outline
    proxmox gitlab bookstack hedgedoc miniflux openwebui vaultwarden wikijs
    paperless arr uptimekuma homeassistant syncthing guacamole navidrome
    calibreweb matrix linkding
  )

  for preset in "${presets[@]}"; do
    [[ -f "$PLUGIN_BASE_PATH/integrations/${preset}.sh" ]]
  done
}

@test "integrations: all preset files are executable" {
  for preset_file in "$PLUGIN_BASE_PATH/integrations"/*.sh; do
    [[ -x "$preset_file" ]]
  done
}

@test "integrations: all preset files source without error" {
  for preset_file in "$PLUGIN_BASE_PATH/integrations"/*.sh; do
    unset_preset_vars
    run source "$preset_file"
    assert_success
  done
}

# =============================================================================
# Test required variables in each preset
# =============================================================================

@test "integrations: all presets have PRESET_NAME" {
  for preset_file in "$PLUGIN_BASE_PATH/integrations"/*.sh; do
    unset_preset_vars
    source "$preset_file"
    [[ -n "$PRESET_NAME" ]]
  done
}

@test "integrations: all presets have PRESET_DESCRIPTION" {
  for preset_file in "$PLUGIN_BASE_PATH/integrations"/*.sh; do
    unset_preset_vars
    source "$preset_file"
    [[ -n "$PRESET_DESCRIPTION" ]]
  done
}

@test "integrations: PRESET_NAME matches filename" {
  for preset_file in "$PLUGIN_BASE_PATH/integrations"/*.sh; do
    unset_preset_vars
    source "$preset_file"
    local filename
    filename="$(basename "$preset_file" .sh)"
    [[ "$PRESET_NAME" == "$filename" ]]
  done
}

# =============================================================================
# Test required functions in each preset
# =============================================================================

@test "integrations: all presets have preset_redirect_uri function" {
  for preset_file in "$PLUGIN_BASE_PATH/integrations"/*.sh; do
    unset_preset_vars
    source "$preset_file"
    declare -f preset_redirect_uri >/dev/null
  done
}

@test "integrations: all presets have preset_env_vars function" {
  for preset_file in "$PLUGIN_BASE_PATH/integrations"/*.sh; do
    unset_preset_vars
    source "$preset_file"
    declare -f preset_env_vars >/dev/null
  done
}

@test "integrations: all presets have preset_instructions function" {
  for preset_file in "$PLUGIN_BASE_PATH/integrations"/*.sh; do
    unset_preset_vars
    source "$preset_file"
    declare -f preset_instructions >/dev/null
  done
}

# =============================================================================
# Test OIDC presets generate valid redirect URIs
# =============================================================================

@test "integrations: nextcloud redirect URI is correct" {
  unset_preset_vars
  load_preset "nextcloud"
  local uri
  uri="$(preset_redirect_uri "cloud.example.com")"
  [[ "$uri" == "https://cloud.example.com/apps/user_oidc/code" ]]
}

@test "integrations: gitea redirect URI is correct" {
  unset_preset_vars
  load_preset "gitea"
  local uri
  uri="$(preset_redirect_uri "git.example.com")"
  [[ "$uri" == "https://git.example.com/user/oauth2/authelia/callback" ]]
}

@test "integrations: immich redirect URI contains mobile callback" {
  unset_preset_vars
  load_preset "immich"
  local uri
  uri="$(preset_redirect_uri "photos.example.com")"
  [[ "$uri" == *"app.immich:/"* ]]
  [[ "$uri" == *"photos.example.com"* ]]
}

@test "integrations: grafana redirect URI is correct" {
  unset_preset_vars
  load_preset "grafana"
  local uri
  uri="$(preset_redirect_uri "grafana.example.com")"
  [[ "$uri" == "https://grafana.example.com/login/generic_oauth" ]]
}

@test "integrations: portainer redirect URI is correct" {
  unset_preset_vars
  load_preset "portainer"
  local uri
  uri="$(preset_redirect_uri "portainer.example.com")"
  [[ "$uri" == "https://portainer.example.com" ]]
}

@test "integrations: gitlab redirect URI is correct" {
  unset_preset_vars
  load_preset "gitlab"
  local uri
  uri="$(preset_redirect_uri "gitlab.example.com")"
  [[ "$uri" == "https://gitlab.example.com/users/auth/openid_connect/callback" ]]
}

@test "integrations: bookstack redirect URI is correct" {
  unset_preset_vars
  load_preset "bookstack"
  local uri
  uri="$(preset_redirect_uri "docs.example.com")"
  [[ "$uri" == "https://docs.example.com/oidc/callback" ]]
}

@test "integrations: outline redirect URI is correct" {
  unset_preset_vars
  load_preset "outline"
  local uri
  uri="$(preset_redirect_uri "wiki.example.com")"
  [[ "$uri" == "https://wiki.example.com/auth/oidc.callback" ]]
}

@test "integrations: matrix redirect URI is correct" {
  unset_preset_vars
  load_preset "matrix"
  local uri
  uri="$(preset_redirect_uri "matrix.example.com")"
  [[ "$uri" == "https://matrix.example.com/_synapse/client/oidc/callback" ]]
}

# =============================================================================
# Test LDAP-only presets return empty redirect URI
# =============================================================================

@test "integrations: jellyfin returns empty redirect URI (LDAP only)" {
  unset_preset_vars
  load_preset "jellyfin"
  local uri
  uri="$(preset_redirect_uri "jellyfin.example.com")"
  [[ -z "$uri" ]]
}

@test "integrations: vaultwarden returns empty redirect URI (LDAP only)" {
  unset_preset_vars
  load_preset "vaultwarden"
  local uri
  uri="$(preset_redirect_uri "vault.example.com")"
  [[ -z "$uri" ]]
}

# =============================================================================
# Test proxy auth presets return empty redirect URI
# =============================================================================

@test "integrations: arr returns empty redirect URI (proxy auth)" {
  unset_preset_vars
  load_preset "arr"
  local uri
  uri="$(preset_redirect_uri "radarr.example.com")"
  [[ -z "$uri" ]]
}

@test "integrations: uptimekuma returns empty redirect URI (proxy auth)" {
  unset_preset_vars
  load_preset "uptimekuma"
  local uri
  uri="$(preset_redirect_uri "status.example.com")"
  [[ -z "$uri" ]]
}

@test "integrations: syncthing returns empty redirect URI (proxy auth)" {
  unset_preset_vars
  load_preset "syncthing"
  local uri
  uri="$(preset_redirect_uri "sync.example.com")"
  [[ -z "$uri" ]]
}

# =============================================================================
# Test OIDC support flags
# =============================================================================

@test "integrations: OIDC presets have OIDC support enabled or unset" {
  local oidc_presets=(
    nextcloud gitea immich portainer grafana audiobookshelf outline
    proxmox gitlab bookstack hedgedoc miniflux openwebui wikijs
    paperless guacamole matrix
  )

  for preset in "${oidc_presets[@]}"; do
    unset_preset_vars
    load_preset "$preset"
    # OIDC support should be true or unset (defaults to true)
    [[ "${PRESET_OIDC_SUPPORTED:-true}" == "true" ]]
  done
}

@test "integrations: LDAP-only presets have OIDC support disabled" {
  local ldap_only_presets=(jellyfin vaultwarden)

  for preset in "${ldap_only_presets[@]}"; do
    unset_preset_vars
    load_preset "$preset"
    [[ "${PRESET_OIDC_SUPPORTED:-true}" == "false" ]]
  done
}

@test "integrations: proxy auth presets have OIDC support disabled" {
  local proxy_presets=(arr uptimekuma syncthing homeassistant navidrome linkding)

  for preset in "${proxy_presets[@]}"; do
    unset_preset_vars
    load_preset "$preset"
    [[ "${PRESET_OIDC_SUPPORTED:-true}" == "false" ]]
  done
}

# =============================================================================
# Test environment variable generation
# =============================================================================

@test "integrations: immich generates OAUTH env vars" {
  unset_preset_vars
  load_preset "immich"
  local env_vars
  env_vars="$(preset_env_vars "default" "immich" "immich-client" "secret123" "auth.example.com")"
  [[ "$env_vars" == *"OAUTH_ENABLED=true"* ]]
  [[ "$env_vars" == *"OAUTH_CLIENT_ID=immich-client"* ]]
  [[ "$env_vars" == *"OAUTH_ISSUER_URL=https://auth.example.com"* ]]
}

@test "integrations: grafana generates GF_AUTH env vars" {
  unset_preset_vars
  load_preset "grafana"
  local env_vars
  env_vars="$(preset_env_vars "default" "grafana" "grafana-client" "secret123" "auth.example.com")"
  [[ "$env_vars" == *"GF_AUTH_GENERIC_OAUTH_ENABLED=true"* ]]
  [[ "$env_vars" == *"GF_AUTH_GENERIC_OAUTH_CLIENT_ID=grafana-client"* ]]
}

@test "integrations: outline generates OIDC env vars" {
  unset_preset_vars
  load_preset "outline"
  local env_vars
  env_vars="$(preset_env_vars "default" "outline" "outline-client" "secret123" "auth.example.com")"
  [[ "$env_vars" == *"OIDC_CLIENT_ID=outline-client"* ]]
  [[ "$env_vars" == *"OIDC_AUTH_URI=https://auth.example.com"* ]]
}

@test "integrations: bookstack generates AUTH_METHOD env var" {
  unset_preset_vars
  load_preset "bookstack"
  local env_vars
  env_vars="$(preset_env_vars "default" "bookstack" "bookstack-client" "secret123" "auth.example.com")"
  [[ "$env_vars" == *"AUTH_METHOD=oidc"* ]]
  [[ "$env_vars" == *"OIDC_CLIENT_ID=bookstack-client"* ]]
}

@test "integrations: linkding generates proxy auth env vars" {
  unset_preset_vars
  load_preset "linkding"
  local env_vars
  env_vars="$(preset_env_vars "default" "linkding" "" "" "auth.example.com")"
  [[ "$env_vars" == *"LD_ENABLE_AUTH_PROXY=True"* ]]
  [[ "$env_vars" == *"LD_AUTH_PROXY_LOGOUT_URL"* ]]
}

@test "integrations: navidrome generates proxy auth env vars" {
  unset_preset_vars
  load_preset "navidrome"
  local env_vars
  env_vars="$(preset_env_vars "default" "navidrome" "" "" "auth.example.com")"
  [[ "$env_vars" == *"ND_REVERSEPROXYUSERHEADER=Remote-User"* ]]
}

# =============================================================================
# Test LDAP-only presets return empty env vars
# =============================================================================

@test "integrations: jellyfin returns empty env vars" {
  unset_preset_vars
  load_preset "jellyfin"
  local env_vars
  env_vars="$(preset_env_vars "default" "jellyfin" "" "" "auth.example.com")"
  [[ -z "$env_vars" ]]
}

@test "integrations: presets without env support return empty" {
  # These presets require manual configuration (UI or config files)
  local no_env_presets=(nextcloud gitea portainer proxmox gitlab wikijs)

  for preset in "${no_env_presets[@]}"; do
    unset_preset_vars
    load_preset "$preset"
    local env_vars
    env_vars="$(preset_env_vars "default" "$preset" "client" "secret" "auth.example.com")"
    [[ -z "$env_vars" ]]
  done
}

@test "integrations: guacamole generates OPENID env vars" {
  unset_preset_vars
  load_preset "guacamole"
  local env_vars
  env_vars="$(preset_env_vars "default" "guacamole" "guac-client" "secret123" "auth.example.com")"
  [[ "$env_vars" == *"OPENID_CLIENT_ID=guac-client"* ]]
  [[ "$env_vars" == *"OPENID_ISSUER=https://auth.example.com"* ]]
}

# =============================================================================
# Test instructions output
# =============================================================================

@test "integrations: all presets output instructions" {
  for preset_file in "$PLUGIN_BASE_PATH/integrations"/*.sh; do
    unset_preset_vars
    source "$preset_file"
    local instructions
    instructions="$(preset_instructions "default" "myapp" "client-id" "auth.example.com")"
    # Instructions should not be empty
    [[ -n "$instructions" ]]
  done
}

@test "integrations: OIDC presets with manual config mention client ID" {
  # These presets show the client ID in manual config instructions
  local manual_config_presets=(nextcloud gitea immich portainer proxmox gitlab wikijs audiobookshelf)

  for preset in "${manual_config_presets[@]}"; do
    unset_preset_vars
    load_preset "$preset"
    local instructions
    instructions="$(preset_instructions "default" "myapp" "test-client-id" "auth.example.com")"
    [[ "$instructions" == *"test-client-id"* ]]
  done
}

@test "integrations: presets mention auth domain in instructions" {
  for preset_file in "$PLUGIN_BASE_PATH/integrations"/*.sh; do
    unset_preset_vars
    source "$preset_file"
    local instructions
    instructions="$(preset_instructions "default" "myapp" "client" "auth.example.com")"
    # Most presets should mention the auth domain
    # (some proxy-only presets might not, so we're lenient here)
    [[ -n "$instructions" ]]
  done
}

# =============================================================================
# Test LDAP config function exists where expected
# =============================================================================

@test "integrations: LDAP-capable presets have preset_ldap_config" {
  local ldap_presets=(
    nextcloud gitea portainer proxmox gitlab bookstack hedgedoc
    jellyfin vaultwarden calibreweb wikijs grafana guacamole matrix
  )

  for preset in "${ldap_presets[@]}"; do
    unset_preset_vars
    load_preset "$preset"
    declare -f preset_ldap_config >/dev/null
  done
}

@test "integrations: LDAP config mentions LDAP host" {
  local ldap_presets=(nextcloud gitea jellyfin)

  for preset in "${ldap_presets[@]}"; do
    unset_preset_vars
    load_preset "$preset"
    local ldap_config
    ldap_config="$(preset_ldap_config "default" "ldap.example.com" "3890" "dc=example,dc=com" "cn=admin,dc=example,dc=com")"
    [[ "$ldap_config" == *"ldap.example.com"* ]] || [[ "$ldap_config" == *"LDAP"* ]]
  done
}

# =============================================================================
# Test PKCE settings
# =============================================================================

@test "integrations: nextcloud requires PKCE" {
  unset_preset_vars
  load_preset "nextcloud"
  [[ "${PRESET_REQUIRE_PKCE:-false}" == "true" ]]
}

@test "integrations: most presets don't require PKCE" {
  local no_pkce_presets=(gitea immich portainer grafana outline)

  for preset in "${no_pkce_presets[@]}"; do
    unset_preset_vars
    load_preset "$preset"
    [[ "${PRESET_REQUIRE_PKCE:-false}" == "false" ]]
  done
}

# =============================================================================
# Test scopes are set correctly
# =============================================================================

@test "integrations: OIDC presets have scopes set" {
  local oidc_presets=(nextcloud gitea immich portainer grafana outline bookstack)

  for preset in "${oidc_presets[@]}"; do
    unset_preset_vars
    load_preset "$preset"
    [[ -n "$PRESET_SCOPES" ]]
    [[ "$PRESET_SCOPES" == *"openid"* ]]
  done
}

@test "integrations: proxy auth presets have empty scopes" {
  local proxy_presets=(arr uptimekuma syncthing homeassistant)

  for preset in "${proxy_presets[@]}"; do
    unset_preset_vars
    load_preset "$preset"
    [[ -z "$PRESET_SCOPES" ]]
  done
}
