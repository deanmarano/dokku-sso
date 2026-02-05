#!/usr/bin/env bash
# shellcheck disable=SC2034
# OpenLDAP Directory Provider
# Full-featured LDAP server
# SC2034 disabled: Variables are used when this script is sourced

# Provider metadata
PROVIDER_NAME="openldap"
PROVIDER_DISPLAY_NAME="OpenLDAP"
PROVIDER_IMAGE="osixia/openldap"
PROVIDER_IMAGE_VERSION="1.5.0"
PROVIDER_LDAP_PORT="389"
PROVIDER_HTTP_PORT=""
PROVIDER_REQUIRED_CONFIG=""

# Create and start the OpenLDAP container
provider_create_container() {
  local SERVICE="$1"
  local CONTAINER_NAME
  CONTAINER_NAME=$(get_directory_container_name "$SERVICE")
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/directory/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"
  local DATA_DIR="$SERVICE_ROOT/data"

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

  # Pull image
  echo "-----> Pulling $PROVIDER_IMAGE:$PROVIDER_IMAGE_VERSION"
  docker pull "$PROVIDER_IMAGE:$PROVIDER_IMAGE_VERSION" >/dev/null

  # Create container
  echo "-----> Starting OpenLDAP container"
  docker run -d \
    --name "$CONTAINER_NAME" \
    --restart unless-stopped \
    --network "$AUTH_NETWORK" \
    -v "$DATA_DIR/slapd:/var/lib/ldap" \
    -v "$DATA_DIR/config:/etc/ldap/slapd.d" \
    -e "LDAP_ORGANISATION=$ORGANISATION" \
    -e "LDAP_DOMAIN=$DOMAIN" \
    -e "LDAP_ADMIN_PASSWORD=$ADMIN_PASSWORD" \
    -e "LDAP_TLS=false" \
    "$PROVIDER_IMAGE:$PROVIDER_IMAGE_VERSION" >/dev/null

  # Wait for container to be ready
  echo "-----> Waiting for OpenLDAP to be ready"
  local retries=60
  while [[ $retries -gt 0 ]]; do
    if docker exec "$CONTAINER_NAME" ldapsearch -x -H ldap://localhost -b "$BASE_DN" -D "cn=admin,$BASE_DN" -w "$ADMIN_PASSWORD" "(objectClass=organization)" >/dev/null 2>&1; then
      break
    fi
    sleep 1
    retries=$((retries - 1))
  done

  if [[ $retries -eq 0 ]]; then
    echo "!     OpenLDAP failed to start" >&2
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
  local CONTAINER_NAME
  CONTAINER_NAME=$(get_directory_container_name "$SERVICE")

  local BASE_DN ADMIN_PASSWORD
  BASE_DN=$(cat "$CONFIG_DIR/BASE_DN")
  ADMIN_PASSWORD=$(cat "$CONFIG_DIR/ADMIN_PASSWORD")

  if ! docker exec "$CONTAINER_NAME" ldapadd -x -H ldap://localhost -D "cn=admin,$BASE_DN" -w "$ADMIN_PASSWORD" <<EOF 2>&1; then
dn: ou=$OU_NAME,$BASE_DN
objectClass: organizationalUnit
ou: $OU_NAME
EOF
    echo "       Warning: Could not create OU $OU_NAME (may already exist)"
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
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/directory/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"
  local CONTAINER_NAME
  CONTAINER_NAME=$(get_directory_container_name "$SERVICE")

  if ! docker ps -q -f "name=^${CONTAINER_NAME}$" | grep -q .; then
    echo "!     Container not running" >&2
    return 1
  fi

  local BASE_DN ADMIN_PASSWORD
  BASE_DN=$(cat "$CONFIG_DIR/BASE_DN")
  ADMIN_PASSWORD=$(cat "$CONFIG_DIR/ADMIN_PASSWORD")

  if docker exec "$CONTAINER_NAME" ldapsearch -x -H ldap://localhost -b "$BASE_DN" -D "cn=admin,$BASE_DN" -w "$ADMIN_PASSWORD" "(objectClass=organization)" >/dev/null 2>&1; then
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
  local CONTAINER_NAME
  CONTAINER_NAME=$(get_directory_container_name "$SERVICE")

  local BASE_DN ORGANISATION DOMAIN
  BASE_DN=$(cat "$CONFIG_DIR/BASE_DN" 2>/dev/null || echo "(not set)")
  ORGANISATION=$(cat "$CONFIG_DIR/ORGANISATION" 2>/dev/null || echo "(not set)")
  DOMAIN=$(cat "$CONFIG_DIR/DOMAIN" 2>/dev/null || echo "(not set)")

  echo "       Provider: $PROVIDER_DISPLAY_NAME"
  echo "       Image: $PROVIDER_IMAGE:$PROVIDER_IMAGE_VERSION"
  echo "       Container: $CONTAINER_NAME"
  echo "       LDAP Port: $PROVIDER_LDAP_PORT"
  echo "       Base DN: $BASE_DN"
  echo "       Organisation: $ORGANISATION"
  echo "       Domain: $DOMAIN"
}

# Create a group
provider_create_group() {
  local SERVICE="$1"
  local GROUP_NAME="$2"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/directory/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"
  local CONTAINER_NAME
  CONTAINER_NAME=$(get_directory_container_name "$SERVICE")

  local BASE_DN ADMIN_PASSWORD
  BASE_DN=$(cat "$CONFIG_DIR/BASE_DN")
  ADMIN_PASSWORD=$(cat "$CONFIG_DIR/ADMIN_PASSWORD")

  if ! docker exec "$CONTAINER_NAME" ldapadd -x -H ldap://localhost -D "cn=admin,$BASE_DN" -w "$ADMIN_PASSWORD" <<EOF 2>&1; then
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
  local CONTAINER_NAME
  CONTAINER_NAME=$(get_directory_container_name "$SERVICE")

  local BASE_DN ADMIN_PASSWORD
  BASE_DN=$(cat "$CONFIG_DIR/BASE_DN")
  ADMIN_PASSWORD=$(cat "$CONFIG_DIR/ADMIN_PASSWORD")

  docker exec "$CONTAINER_NAME" ldapsearch -x -H ldap://localhost \
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
  local CONTAINER_NAME
  CONTAINER_NAME=$(get_directory_container_name "$SERVICE")

  local BASE_DN ADMIN_PASSWORD
  BASE_DN=$(cat "$CONFIG_DIR/BASE_DN")
  ADMIN_PASSWORD=$(cat "$CONFIG_DIR/ADMIN_PASSWORD")

  docker exec "$CONTAINER_NAME" ldapmodify -x -H ldap://localhost -D "cn=admin,$BASE_DN" -w "$ADMIN_PASSWORD" <<EOF 2>/dev/null || true
dn: cn=$GROUP_NAME,ou=groups,$BASE_DN
changetype: modify
add: member
member: uid=$USER_ID,ou=people,$BASE_DN
EOF
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
