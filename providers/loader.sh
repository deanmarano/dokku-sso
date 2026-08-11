#!/usr/bin/env bash
# Provider loader - sources the appropriate provider based on service config

# Write content to a file atomically, handling root-owned files.
# Uses temp file + mv so only directory write permission is needed,
# not write permission on the existing file itself.
# Arguments: FILE CONTENT [MODE]
safe_write() {
  local FILE="$1"
  local CONTENT="$2"
  local MODE="${3:-0600}"
  local TMP
  TMP=$(mktemp "$(dirname "$FILE")/$(basename "$FILE").XXXXXX")
  echo "$CONTENT" > "$TMP"
  chmod "$MODE" "$TMP"
  mv -f "$TMP" "$FILE"
}

# Load a directory provider for a service
load_directory_provider() {
  local SERVICE="$1"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/directory/$SERVICE"
  local PROVIDER

  if [[ -f "$SERVICE_ROOT/PROVIDER" ]]; then
    PROVIDER=$(cat "$SERVICE_ROOT/PROVIDER")
  else
    PROVIDER="$DEFAULT_DIRECTORY_PROVIDER"
  fi

  local PROVIDER_PATH="$PLUGIN_BASE_PATH/providers/directory/$PROVIDER/provider.sh"
  if [[ -f "$PROVIDER_PATH" ]]; then
    # shellcheck source=/dev/null
    source "$PROVIDER_PATH"
  else
    echo "!     Unknown directory provider: $PROVIDER" >&2
    exit 1
  fi
}

# Load a frontend provider for a service
load_frontend_provider() {
  local SERVICE="$1"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/frontend/$SERVICE"
  local PROVIDER

  if [[ -f "$SERVICE_ROOT/PROVIDER" ]]; then
    PROVIDER=$(cat "$SERVICE_ROOT/PROVIDER")
  else
    PROVIDER="$DEFAULT_FRONTEND_PROVIDER"
  fi

  local PROVIDER_PATH="$PLUGIN_BASE_PATH/providers/frontend/$PROVIDER/provider.sh"
  if [[ -f "$PROVIDER_PATH" ]]; then
    # shellcheck source=/dev/null
    source "$PROVIDER_PATH"
  else
    echo "!     Unknown frontend provider: $PROVIDER" >&2
    exit 1
  fi
}

# List available directory providers
list_directory_providers() {
  for provider_dir in "$PLUGIN_BASE_PATH/providers/directory"/*/; do
    local name
    name=$(basename "$provider_dir")
    [[ "$name" == "_template" ]] && continue
    [[ -f "$provider_dir/provider.sh" ]] && echo "$name"
  done
}

# List available frontend providers
list_frontend_providers() {
  for provider_dir in "$PLUGIN_BASE_PATH/providers/frontend"/*/; do
    local name
    name=$(basename "$provider_dir")
    [[ "$name" == "_template" ]] && continue
    [[ -f "$provider_dir/provider.sh" ]] && echo "$name"
  done
}

# Check if a directory service exists
directory_service_exists() {
  local SERVICE="$1"
  [[ -d "$PLUGIN_DATA_ROOT/directory/$SERVICE" ]]
}

# Check if a frontend service exists
frontend_service_exists() {
  local SERVICE="$1"
  [[ -d "$PLUGIN_DATA_ROOT/frontend/$SERVICE" ]]
}

# Get the container name for a directory service
get_directory_container_name() {
  local SERVICE="$1"
  echo "dokku.sso.directory.$SERVICE"
}

# Get the container name for a frontend service
get_frontend_container_name() {
  local SERVICE="$1"
  echo "dokku.sso.frontend.$SERVICE"
}

# Get the Dokku app name for a directory service
get_directory_app_name() {
  local SERVICE="$1"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/directory/$SERVICE"
  if [[ -f "$SERVICE_ROOT/APP_NAME" ]]; then
    cat "$SERVICE_ROOT/APP_NAME"
  else
    echo ""
  fi
}

# Get the Dokku app name for a frontend service
get_frontend_app_name() {
  local SERVICE="$1"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/frontend/$SERVICE"
  if [[ -f "$SERVICE_ROOT/APP_NAME" ]]; then
    cat "$SERVICE_ROOT/APP_NAME"
  else
    echo ""
  fi
}

# Read one field from a forward-auth descriptor file.
#
# The descriptor is how a frontend provider describes its forward auth without
# knowing which proxy will render it: key=value lines, emitted by
# provider_forward_auth_descriptor. Keeps frontends x proxies from becoming
# NxM code -- each side implements one thing.
fn-descriptor-get() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 0
  local line
  line="$(grep -m1 "^${key}=" "$file" 2>/dev/null || true)"
  printf '%s' "${line#*=}"
}

# Load the proxy adapter for an app, chosen by the proxy actually in front of
# it. "Proxy type" holds only an explicit per-app override and is usually
# empty; the computed value folds in the global default.
load_proxy_adapter() {
  local APP="$1"
  local PROXY

  # Derive our own location when config has not been sourced. Without this the
  # adapter lookup below fails and reports the proxy as unsupported, which
  # reads as "this proxy cannot be protected" rather than "the plugin is
  # misconfigured".
  local BASE_PATH="${PLUGIN_BASE_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

  PROXY="$("$DOKKU_BIN" proxy:report "$APP" --proxy-computed-type < /dev/null 2>/dev/null | xargs || true)"
  [[ -z "$PROXY" ]] && PROXY="nginx"

  local ADAPTER_PATH="$BASE_PATH/providers/proxy/$PROXY/proxy.sh"
  if [[ ! -f "$ADAPTER_PATH" ]]; then
    echo "!     $APP is served by the $PROXY proxy, which dokku-sso cannot protect" >&2
    local supported=""
    local d
    for d in "$BASE_PATH/providers/proxy"/*/; do
      [[ -d "$d" ]] || continue
      supported+="$(basename "$d") "
    done
    echo "       Supported: $supported" >&2
    echo "       The app is reachable without authentication until this is resolved." >&2
    return 1
  fi

  # shellcheck source=/dev/null
  source "$ADAPTER_PATH"
}
