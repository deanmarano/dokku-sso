#!/usr/bin/env bash
# shellcheck disable=SC2034
# LLDAP Directory Provider
# Lightweight LDAP server with web UI for user management
# SC2034 disabled: Variables are used when this script is sourced

# Provider metadata
PROVIDER_NAME="lldap"
PROVIDER_DISPLAY_NAME="LLDAP (Lightweight LDAP)"
PROVIDER_IMAGE="lldap/lldap"
PROVIDER_IMAGE_VERSION="stable"
PROVIDER_LDAP_PORT="3890"
PROVIDER_HTTP_PORT="17170"
PROVIDER_REQUIRED_CONFIG=""  # Auto-generates secrets

# Create and start the LLDAP container
# Arguments: SERVICE - name of the service
provider_create_container() {
  local SERVICE="$1"
  local CONTAINER_NAME
  CONTAINER_NAME=$(get_directory_container_name "$SERVICE")
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/directory/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"
  local DATA_DIR="$SERVICE_ROOT/data"

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

  # Pull image
  echo "-----> Pulling $PROVIDER_IMAGE:$PROVIDER_IMAGE_VERSION"
  docker pull "$PROVIDER_IMAGE:$PROVIDER_IMAGE_VERSION" >/dev/null

  # Create container
  # Note: No host port binding - services communicate via docker network
  # Use 'dokku auth:expose <service>' to expose ports if needed
  echo "-----> Starting LLDAP container"
  docker run -d \
    --name "$CONTAINER_NAME" \
    --restart unless-stopped \
    --network "$AUTH_NETWORK" \
    -v "$DATA_DIR:/data" \
    -e "LLDAP_JWT_SECRET=$JWT_SECRET" \
    -e "LLDAP_LDAP_BASE_DN=$BASE_DN" \
    -e "LLDAP_LDAP_USER_PASS=$ADMIN_PASSWORD" \
    -e "LLDAP_HTTP_URL=$HTTP_URL" \
    -e "TZ=${TZ:-UTC}" \
    "$PROVIDER_IMAGE:$PROVIDER_IMAGE_VERSION" >/dev/null

  # Wait for container to be ready
  echo "-----> Waiting for LLDAP to be ready"
  local retries=30
  while [[ $retries -gt 0 ]]; do
    # Check if HTTP endpoint is responding
    if docker exec "$CONTAINER_NAME" curl -sf http://localhost:17170/health 2>/dev/null || \
       docker exec "$CONTAINER_NAME" wget -q --spider http://localhost:17170/ 2>/dev/null || \
       docker inspect "$CONTAINER_NAME" --format='{{.State.Health.Status}}' 2>/dev/null | grep -q healthy; then
      break
    fi
    sleep 2
    retries=$((retries - 1))
  done

  if [[ $retries -eq 0 ]]; then
    echo "!     LLDAP failed to start" >&2
    return 1
  fi

  # Create default users group
  provider_create_group "$SERVICE" "$DEFAULT_USERS_GROUP" || true
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
  local CONTAINER_NAME
  CONTAINER_NAME=$(get_directory_container_name "$SERVICE")

  local BASE_DN ADMIN_PASSWORD
  BASE_DN=$(cat "$CONFIG_DIR/BASE_DN")
  ADMIN_PASSWORD=$(cat "$CONFIG_DIR/ADMIN_PASSWORD")

  echo "LDAP_URL=ldap://$CONTAINER_NAME:$PROVIDER_LDAP_PORT"
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
  local CONTAINER_NAME
  CONTAINER_NAME=$(get_directory_container_name "$SERVICE")

  if ! docker ps -q -f "name=^${CONTAINER_NAME}$" | grep -q .; then
    echo "!     Container not running" >&2
    return 1
  fi

  # Check HTTP port using curl (available in lldap container)
  if docker exec "$CONTAINER_NAME" curl -sf http://localhost:17170/ >/dev/null 2>&1; then
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
  local CONTAINER_NAME
  CONTAINER_NAME=$(get_directory_container_name "$SERVICE")

  local BASE_DN HTTP_URL
  BASE_DN=$(cat "$CONFIG_DIR/BASE_DN" 2>/dev/null || echo "(not set)")
  HTTP_URL=$(cat "$CONFIG_DIR/HTTP_URL" 2>/dev/null || echo "(not set)")

  echo "       Provider: $PROVIDER_DISPLAY_NAME"
  echo "       Image: $PROVIDER_IMAGE:$PROVIDER_IMAGE_VERSION"
  echo "       Container: $CONTAINER_NAME"
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
  local CONTAINER_NAME
  CONTAINER_NAME=$(get_directory_container_name "$SERVICE")

  local ADMIN_PASSWORD
  ADMIN_PASSWORD=$(cat "$CONFIG_DIR/ADMIN_PASSWORD")

  # Get token via internal API
  docker exec "$CONTAINER_NAME" curl -s \
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
  local CONTAINER_NAME
  CONTAINER_NAME=$(get_directory_container_name "$SERVICE")

  local TOKEN
  TOKEN=$(provider_get_token "$SERVICE")
  if [[ -z "$TOKEN" ]]; then
    echo "!     Failed to get authentication token" >&2
    return 1
  fi

  local RESPONSE
  RESPONSE=$(docker exec "$CONTAINER_NAME" curl -s \
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

# Get group ID by name
# Arguments: SERVICE GROUP_NAME
# Output: Group ID (number)
provider_get_group_id() {
  local SERVICE="$1"
  local GROUP_NAME="$2"
  local CONTAINER_NAME
  CONTAINER_NAME=$(get_directory_container_name "$SERVICE")

  local TOKEN
  TOKEN=$(provider_get_token "$SERVICE")

  docker exec "$CONTAINER_NAME" curl -s \
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
  local CONTAINER_NAME
  CONTAINER_NAME=$(get_directory_container_name "$SERVICE")

  local TOKEN GROUP_ID
  TOKEN=$(provider_get_token "$SERVICE")
  GROUP_ID=$(provider_get_group_id "$SERVICE" "$GROUP_NAME")

  if [[ -z "$GROUP_ID" ]]; then
    return 0
  fi

  docker exec "$CONTAINER_NAME" curl -s \
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
  local CONTAINER_NAME
  CONTAINER_NAME=$(get_directory_container_name "$SERVICE")

  local TOKEN GROUP_ID
  TOKEN=$(provider_get_token "$SERVICE")
  GROUP_ID=$(provider_get_group_id "$SERVICE" "$GROUP_NAME")

  if [[ -z "$GROUP_ID" ]]; then
    echo "!     Group not found: $GROUP_NAME" >&2
    return 1
  fi

  docker exec "$CONTAINER_NAME" curl -s \
    -X POST "http://localhost:17170/api/graphql" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "{\"query\":\"mutation { addUserToGroup(userId: \\\"$USER_ID\\\", groupId: $GROUP_ID) { ok } }\"}" \
    >/dev/null
}

# Destroy the container
# Arguments: SERVICE
provider_destroy() {
  local SERVICE="$1"
  local CONTAINER_NAME
  CONTAINER_NAME=$(get_directory_container_name "$SERVICE")

  docker stop "$CONTAINER_NAME" 2>/dev/null || true
  docker rm "$CONTAINER_NAME" 2>/dev/null || true
}

# Get container logs
# Arguments: SERVICE [OPTIONS]
provider_logs() {
  local SERVICE="$1"
  shift
  local CONTAINER_NAME
  CONTAINER_NAME=$(get_directory_container_name "$SERVICE")

  docker logs "$@" "$CONTAINER_NAME"
}

# Check if container is running
# Arguments: SERVICE
provider_is_running() {
  local SERVICE="$1"
  local CONTAINER_NAME
  CONTAINER_NAME=$(get_directory_container_name "$SERVICE")

  docker ps -q -f "name=^${CONTAINER_NAME}$" | grep -q .
}
