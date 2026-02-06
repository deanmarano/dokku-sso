#!/usr/bin/env bash
# shellcheck disable=SC2034
# Authentik Frontend Provider
# Modern open-source identity provider with OIDC/OAuth2/SAML support
# SC2034 disabled: Variables are used when this script is sourced
#
# This provider uses dokku postgres and redis plugins for data storage.

# Provider metadata
PROVIDER_NAME="authentik"
PROVIDER_DISPLAY_NAME="Authentik"
PROVIDER_IMAGE="ghcr.io/goauthentik/server"
PROVIDER_IMAGE_VERSION="2024.2"
PROVIDER_HTTP_PORT="9000"
PROVIDER_REQUIRED_CONFIG="DOMAIN"

# Get the base name for Authentik resources
get_authentik_base_name() {
  local SERVICE="$1"
  echo "auth-${SERVICE}"
}

# Create and start the Authentik containers
provider_create_container() {
  local SERVICE="$1"
  local SERVER_CONTAINER
  SERVER_CONTAINER=$(get_frontend_container_name "$SERVICE")
  local WORKER_CONTAINER="${SERVER_CONTAINER}.worker"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/frontend/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"
  local DATA_DIR="$SERVICE_ROOT/data"
  local BASE_NAME
  BASE_NAME=$(get_authentik_base_name "$SERVICE")

  # Read or generate configuration
  local DOMAIN SECRET_KEY BOOTSTRAP_PASSWORD BOOTSTRAP_TOKEN
  DOMAIN=$(cat "$CONFIG_DIR/DOMAIN" 2>/dev/null || echo "auth.test.local")
  SECRET_KEY=$(cat "$CONFIG_DIR/SECRET_KEY" 2>/dev/null || openssl rand -hex 50)
  BOOTSTRAP_PASSWORD=$(cat "$CONFIG_DIR/BOOTSTRAP_PASSWORD" 2>/dev/null || openssl rand -base64 16 | tr -d '/+=')
  BOOTSTRAP_TOKEN=$(cat "$CONFIG_DIR/BOOTSTRAP_TOKEN" 2>/dev/null || openssl rand -hex 32)

  # Save configuration
  mkdir -p "$CONFIG_DIR" "$DATA_DIR/media" "$DATA_DIR/templates" "$DATA_DIR/certs"
  echo "$DOMAIN" > "$CONFIG_DIR/DOMAIN"
  echo "$SECRET_KEY" > "$CONFIG_DIR/SECRET_KEY"
  echo "$BOOTSTRAP_PASSWORD" > "$CONFIG_DIR/BOOTSTRAP_PASSWORD"
  echo "$BOOTSTRAP_TOKEN" > "$CONFIG_DIR/BOOTSTRAP_TOKEN"
  for f in "$CONFIG_DIR"/*; do
    [[ -f "$f" ]] && chmod 600 "$f"
  done

  # Create PostgreSQL database using dokku plugin
  echo "-----> Creating PostgreSQL database"
  if ! dokku postgres:exists "$BASE_NAME" 2>/dev/null; then
    dokku postgres:create "$BASE_NAME" >/dev/null
  fi
  local POSTGRES_URL
  POSTGRES_URL=$(dokku postgres:info "$BASE_NAME" --dsn 2>/dev/null)
  echo "$POSTGRES_URL" > "$CONFIG_DIR/POSTGRES_URL"

  # Create Redis instance using dokku plugin
  echo "-----> Creating Redis instance"
  if ! dokku redis:exists "$BASE_NAME" 2>/dev/null; then
    dokku redis:create "$BASE_NAME" >/dev/null
  fi
  local REDIS_URL
  REDIS_URL=$(dokku redis:info "$BASE_NAME" --dsn 2>/dev/null)
  echo "$REDIS_URL" > "$CONFIG_DIR/REDIS_URL"

  # Get LDAP settings if linked to a directory
  local LDAP_ENABLED="false"
  if [[ -f "$SERVICE_ROOT/DIRECTORY" ]]; then
    LDAP_ENABLED="true"
  fi

  # Pull image
  echo "-----> Pulling $PROVIDER_IMAGE:$PROVIDER_IMAGE_VERSION"
  docker pull "$PROVIDER_IMAGE:$PROVIDER_IMAGE_VERSION" >/dev/null

  # Common environment variables
  local ENV_VARS=(
    -e "AUTHENTIK_SECRET_KEY=$SECRET_KEY"
    -e "AUTHENTIK_BOOTSTRAP_PASSWORD=$BOOTSTRAP_PASSWORD"
    -e "AUTHENTIK_BOOTSTRAP_TOKEN=$BOOTSTRAP_TOKEN"
    -e "AUTHENTIK_POSTGRESQL__HOST=$(echo "$POSTGRES_URL" | sed -n 's|.*@\([^:/]*\).*|\1|p')"
    -e "AUTHENTIK_POSTGRESQL__PORT=$(echo "$POSTGRES_URL" | sed -n 's|.*:\([0-9]*\)/.*|\1|p')"
    -e "AUTHENTIK_POSTGRESQL__USER=$(echo "$POSTGRES_URL" | sed -n 's|postgres://\([^:]*\):.*|\1|p')"
    -e "AUTHENTIK_POSTGRESQL__PASSWORD=$(echo "$POSTGRES_URL" | sed -n 's|postgres://[^:]*:\([^@]*\)@.*|\1|p')"
    -e "AUTHENTIK_POSTGRESQL__NAME=$(echo "$POSTGRES_URL" | sed -n 's|.*/\([^?]*\).*|\1|p')"
    -e "AUTHENTIK_REDIS__HOST=$(echo "$REDIS_URL" | sed -n 's|.*@\([^:/]*\).*|\1|p')"
    -e "AUTHENTIK_REDIS__PORT=$(echo "$REDIS_URL" | sed -n 's|.*:\([0-9]*\)$|\1|p')"
    -e "AUTHENTIK_REDIS__PASSWORD=$(echo "$REDIS_URL" | sed -n 's|redis://[^:]*:\([^@]*\)@.*|\1|p' || echo '')"
    -e "AUTHENTIK_ERROR_REPORTING__ENABLED=false"
    -e "AUTHENTIK_DISABLE_UPDATE_CHECK=true"
    -e "AUTHENTIK_DISABLE_STARTUP_ANALYTICS=true"
    -e "TZ=${TZ:-UTC}"
  )

  # Start Authentik server container
  echo "-----> Starting Authentik server"
  docker run -d \
    --name "$SERVER_CONTAINER" \
    --restart unless-stopped \
    --network "$AUTH_NETWORK" \
    "${ENV_VARS[@]}" \
    -v "$DATA_DIR/media:/media" \
    -v "$DATA_DIR/templates:/templates" \
    -v "$DATA_DIR/certs:/certs" \
    "$PROVIDER_IMAGE:$PROVIDER_IMAGE_VERSION" \
    server >/dev/null

  # Start Authentik worker container
  echo "-----> Starting Authentik worker"
  docker run -d \
    --name "$WORKER_CONTAINER" \
    --restart unless-stopped \
    --network "$AUTH_NETWORK" \
    "${ENV_VARS[@]}" \
    -v "$DATA_DIR/media:/media" \
    -v "$DATA_DIR/templates:/templates" \
    -v "$DATA_DIR/certs:/certs" \
    "$PROVIDER_IMAGE:$PROVIDER_IMAGE_VERSION" \
    worker >/dev/null

  # Wait for Authentik to be ready
  echo "-----> Waiting for Authentik to be ready"
  local retries=60
  while [[ $retries -gt 0 ]]; do
    if docker exec "$SERVER_CONTAINER" wget -q --spider http://localhost:9000/-/health/ready/ 2>/dev/null || \
       docker exec "$SERVER_CONTAINER" curl -sf http://localhost:9000/-/health/ready/ >/dev/null 2>&1; then
      break
    fi
    sleep 2
    retries=$((retries - 1))
  done

  if [[ $retries -eq 0 ]]; then
    echo "!     Authentik failed to start" >&2
    docker logs "$SERVER_CONTAINER" 2>&1 | tail -20 >&2
    return 1
  fi

  # Create initial admin user via API bootstrap
  echo "-----> Setting up initial configuration"
  setup_authentik_initial_config "$SERVICE"
}

# Setup initial Authentik configuration
setup_authentik_initial_config() {
  local SERVICE="$1"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/frontend/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"
  local SERVER_CONTAINER DOMAIN BOOTSTRAP_PASSWORD BOOTSTRAP_TOKEN
  SERVER_CONTAINER=$(get_frontend_container_name "$SERVICE")
  DOMAIN=$(cat "$CONFIG_DIR/DOMAIN")
  BOOTSTRAP_PASSWORD=$(cat "$CONFIG_DIR/BOOTSTRAP_PASSWORD")
  BOOTSTRAP_TOKEN=$(cat "$CONFIG_DIR/BOOTSTRAP_TOKEN")

  # Authentik creates akadmin user automatically with AUTHENTIK_BOOTSTRAP_PASSWORD
  # and sets up an API token with AUTHENTIK_BOOTSTRAP_TOKEN
  echo "       Authentik is ready!"
  echo ""
  echo "       Admin URL: http://$SERVER_CONTAINER:9000/if/admin/"
  echo "       Admin user: akadmin"
  echo "       Admin password: $BOOTSTRAP_PASSWORD"
  echo ""
  echo "       API Token: $BOOTSTRAP_TOKEN"
}

# Validate provider configuration
provider_validate_config() {
  local SERVICE="$1"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/frontend/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"

  if [[ ! -f "$CONFIG_DIR/DOMAIN" ]]; then
    echo "!     Missing required config: DOMAIN" >&2
    return 1
  fi

  # Check if dokku postgres plugin is installed
  if ! command -v dokku &>/dev/null || ! dokku plugin:list 2>/dev/null | grep -q postgres; then
    echo "!     dokku postgres plugin is required" >&2
    return 1
  fi

  # Check if dokku redis plugin is installed
  if ! dokku plugin:list 2>/dev/null | grep -q redis; then
    echo "!     dokku redis plugin is required" >&2
    return 1
  fi

  return 0
}

# Verify the service is working
provider_verify() {
  local SERVICE="$1"
  local SERVER_CONTAINER
  SERVER_CONTAINER=$(get_frontend_container_name "$SERVICE")

  local retries=15
  while [[ $retries -gt 0 ]]; do
    if docker ps -q -f "name=^${SERVER_CONTAINER}$" | grep -q .; then
      if docker exec "$SERVER_CONTAINER" wget -q --spider http://localhost:9000/-/health/ready/ 2>/dev/null || \
         docker exec "$SERVER_CONTAINER" curl -sf http://localhost:9000/-/health/ready/ >/dev/null 2>&1; then
        echo "       Authentik server responding"
        return 0
      fi
    fi
    sleep 2
    retries=$((retries - 1))
  done

  echo "!     Authentik not running or not healthy" >&2
  return 1
}

# Display provider configuration
provider_info() {
  local SERVICE="$1"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/frontend/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"
  local SERVER_CONTAINER
  SERVER_CONTAINER=$(get_frontend_container_name "$SERVICE")
  local BASE_NAME
  BASE_NAME=$(get_authentik_base_name "$SERVICE")

  local DOMAIN DIRECTORY OIDC_ENABLED
  DOMAIN=$(cat "$CONFIG_DIR/DOMAIN" 2>/dev/null || echo "(not set)")
  DIRECTORY=$(cat "$SERVICE_ROOT/DIRECTORY" 2>/dev/null || echo "(none)")

  echo "       Provider: $PROVIDER_DISPLAY_NAME"
  echo "       Image: $PROVIDER_IMAGE:$PROVIDER_IMAGE_VERSION"
  echo "       Server Container: $SERVER_CONTAINER"
  echo "       Worker Container: ${SERVER_CONTAINER}.worker"
  echo "       HTTP Port: $PROVIDER_HTTP_PORT"
  echo "       Domain: $DOMAIN"
  echo "       Directory: $DIRECTORY"
  echo "       PostgreSQL: $BASE_NAME"
  echo "       Redis: $BASE_NAME"
}

# Configure the frontend to use a directory service
provider_use_directory() {
  local SERVICE="$1"
  local DIRECTORY_SERVICE="$2"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/frontend/$SERVICE"

  if ! directory_service_exists "$DIRECTORY_SERVICE"; then
    echo "!     Directory service $DIRECTORY_SERVICE does not exist" >&2
    return 1
  fi

  echo "$DIRECTORY_SERVICE" > "$SERVICE_ROOT/DIRECTORY"

  # In Authentik, LDAP sources are configured via the web UI or API
  # We'll output instructions for now
  echo "       Directory service linked."
  echo "       Configure LDAP source in Authentik admin UI:"
  echo "       Directory -> Federation & Social Login -> Create LDAP Source"

  # Get LDAP credentials to display
  load_directory_provider "$DIRECTORY_SERVICE"
  local CREDS
  CREDS=$(provider_get_bind_credentials "$DIRECTORY_SERVICE")
  echo ""
  echo "       LDAP Configuration:"
  while IFS= read -r line; do
    echo "         $line"
  done <<< "$CREDS"
}

# Enable OIDC (Authentik has OIDC enabled by default)
provider_enable_oidc() {
  local SERVICE="$1"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/frontend/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"

  echo "true" > "$CONFIG_DIR/OIDC_ENABLED"
  mkdir -p "$CONFIG_DIR/oidc_clients"

  echo "       OIDC is enabled by default in Authentik."
  echo "       Create OAuth2/OIDC providers in the admin UI:"
  echo "       Applications -> Providers -> Create OAuth2/OpenID Provider"
}

# Disable OIDC
provider_disable_oidc() {
  local SERVICE="$1"
  echo "       Note: OIDC cannot be fully disabled in Authentik."
  echo "       Remove OIDC providers via the admin UI instead."
}

# Add an OIDC client (creates via API if possible, otherwise instructions)
provider_add_oidc_client() {
  local SERVICE="$1"
  local CLIENT_ID="$2"
  local CLIENT_SECRET="$3"
  local REDIRECT_URI="$4"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/frontend/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"

  mkdir -p "$CONFIG_DIR/oidc_clients"

  # Store client info locally
  cat > "$CONFIG_DIR/oidc_clients/$CLIENT_ID" <<EOF
SECRET=$CLIENT_SECRET
REDIRECT_URI=$REDIRECT_URI
EOF
  chmod 600 "$CONFIG_DIR/oidc_clients/$CLIENT_ID"

  # TODO: Create via Authentik API when we have API token support
  echo "       OIDC client '$CLIENT_ID' registered locally."
  echo "       Create the provider in Authentik admin UI:"
  echo "       1. Go to Applications -> Providers -> Create"
  echo "       2. Select 'OAuth2/OpenID Provider'"
  echo "       3. Set Client ID: $CLIENT_ID"
  echo "       4. Set Client Secret: $CLIENT_SECRET"
  echo "       5. Add Redirect URI: $REDIRECT_URI"
}

# Remove an OIDC client
provider_remove_oidc_client() {
  local SERVICE="$1"
  local CLIENT_ID="$2"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/frontend/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"

  rm -f "$CONFIG_DIR/oidc_clients/$CLIENT_ID"

  echo "       Client '$CLIENT_ID' removed from local config."
  echo "       Also remove the provider from Authentik admin UI."
}

# List OIDC clients
provider_list_oidc_clients() {
  local SERVICE="$1"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/frontend/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"

  if [[ -d "$CONFIG_DIR/oidc_clients" ]]; then
    for client_file in "$CONFIG_DIR/oidc_clients"/*; do
      [[ -f "$client_file" ]] || continue
      basename "$client_file"
    done
  fi
}

# Protect an app with Authentik
provider_protect_app() {
  local SERVICE="$1"
  local APP="$2"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/frontend/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"
  local SERVER_CONTAINER
  SERVER_CONTAINER=$(get_frontend_container_name "$SERVICE")

  local DOMAIN
  DOMAIN=$(cat "$CONFIG_DIR/DOMAIN")

  # Set environment for forward auth proxy
  dokku config:set --no-restart "$APP" \
    AUTHENTIK_URL="http://$SERVER_CONTAINER:9000" \
    AUTHENTIK_DOMAIN="$DOMAIN"

  # Add to protected apps list
  echo "$APP" >> "$SERVICE_ROOT/PROTECTED"
  sort -u "$SERVICE_ROOT/PROTECTED" -o "$SERVICE_ROOT/PROTECTED"

  # Connect app to auth network
  local APP_CONTAINER
  APP_CONTAINER=$(dokku ps:report "$APP" --ps-running-container 2>/dev/null || echo "")
  if [[ -n "$APP_CONTAINER" ]]; then
    docker network connect "$AUTH_NETWORK" "$APP_CONTAINER" 2>/dev/null || true
  fi

  echo "       App protected. Configure forward auth in Authentik:"
  echo "       1. Create an Application for '$APP'"
  echo "       2. Create a Proxy Provider with forward auth mode"
  echo "       3. Configure your reverse proxy to use Authentik"
}

# Remove protection from an app
provider_unprotect_app() {
  local SERVICE="$1"
  local APP="$2"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/frontend/$SERVICE"

  dokku config:unset --no-restart "$APP" AUTHENTIK_URL AUTHENTIK_DOMAIN 2>/dev/null || true

  if [[ -f "$SERVICE_ROOT/PROTECTED" ]]; then
    grep -v "^${APP}$" "$SERVICE_ROOT/PROTECTED" > "$SERVICE_ROOT/PROTECTED.tmp" || true
    mv "$SERVICE_ROOT/PROTECTED.tmp" "$SERVICE_ROOT/PROTECTED"
  fi
}

# Destroy the containers and related resources
provider_destroy() {
  local SERVICE="$1"
  local SERVER_CONTAINER
  SERVER_CONTAINER=$(get_frontend_container_name "$SERVICE")
  local WORKER_CONTAINER="${SERVER_CONTAINER}.worker"
  local BASE_NAME
  BASE_NAME=$(get_authentik_base_name "$SERVICE")

  # Stop and remove containers
  docker stop "$SERVER_CONTAINER" 2>/dev/null || true
  docker rm "$SERVER_CONTAINER" 2>/dev/null || true
  docker stop "$WORKER_CONTAINER" 2>/dev/null || true
  docker rm "$WORKER_CONTAINER" 2>/dev/null || true

  # Destroy PostgreSQL database
  if dokku postgres:exists "$BASE_NAME" 2>/dev/null; then
    echo "       Destroying PostgreSQL database..."
    dokku postgres:destroy "$BASE_NAME" -f >/dev/null 2>&1 || true
  fi

  # Destroy Redis instance
  if dokku redis:exists "$BASE_NAME" 2>/dev/null; then
    echo "       Destroying Redis instance..."
    dokku redis:destroy "$BASE_NAME" -f >/dev/null 2>&1 || true
  fi
}

# Get container logs
provider_logs() {
  local SERVICE="$1"
  shift
  local SERVER_CONTAINER
  SERVER_CONTAINER=$(get_frontend_container_name "$SERVICE")

  echo "=== Server Logs ==="
  docker logs "$@" "$SERVER_CONTAINER"

  echo ""
  echo "=== Worker Logs ==="
  docker logs "$@" "${SERVER_CONTAINER}.worker"
}

# Check if container is running
provider_is_running() {
  local SERVICE="$1"
  local SERVER_CONTAINER
  SERVER_CONTAINER=$(get_frontend_container_name "$SERVICE")

  docker ps -q -f "name=^${SERVER_CONTAINER}$" | grep -q .
}

# Apply configuration changes (restart containers)
provider_apply_config() {
  local SERVICE="$1"
  local SERVER_CONTAINER
  SERVER_CONTAINER=$(get_frontend_container_name "$SERVICE")
  local WORKER_CONTAINER="${SERVER_CONTAINER}.worker"

  echo "       Restarting Authentik containers..."
  docker restart "$SERVER_CONTAINER" "$WORKER_CONTAINER" >/dev/null

  # Wait for ready
  local retries=30
  while [[ $retries -gt 0 ]]; do
    if docker exec "$SERVER_CONTAINER" wget -q --spider http://localhost:9000/-/health/ready/ 2>/dev/null; then
      break
    fi
    sleep 2
    retries=$((retries - 1))
  done
}
