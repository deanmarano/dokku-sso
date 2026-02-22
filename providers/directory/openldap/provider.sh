#!/usr/bin/env bash
# shellcheck disable=SC2034
# OpenLDAP Directory Provider
# Full-featured LDAP server — managed as a Dokku app
# SC2034 disabled: Variables are used when this script is sourced

# Provider metadata
PROVIDER_NAME="openldap"
PROVIDER_DISPLAY_NAME="OpenLDAP"
PROVIDER_IMAGE="osixia/openldap"
PROVIDER_IMAGE_VERSION="1.5.0"
PROVIDER_LDAP_PORT="389"
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

# Create and deploy OpenLDAP as a Dokku app
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
  local BASE_DN ADMIN_PASSWORD ORGANISATION DOMAIN
  BASE_DN=$(cat "$CONFIG_DIR/BASE_DN" 2>/dev/null || echo "dc=dokku,dc=local")
  ADMIN_PASSWORD=$(cat "$CONFIG_DIR/ADMIN_PASSWORD" 2>/dev/null || openssl rand -base64 16 | tr -d '/+=')
  ORGANISATION=$(cat "$CONFIG_DIR/ORGANISATION" 2>/dev/null || echo "Dokku")
  DOMAIN=$(cat "$CONFIG_DIR/DOMAIN" 2>/dev/null || echo "dokku.local")

  # Save configuration
  mkdir -p "$CONFIG_DIR" "$DATA_DIR/slapd" "$DATA_DIR/config"
  echo "$BASE_DN" > "$CONFIG_DIR/BASE_DN"
  echo "$ADMIN_PASSWORD" > "$CONFIG_DIR/ADMIN_PASSWORD"
  echo "$ORGANISATION" > "$CONFIG_DIR/ORGANISATION"
  echo "$DOMAIN" > "$CONFIG_DIR/DOMAIN"
  chmod 600 "$CONFIG_DIR"/*

  # Create Dokku app if it doesn't exist
  if ! "$DOKKU_BIN" apps:exists "$APP_NAME" < /dev/null 2>/dev/null; then
    echo "-----> Creating Dokku app $APP_NAME"
    "$DOKKU_BIN" apps:create "$APP_NAME" < /dev/null
  fi

  # Mount data directories
  echo "-----> Mounting storage volumes"
  "$DOKKU_BIN" storage:mount "$APP_NAME" "$DATA_DIR/slapd:/var/lib/ldap" < /dev/null 2>/dev/null || true
  "$DOKKU_BIN" storage:mount "$APP_NAME" "$DATA_DIR/config:/etc/ldap/slapd.d" < /dev/null 2>/dev/null || true

  # Set environment variables
  echo "-----> Setting environment variables"
  "$DOKKU_BIN" config:set --no-restart "$APP_NAME" \
    LDAP_ORGANISATION="$ORGANISATION" \
    LDAP_DOMAIN="$DOMAIN" \
    LDAP_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
    LDAP_TLS="false" \
    TZ="${TZ:-UTC}" < /dev/null

  # Attach to auth network
  echo "-----> Attaching to network $AUTH_NETWORK"
  "$DOKKU_BIN" network:set "$APP_NAME" attach-post-deploy "$AUTH_NETWORK" < /dev/null

  # Deploy from image
  echo "-----> Deploying $PROVIDER_IMAGE:$PROVIDER_IMAGE_VERSION"
  "$DOKKU_BIN" git:from-image "$APP_NAME" "$PROVIDER_IMAGE:$PROVIDER_IMAGE_VERSION" < /dev/null

  # Wait for app to be running
  echo "-----> Waiting for OpenLDAP to be ready"
  local retries=60
  while [[ $retries -gt 0 ]]; do
    if provider_is_running "$SERVICE"; then
      local CONTAINER_ID
      CONTAINER_ID=$(get_running_container_id "$SERVICE")
      if [[ -n "$CONTAINER_ID" ]] && docker exec "$CONTAINER_ID" ldapsearch -x -H ldap://localhost -b "$BASE_DN" -D "cn=admin,$BASE_DN" -w "$ADMIN_PASSWORD" "(objectClass=organization)" >/dev/null 2>&1; then
        break
      fi
    fi
    sleep 1
    retries=$((retries - 1))
  done

  if [[ $retries -eq 0 ]]; then
    echo "!     OpenLDAP failed to start" >&2
    "$DOKKU_BIN" logs "$APP_NAME" --num 10 < /dev/null 2>&1 >&2
    return 1
  fi

  # Wait a moment for OpenLDAP to stabilize
  sleep 2

  # Create organizational units
  echo "       Creating organizational units..."
  provider_create_ou "$SERVICE" "people"
  provider_create_ou "$SERVICE" "groups"

  # Create default users group
  echo "       Creating default users group..."
  provider_create_group "$SERVICE" "$DEFAULT_USERS_GROUP" || true
}

# Create an organizational unit
provider_create_ou() {
  local SERVICE="$1"
  local OU_NAME="$2"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/directory/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"
  local CONTAINER_ID
  CONTAINER_ID=$(get_running_container_id "$SERVICE")

  local BASE_DN ADMIN_PASSWORD
  BASE_DN=$(cat "$CONFIG_DIR/BASE_DN")
  ADMIN_PASSWORD=$(cat "$CONFIG_DIR/ADMIN_PASSWORD")

  if ! docker exec -i "$CONTAINER_ID" ldapadd -x -H ldap://localhost -D "cn=admin,$BASE_DN" -w "$ADMIN_PASSWORD" <<EOF 2>&1; then
dn: ou=$OU_NAME,$BASE_DN
objectClass: organizationalUnit
ou: $OU_NAME
EOF
    echo "       Warning: Could not create OU $OU_NAME (may already exist)"
  fi
}

# Adopt an existing Dokku app as the OpenLDAP directory
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
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/directory/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"
  local CONTAINER_ID
  CONTAINER_ID=$(get_running_container_id "$SERVICE")

  if [[ -z "$CONTAINER_ID" ]]; then
    echo "!     Container not running" >&2
    return 1
  fi

  local BASE_DN ADMIN_PASSWORD
  BASE_DN=$(cat "$CONFIG_DIR/BASE_DN")
  ADMIN_PASSWORD=$(cat "$CONFIG_DIR/ADMIN_PASSWORD")

  if docker exec "$CONTAINER_ID" ldapsearch -x -H ldap://localhost -b "$BASE_DN" -D "cn=admin,$BASE_DN" -w "$ADMIN_PASSWORD" "(objectClass=organization)" >/dev/null 2>&1; then
    echo "       LDAP responding"
  else
    echo "!     LDAP not responding" >&2
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

  local BASE_DN ORGANISATION DOMAIN
  BASE_DN=$(cat "$CONFIG_DIR/BASE_DN" 2>/dev/null || echo "(not set)")
  ORGANISATION=$(cat "$CONFIG_DIR/ORGANISATION" 2>/dev/null || echo "(not set)")
  DOMAIN=$(cat "$CONFIG_DIR/DOMAIN" 2>/dev/null || echo "(not set)")

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
  echo "       Organisation: $ORGANISATION"
  echo "       Domain: $DOMAIN"
}

# Create a user
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

  local BASE_DN ADMIN_PASSWORD
  BASE_DN=$(cat "$CONFIG_DIR/BASE_DN")
  ADMIN_PASSWORD=$(cat "$CONFIG_DIR/ADMIN_PASSWORD")

  # Generate SSHA password hash
  local HASHED_PASSWORD
  HASHED_PASSWORD=$(docker exec "$CONTAINER_ID" slappasswd -s "$PASSWORD" 2>/dev/null)

  if ! docker exec -i "$CONTAINER_ID" ldapadd -x -H ldap://localhost -D "cn=admin,$BASE_DN" -w "$ADMIN_PASSWORD" <<EOF 2>&1; then
dn: uid=$USERNAME,ou=people,$BASE_DN
objectClass: inetOrgPerson
objectClass: posixAccount
uid: $USERNAME
cn: $USERNAME
sn: $USERNAME
mail: $EMAIL
userPassword: $HASHED_PASSWORD
uidNumber: $(( RANDOM + 10000 ))
gidNumber: 10000
homeDirectory: /home/$USERNAME
EOF
    echo "       Warning: Could not create user $USERNAME (may already exist)"
  fi
}

# Create a group
provider_create_group() {
  local SERVICE="$1"
  local GROUP_NAME="$2"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/directory/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"
  local CONTAINER_ID
  CONTAINER_ID=$(get_running_container_id "$SERVICE")

  local BASE_DN ADMIN_PASSWORD
  BASE_DN=$(cat "$CONFIG_DIR/BASE_DN")
  ADMIN_PASSWORD=$(cat "$CONFIG_DIR/ADMIN_PASSWORD")

  if ! docker exec -i "$CONTAINER_ID" ldapadd -x -H ldap://localhost -D "cn=admin,$BASE_DN" -w "$ADMIN_PASSWORD" <<EOF 2>&1; then
dn: cn=$GROUP_NAME,ou=groups,$BASE_DN
objectClass: groupOfNames
cn: $GROUP_NAME
member: cn=admin,$BASE_DN
EOF
    echo "       Warning: Could not create group $GROUP_NAME (may already exist)"
  fi
}

# Get members of a group
provider_get_group_members() {
  local SERVICE="$1"
  local GROUP_NAME="$2"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/directory/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"
  local CONTAINER_ID
  CONTAINER_ID=$(get_running_container_id "$SERVICE")

  local BASE_DN ADMIN_PASSWORD
  BASE_DN=$(cat "$CONFIG_DIR/BASE_DN")
  ADMIN_PASSWORD=$(cat "$CONFIG_DIR/ADMIN_PASSWORD")

  docker exec "$CONTAINER_ID" ldapsearch -x -H ldap://localhost \
    -b "cn=$GROUP_NAME,ou=groups,$BASE_DN" \
    -D "cn=admin,$BASE_DN" -w "$ADMIN_PASSWORD" \
    "(objectClass=groupOfNames)" member 2>/dev/null \
    | grep "^member:" | sed 's/member: uid=//;s/,ou=.*//'
}

# Add user to group
provider_add_user_to_group() {
  local SERVICE="$1"
  local USER_ID="$2"
  local GROUP_NAME="$3"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/directory/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"
  local CONTAINER_ID
  CONTAINER_ID=$(get_running_container_id "$SERVICE")

  local BASE_DN ADMIN_PASSWORD
  BASE_DN=$(cat "$CONFIG_DIR/BASE_DN")
  ADMIN_PASSWORD=$(cat "$CONFIG_DIR/ADMIN_PASSWORD")

  docker exec -i "$CONTAINER_ID" ldapmodify -x -H ldap://localhost -D "cn=admin,$BASE_DN" -w "$ADMIN_PASSWORD" <<EOF 2>/dev/null || true
dn: cn=$GROUP_NAME,ou=groups,$BASE_DN
changetype: modify
add: member
member: uid=$USER_ID,ou=people,$BASE_DN
EOF
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
