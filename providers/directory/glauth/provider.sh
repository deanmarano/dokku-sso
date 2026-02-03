#!/usr/bin/env bash
# GLAuth Directory Provider
# Lightweight LDAP server with pluggable backends

# Provider metadata
PROVIDER_NAME="glauth"
PROVIDER_DISPLAY_NAME="GLAuth"
PROVIDER_IMAGE="glauth/glauth"
PROVIDER_IMAGE_VERSION="latest"
PROVIDER_LDAP_PORT="3893"
PROVIDER_HTTP_PORT=""
PROVIDER_REQUIRED_CONFIG=""

# Create and start the GLAuth container
provider_create_container() {
  local SERVICE="$1"
  local CONTAINER_NAME
  CONTAINER_NAME=$(get_directory_container_name "$SERVICE")
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/directory/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"
  local DATA_DIR="$SERVICE_ROOT/data"

  # Generate configuration
  local BASE_DN ADMIN_PASSWORD
  BASE_DN=$(cat "$CONFIG_DIR/BASE_DN" 2>/dev/null || echo "dc=dokku,dc=local")
  ADMIN_PASSWORD=$(cat "$CONFIG_DIR/ADMIN_PASSWORD" 2>/dev/null || openssl rand -base64 16 | tr -d '/+=')

  # Save configuration
  mkdir -p "$CONFIG_DIR" "$DATA_DIR"
  echo "$BASE_DN" > "$CONFIG_DIR/BASE_DN"
  echo "$ADMIN_PASSWORD" > "$CONFIG_DIR/ADMIN_PASSWORD"
  chmod 600 "$CONFIG_DIR"/*

  # Generate GLAuth config file
  cat > "$CONFIG_DIR/glauth.cfg" <<EOF
[ldap]
  enabled = true
  listen = "0.0.0.0:3893"

[ldaps]
  enabled = false

[backend]
  datastore = "config"
  baseDN = "$BASE_DN"

[[users]]
  name = "admin"
  givenname = "Admin"
  sn = "User"
  mail = "admin@local"
  uidnumber = 5000
  primarygroup = 5501
  passsha256 = "$(echo -n "$ADMIN_PASSWORD" | sha256sum | cut -d' ' -f1)"
    [[users.capabilities]]
    action = "search"
    object = "*"

[[groups]]
  name = "admins"
  gidnumber = 5501

[[groups]]
  name = "$DEFAULT_USERS_GROUP"
  gidnumber = 5502
EOF
  chmod 600 "$CONFIG_DIR/glauth.cfg"

  # Pull image
  echo "-----> Pulling $PROVIDER_IMAGE:$PROVIDER_IMAGE_VERSION"
  docker pull "$PROVIDER_IMAGE:$PROVIDER_IMAGE_VERSION" >/dev/null

  # Create container
  echo "-----> Starting GLAuth container"
  docker run -d \
    --name "$CONTAINER_NAME" \
    --restart unless-stopped \
    --network "$AUTH_NETWORK" \
    -v "$CONFIG_DIR/glauth.cfg:/app/config/config.cfg:ro" \
    "$PROVIDER_IMAGE:$PROVIDER_IMAGE_VERSION" >/dev/null

  # Wait for container to be ready
  echo "-----> Waiting for GLAuth to be ready"
  local retries=30
  while [[ $retries -gt 0 ]]; do
    if docker exec "$CONTAINER_NAME" /bin/sh -c "nc -z localhost 3893" 2>/dev/null; then
      break
    fi
    sleep 1
    retries=$((retries - 1))
  done

  if [[ $retries -eq 0 ]]; then
    echo "!     GLAuth failed to start" >&2
    return 1
  fi
}

# Get the LDAP port
provider_get_ldap_port() {
  echo "$PROVIDER_LDAP_PORT"
}

# Get bind credentials for apps
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
  echo "LDAP_BIND_DN=cn=admin,$BASE_DN"
  echo "LDAP_BIND_PASSWORD=$ADMIN_PASSWORD"
}

# Validate provider configuration
provider_validate_config() {
  local SERVICE="$1"
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

  if docker exec "$CONTAINER_NAME" /bin/sh -c "nc -z localhost 3893" 2>/dev/null; then
    echo "       LDAP port responding"
  else
    echo "!     LDAP port not responding" >&2
    return 1
  fi

  return 0
}

# Display provider configuration
provider_info() {
  local SERVICE="$1"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/directory/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"
  local CONTAINER_NAME
  CONTAINER_NAME=$(get_directory_container_name "$SERVICE")

  local BASE_DN
  BASE_DN=$(cat "$CONFIG_DIR/BASE_DN" 2>/dev/null || echo "(not set)")

  echo "       Provider: $PROVIDER_DISPLAY_NAME"
  echo "       Image: $PROVIDER_IMAGE:$PROVIDER_IMAGE_VERSION"
  echo "       Container: $CONTAINER_NAME"
  echo "       LDAP Port: $PROVIDER_LDAP_PORT"
  echo "       Base DN: $BASE_DN"
  echo ""
  echo "       NOTE: GLAuth uses config-based backends"
  echo "       Group/user management requires editing glauth.cfg"
}

# Create a group (GLAuth requires config file edits)
provider_create_group() {
  local SERVICE="$1"
  local GROUP_NAME="$2"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/directory/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"

  # Check if group already exists in config
  if grep -q "name = \"$GROUP_NAME\"" "$CONFIG_DIR/glauth.cfg" 2>/dev/null; then
    return 0
  fi

  # Get next GID
  local MAX_GID
  MAX_GID=$(grep -o 'gidnumber = [0-9]*' "$CONFIG_DIR/glauth.cfg" | sort -t= -k2 -n | tail -1 | grep -o '[0-9]*' || echo "5500")
  local NEW_GID=$((MAX_GID + 1))

  # Append group to config
  cat >> "$CONFIG_DIR/glauth.cfg" <<EOF

[[groups]]
  name = "$GROUP_NAME"
  gidnumber = $NEW_GID
EOF

  echo "       Note: GLAuth requires restart to apply group changes"
}

# Get members of a group (limited support in GLAuth)
provider_get_group_members() {
  local SERVICE="$1"
  local GROUP_NAME="$2"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/directory/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"

  # GLAuth stores group membership in user records
  # Parse config to find users in the specified group
  local GROUP_GID
  GROUP_GID=$(grep -A1 "name = \"$GROUP_NAME\"" "$CONFIG_DIR/glauth.cfg" | grep gidnumber | grep -o '[0-9]*' || echo "")

  if [[ -z "$GROUP_GID" ]]; then
    return 0
  fi

  # Find users with this primary group or in othergroups
  grep -B10 "primarygroup = $GROUP_GID" "$CONFIG_DIR/glauth.cfg" | grep 'name = ' | head -1 | cut -d'"' -f2 || true
}

# Add user to group (limited - requires config edit)
provider_add_user_to_group() {
  local SERVICE="$1"
  local USER_ID="$2"
  local GROUP_NAME="$3"

  echo "       Note: GLAuth user/group management requires editing glauth.cfg"
  echo "       Add '$GROUP_NAME' to the user's othergroups in the config file"
  return 0
}

# Destroy the container
provider_destroy() {
  local SERVICE="$1"
  local CONTAINER_NAME
  CONTAINER_NAME=$(get_directory_container_name "$SERVICE")

  docker stop "$CONTAINER_NAME" 2>/dev/null || true
  docker rm "$CONTAINER_NAME" 2>/dev/null || true
}

# Get container logs
provider_logs() {
  local SERVICE="$1"
  shift
  local CONTAINER_NAME
  CONTAINER_NAME=$(get_directory_container_name "$SERVICE")

  docker logs "$@" "$CONTAINER_NAME"
}

# Check if container is running
provider_is_running() {
  local SERVICE="$1"
  local CONTAINER_NAME
  CONTAINER_NAME=$(get_directory_container_name "$SERVICE")

  docker ps -q -f "name=^${CONTAINER_NAME}$" | grep -q .
}
