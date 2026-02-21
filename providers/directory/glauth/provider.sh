#!/usr/bin/env bash
# shellcheck disable=SC2034
# GLAuth Directory Provider
# Lightweight LDAP server with pluggable backends — managed as a Dokku app
# SC2034 disabled: Variables are used when this script is sourced

# Provider metadata
PROVIDER_NAME="glauth"
PROVIDER_DISPLAY_NAME="GLAuth"
PROVIDER_IMAGE="glauth/glauth"
PROVIDER_IMAGE_VERSION="latest"
PROVIDER_LDAP_PORT="3893"
PROVIDER_HTTP_PORT=""
PROVIDER_REQUIRED_CONFIG=""

# Get the running container ID for the Dokku app
# Arguments: SERVICE
# Output: Docker container ID
get_running_container_id() {
  local SERVICE="$1"
  local APP_NAME
  APP_NAME=$(get_directory_app_name "$SERVICE")
  if [[ -z "$APP_NAME" ]]; then
    local CONTAINER_NAME
    CONTAINER_NAME=$(get_directory_container_name "$SERVICE")
    docker ps -q -f "name=^${CONTAINER_NAME}$" -f status=running
    return
  fi
  docker ps -q -f "label=com.dokku.app-name=$APP_NAME" -f status=running | head -1
}

# Create and deploy GLAuth as a Dokku app
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

  # Create Dokku app if it doesn't exist
  if ! "$DOKKU_BIN" apps:exists "$APP_NAME" < /dev/null 2>/dev/null; then
    echo "-----> Creating Dokku app $APP_NAME"
    "$DOKKU_BIN" apps:create "$APP_NAME" < /dev/null
  fi

  # Mount config file
  echo "-----> Mounting storage volumes"
  "$DOKKU_BIN" storage:mount "$APP_NAME" "$CONFIG_DIR/glauth.cfg:/app/config/config.cfg:ro" < /dev/null 2>/dev/null || true

  # Attach to auth network
  echo "-----> Attaching to network $AUTH_NETWORK"
  "$DOKKU_BIN" network:set "$APP_NAME" attach-post-deploy "$AUTH_NETWORK" < /dev/null

  # Deploy from image
  echo "-----> Deploying $PROVIDER_IMAGE:$PROVIDER_IMAGE_VERSION"
  "$DOKKU_BIN" git:from-image "$APP_NAME" "$PROVIDER_IMAGE:$PROVIDER_IMAGE_VERSION" < /dev/null

  # Wait for app to be running
  echo "-----> Waiting for GLAuth to be ready"
  local retries=30
  while [[ $retries -gt 0 ]]; do
    if provider_is_running "$SERVICE"; then
      break
    fi
    sleep 2
    retries=$((retries - 1))
  done

  if [[ $retries -eq 0 ]]; then
    echo "!     GLAuth failed to start" >&2
    "$DOKKU_BIN" logs "$APP_NAME" --num 10 < /dev/null 2>&1 >&2
    return 1
  fi
}

# Adopt an existing Dokku app as the GLAuth directory
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
  local CONTAINER_ID
  CONTAINER_ID=$(get_running_container_id "$SERVICE")

  if [[ -z "$CONTAINER_ID" ]]; then
    echo "!     Container not running" >&2
    return 1
  fi

  # GLAuth is a minimal image without netcat/ldapsearch
  # Verify by checking the container is running and the process exists
  if docker top "$CONTAINER_ID" 2>/dev/null | grep -q glauth; then
    echo "       GLAuth process running"
  else
    echo "!     GLAuth process not found" >&2
    return 1
  fi

  return 0
}

# Display provider configuration
provider_info() {
  local SERVICE="$1"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/directory/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"
  local APP_NAME
  APP_NAME=$(get_directory_app_name "$SERVICE")

  local BASE_DN
  BASE_DN=$(cat "$CONFIG_DIR/BASE_DN" 2>/dev/null || echo "(not set)")

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

# Destroy the Dokku app (or legacy container)
provider_destroy() {
  local SERVICE="$1"
  local APP_NAME
  APP_NAME=$(get_directory_app_name "$SERVICE")

  if [[ -n "$APP_NAME" ]] && "$DOKKU_BIN" apps:exists "$APP_NAME" < /dev/null 2>/dev/null; then
    echo "       Destroying Dokku app $APP_NAME"
    "$DOKKU_BIN" apps:destroy "$APP_NAME" --force < /dev/null
  else
    local CONTAINER_NAME
    CONTAINER_NAME=$(get_directory_container_name "$SERVICE")
    docker stop "$CONTAINER_NAME" 2>/dev/null || true
    docker rm "$CONTAINER_NAME" 2>/dev/null || true
  fi
}

# Get logs
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
