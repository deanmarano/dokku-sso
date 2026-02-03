#!/usr/bin/env bash
# Provider loader - sources the appropriate provider based on service config

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
  echo "dokku.auth.directory.$SERVICE"
}

# Get the container name for a frontend service
get_frontend_container_name() {
  local SERVICE="$1"
  echo "dokku.auth.frontend.$SERVICE"
}
