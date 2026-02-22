#!/usr/bin/env bash
# shellcheck disable=SC2034
# LLDAP Directory Provider
# Lightweight LDAP server with web UI for user management — managed as a Dokku app
# SC2034 disabled: Variables are used when this script is sourced

# Provider metadata
PROVIDER_NAME="lldap"
PROVIDER_DISPLAY_NAME="LLDAP (Lightweight LDAP)"
PROVIDER_IMAGE="lldap/lldap"
PROVIDER_IMAGE_VERSION="stable"
PROVIDER_LDAP_PORT="3890"
PROVIDER_HTTP_PORT="17170"
PROVIDER_REQUIRED_CONFIG=""  # Auto-generates secrets

# Get the running container ID for the Dokku app
# Arguments: SERVICE
# Output: Docker container ID
get_running_container_id() {
  local SERVICE="$1"
  local APP_NAME
  APP_NAME=$(get_directory_app_name "$SERVICE")
  if [[ -z "$APP_NAME" ]]; then
    # Fall back to legacy container name
    local CONTAINER_NAME
    CONTAINER_NAME=$(get_directory_container_name "$SERVICE")
    docker ps -q -f "name=^${CONTAINER_NAME}$" -f status=running
    return
  fi
  docker ps -q -f "label=com.dokku.app-name=$APP_NAME" -f status=running | head -1
}

# Create and deploy LLDAP as a Dokku app
# Arguments: SERVICE - name of the service
provider_create_container() {
  local SERVICE="$1"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/directory/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"
  local DATA_DIR="$SERVICE_ROOT/data"

  # Determine app name
  local APP_NAME
  APP_NAME=$(get_directory_app_name "$SERVICE")
  if [[ -z "$APP_NAME" ]]; then
    APP_NAME="dokku-auth-dir-$SERVICE"
    echo "$APP_NAME" > "$SERVICE_ROOT/APP_NAME"
  fi

  # Generate secrets if not already set
  local JWT_SECRET BASE_DN ADMIN_PASSWORD HTTP_URL
  JWT_SECRET=$(cat "$CONFIG_DIR/JWT_SECRET" 2>/dev/null || openssl rand -base64 32)
  BASE_DN=$(cat "$CONFIG_DIR/BASE_DN" 2>/dev/null || echo "dc=dokku,dc=local")
  ADMIN_PASSWORD=$(cat "$CONFIG_DIR/ADMIN_PASSWORD" 2>/dev/null || openssl rand -base64 16 | tr -d '/+=')
  HTTP_URL=$(cat "$CONFIG_DIR/HTTP_URL" 2>/dev/null || echo "http://localhost:$PROVIDER_HTTP_PORT")

  # Save configuration
  mkdir -p "$CONFIG_DIR" "$DATA_DIR"
  echo "$JWT_SECRET" > "$CONFIG_DIR/JWT_SECRET"
  echo "$BASE_DN" > "$CONFIG_DIR/BASE_DN"
  echo "$ADMIN_PASSWORD" > "$CONFIG_DIR/ADMIN_PASSWORD"
  echo "$HTTP_URL" > "$CONFIG_DIR/HTTP_URL"
  chmod 600 "$CONFIG_DIR"/*

  # Create Dokku app if it doesn't exist
  if ! "$DOKKU_BIN" apps:exists "$APP_NAME" < /dev/null 2>/dev/null; then
    echo "-----> Creating Dokku app $APP_NAME"
    "$DOKKU_BIN" apps:create "$APP_NAME" < /dev/null
  fi

  # Mount data directory
  echo "-----> Mounting storage volumes"
  "$DOKKU_BIN" storage:mount "$APP_NAME" "$DATA_DIR:/data" < /dev/null 2>/dev/null || true

  # Set environment variables
  echo "-----> Setting environment variables"
  "$DOKKU_BIN" config:set --no-restart "$APP_NAME" \
    LLDAP_JWT_SECRET="$JWT_SECRET" \
    LLDAP_LDAP_BASE_DN="$BASE_DN" \
    LLDAP_LDAP_USER_PASS="$ADMIN_PASSWORD" \
    LLDAP_HTTP_URL="$HTTP_URL" \
    TZ="${TZ:-UTC}" < /dev/null

  # Attach to auth network
  echo "-----> Attaching to network $AUTH_NETWORK"
  "$DOKKU_BIN" network:set "$APP_NAME" attach-post-deploy "$AUTH_NETWORK" < /dev/null

  # Deploy from image
  echo "-----> Deploying $PROVIDER_IMAGE:$PROVIDER_IMAGE_VERSION"
  "$DOKKU_BIN" git:from-image "$APP_NAME" "$PROVIDER_IMAGE:$PROVIDER_IMAGE_VERSION" < /dev/null

  # Wait for app to be running
  echo "-----> Waiting for LLDAP to be ready"
  local retries=30
  while [[ $retries -gt 0 ]]; do
    if provider_is_running "$SERVICE"; then
      break
    fi
    sleep 2
    retries=$((retries - 1))
  done

  if [[ $retries -eq 0 ]]; then
    echo "!     LLDAP failed to start" >&2
    "$DOKKU_BIN" logs "$APP_NAME" --num 10 < /dev/null 2>&1 >&2
    return 1
  fi

  # Wait a moment for LLDAP HTTP API to be ready
  sleep 3

  # Create default users group
  provider_create_group "$SERVICE" "$DEFAULT_USERS_GROUP" || true
}

# Adopt an existing Dokku app as the LLDAP directory
# Arguments: SERVICE - name of the service, APP_NAME - name of the existing Dokku app
provider_adopt_app() {
  local SERVICE="$1"
  local APP_NAME="$2"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/directory/$SERVICE"

  # Validate the Dokku app exists
  if ! "$DOKKU_BIN" apps:exists "$APP_NAME" < /dev/null 2>/dev/null; then
    echo "!     Dokku app $APP_NAME does not exist" >&2
    return 1
  fi

  # Store app name
  echo "$APP_NAME" > "$SERVICE_ROOT/APP_NAME"

  # Attach to auth network
  "$DOKKU_BIN" network:set "$APP_NAME" attach-post-deploy "$AUTH_NETWORK" < /dev/null

  # Check if it's running
  if provider_is_running "$SERVICE"; then
    echo "       Status: running"
  else
    echo "!     Warning: app $APP_NAME is not currently running" >&2
  fi
}

# Get the LDAP port
provider_get_ldap_port() {
  echo "$PROVIDER_LDAP_PORT"
}

# Get bind credentials for apps
# Arguments: SERVICE
# Output: KEY=VALUE pairs
provider_get_bind_credentials() {
  local SERVICE="$1"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/directory/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"

  local APP_NAME
  APP_NAME=$(get_directory_app_name "$SERVICE")

  local BASE_DN ADMIN_PASSWORD
  BASE_DN=$(cat "$CONFIG_DIR/BASE_DN")
  ADMIN_PASSWORD=$(cat "$CONFIG_DIR/ADMIN_PASSWORD")

  if [[ -n "$APP_NAME" ]]; then
    echo "LDAP_URL=ldap://$APP_NAME.web:$PROVIDER_LDAP_PORT"
  else
    local CONTAINER_NAME
    CONTAINER_NAME=$(get_directory_container_name "$SERVICE")
    echo "LDAP_URL=ldap://$CONTAINER_NAME:$PROVIDER_LDAP_PORT"
  fi
  echo "LDAP_BASE_DN=$BASE_DN"
  echo "LDAP_BIND_DN=uid=admin,ou=people,$BASE_DN"
  echo "LDAP_BIND_PASSWORD=$ADMIN_PASSWORD"
}

# Validate provider configuration
provider_validate_config() {
  local SERVICE="$1"
  # LLDAP auto-generates everything, always valid
  return 0
}

# Verify the service is working
provider_verify() {
  local SERVICE="$1"
  local CONTAINER_ID
  CONTAINER_ID=$(get_running_container_id "$SERVICE")

  if [[ -z "$CONTAINER_ID" ]]; then
    echo "!     Container not running" >&2
    return 1
  fi

  # Check HTTP port using curl (available in lldap container)
  if docker exec "$CONTAINER_ID" curl -sf http://localhost:17170/ >/dev/null 2>&1; then
    echo "       HTTP port responding"
  else
    echo "!     HTTP port not responding" >&2
    return 1
  fi

  # LDAP port check - try login endpoint as proxy for LDAP health
  # (actual LDAP check would require ldapsearch which isn't in container)
  echo "       LDAP port assumed healthy (container running)"

  return 0
}

# Display provider configuration
provider_info() {
  local SERVICE="$1"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/directory/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"
  local APP_NAME
  APP_NAME=$(get_directory_app_name "$SERVICE")

  local BASE_DN HTTP_URL
  BASE_DN=$(cat "$CONFIG_DIR/BASE_DN" 2>/dev/null || echo "(not set)")
  HTTP_URL=$(cat "$CONFIG_DIR/HTTP_URL" 2>/dev/null || echo "(not set)")

  echo "       Provider: $PROVIDER_DISPLAY_NAME"
  echo "       Image: $PROVIDER_IMAGE:$PROVIDER_IMAGE_VERSION"
  if [[ -n "$APP_NAME" ]]; then
    echo "       Dokku App: $APP_NAME"
  else
    local CONTAINER_NAME
    CONTAINER_NAME=$(get_directory_container_name "$SERVICE")
    echo "       Container: $CONTAINER_NAME"
  fi
  echo "       LDAP Port: $PROVIDER_LDAP_PORT"
  echo "       HTTP Port: $PROVIDER_HTTP_PORT"
  echo "       Base DN: $BASE_DN"
  echo "       Web UI: $HTTP_URL"
}

# Get an authentication token from LLDAP
# Arguments: SERVICE
# Output: JWT token
provider_get_token() {
  local SERVICE="$1"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/directory/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"
  local CONTAINER_ID
  CONTAINER_ID=$(get_running_container_id "$SERVICE")

  local ADMIN_PASSWORD
  ADMIN_PASSWORD=$(cat "$CONFIG_DIR/ADMIN_PASSWORD")

  # Get token via internal API
  docker exec "$CONTAINER_ID" curl -s \
    -X POST "http://localhost:17170/auth/simple/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PASSWORD\"}" \
    | grep -o '"token":"[^"]*"' | cut -d'"' -f4
}

# Create a group in LLDAP
# Arguments: SERVICE GROUP_NAME
provider_create_group() {
  local SERVICE="$1"
  local GROUP_NAME="$2"
  local CONTAINER_ID
  CONTAINER_ID=$(get_running_container_id "$SERVICE")

  local TOKEN
  TOKEN=$(provider_get_token "$SERVICE")
  if [[ -z "$TOKEN" ]]; then
    echo "!     Failed to get authentication token" >&2
    return 1
  fi

  local RESPONSE
  RESPONSE=$(docker exec "$CONTAINER_ID" curl -s \
    -X POST "http://localhost:17170/api/graphql" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "{\"query\":\"mutation { createGroup(name: \\\"$GROUP_NAME\\\") { id displayName } }\"}")

  if echo "$RESPONSE" | grep -q '"createGroup"'; then
    return 0
  elif echo "$RESPONSE" | grep -q "already exists"; then
    return 0
  else
    echo "!     Failed to create group: $RESPONSE" >&2
    return 1
  fi
}

# Create a user in LLDAP
# Arguments: SERVICE USERNAME EMAIL PASSWORD
provider_create_user() {
  local SERVICE="$1"
  local USERNAME="$2"
  local EMAIL="$3"
  local PASSWORD="$4"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/directory/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"
  local CONTAINER_ID
  CONTAINER_ID=$(get_running_container_id "$SERVICE")

  local TOKEN ADMIN_PASSWORD
  TOKEN=$(provider_get_token "$SERVICE")
  ADMIN_PASSWORD=$(cat "$CONFIG_DIR/ADMIN_PASSWORD")

  if [[ -z "$TOKEN" ]]; then
    echo "!     Failed to get authentication token" >&2
    return 1
  fi

  # Create user via GraphQL
  local RESPONSE
  RESPONSE=$(docker exec "$CONTAINER_ID" curl -s \
    -X POST "http://localhost:17170/api/graphql" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "{\"query\":\"mutation { createUser(user: {id: \\\"$USERNAME\\\", email: \\\"$EMAIL\\\"}) { id } }\"}")

  if ! echo "$RESPONSE" | grep -q '"createUser"'; then
    if ! echo "$RESPONSE" | grep -q "already exists"; then
      echo "!     Failed to create user: $RESPONSE" >&2
      return 1
    fi
  fi

  # Set password using lldap_set_password tool
  docker exec "$CONTAINER_ID" /app/lldap_set_password \
    --base-url http://localhost:17170 \
    --admin-username admin --admin-password "$ADMIN_PASSWORD" \
    --username "$USERNAME" --password "$PASSWORD" 2>/dev/null || {
    echo "!     Failed to set password for $USERNAME" >&2
    return 1
  }
}

# Get group ID by name
# Arguments: SERVICE GROUP_NAME
# Output: Group ID (number)
provider_get_group_id() {
  local SERVICE="$1"
  local GROUP_NAME="$2"
  local CONTAINER_ID
  CONTAINER_ID=$(get_running_container_id "$SERVICE")

  local TOKEN
  TOKEN=$(provider_get_token "$SERVICE")

  docker exec "$CONTAINER_ID" curl -s \
    -X POST "http://localhost:17170/api/graphql" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d '{"query":"{ groups { id displayName } }"}' \
    | grep -o "{\"id\":[0-9]*,\"displayName\":\"$GROUP_NAME\"}" \
    | grep -o '"id":[0-9]*' | cut -d: -f2
}

# Get members of a group
# Arguments: SERVICE GROUP_NAME
# Output: User IDs (one per line)
provider_get_group_members() {
  local SERVICE="$1"
  local GROUP_NAME="$2"
  local CONTAINER_ID
  CONTAINER_ID=$(get_running_container_id "$SERVICE")

  local TOKEN GROUP_ID
  TOKEN=$(provider_get_token "$SERVICE")
  GROUP_ID=$(provider_get_group_id "$SERVICE" "$GROUP_NAME")

  if [[ -z "$GROUP_ID" ]]; then
    return 0
  fi

  docker exec "$CONTAINER_ID" curl -s \
    -X POST "http://localhost:17170/api/graphql" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "{\"query\":\"{ group(groupId: $GROUP_ID) { users { id } } }\"}" \
    | grep -o '"id":"[^"]*"' | cut -d'"' -f4
}

# Add user to group
# Arguments: SERVICE USER_ID GROUP_NAME
provider_add_user_to_group() {
  local SERVICE="$1"
  local USER_ID="$2"
  local GROUP_NAME="$3"
  local CONTAINER_ID
  CONTAINER_ID=$(get_running_container_id "$SERVICE")

  local TOKEN GROUP_ID
  TOKEN=$(provider_get_token "$SERVICE")
  GROUP_ID=$(provider_get_group_id "$SERVICE" "$GROUP_NAME")

  if [[ -z "$GROUP_ID" ]]; then
    echo "!     Group not found: $GROUP_NAME" >&2
    return 1
  fi

  docker exec "$CONTAINER_ID" curl -s \
    -X POST "http://localhost:17170/api/graphql" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "{\"query\":\"mutation { addUserToGroup(userId: \\\"$USER_ID\\\", groupId: $GROUP_ID) { ok } }\"}" \
    >/dev/null
}

# Destroy the Dokku app (or legacy container)
# Arguments: SERVICE
provider_destroy() {
  local SERVICE="$1"
  local APP_NAME
  APP_NAME=$(get_directory_app_name "$SERVICE")

  if [[ -n "$APP_NAME" ]] && "$DOKKU_BIN" apps:exists "$APP_NAME" < /dev/null 2>/dev/null; then
    echo "       Destroying Dokku app $APP_NAME"
    "$DOKKU_BIN" apps:destroy "$APP_NAME" --force < /dev/null
  else
    # Legacy: stop/remove Docker container
    local CONTAINER_NAME
    CONTAINER_NAME=$(get_directory_container_name "$SERVICE")
    docker stop "$CONTAINER_NAME" 2>/dev/null || true
    docker rm "$CONTAINER_NAME" 2>/dev/null || true
  fi
}

# Get logs
# Arguments: SERVICE [OPTIONS]
provider_logs() {
  local SERVICE="$1"
  shift
  local APP_NAME
  APP_NAME=$(get_directory_app_name "$SERVICE")

  if [[ -n "$APP_NAME" ]]; then
    "$DOKKU_BIN" logs "$APP_NAME" "$@" < /dev/null
  else
    local CONTAINER_NAME
    CONTAINER_NAME=$(get_directory_container_name "$SERVICE")
    docker logs "$@" "$CONTAINER_NAME"
  fi
}

# Check if running
# Arguments: SERVICE
provider_is_running() {
  local SERVICE="$1"
  local APP_NAME
  APP_NAME=$(get_directory_app_name "$SERVICE")

  if [[ -n "$APP_NAME" ]]; then
    local RUNNING
    RUNNING=$("$DOKKU_BIN" ps:report "$APP_NAME" --running < /dev/null 2>/dev/null || echo "false")
    [[ "$RUNNING" == "true" ]]
  else
    local CONTAINER_NAME
    CONTAINER_NAME=$(get_directory_container_name "$SERVICE")
    docker ps -q -f "name=^${CONTAINER_NAME}$" | grep -q .
  fi
}
