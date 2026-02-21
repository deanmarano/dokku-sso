#!/usr/bin/env bash
# shellcheck disable=SC2034
# Authentik Frontend Provider
# Modern open-source identity provider with OIDC/OAuth2/SAML support
# SC2034 disabled: Variables are used when this script is sourced
#
# This provider manages its own PostgreSQL and Redis containers directly.

# Provider metadata
PROVIDER_NAME="authentik"
PROVIDER_DISPLAY_NAME="Authentik"
PROVIDER_IMAGE="ghcr.io/goauthentik/server"
PROVIDER_IMAGE_VERSION="2024.2"
PROVIDER_HTTP_PORT="9000"
PROVIDER_REQUIRED_CONFIG="DOMAIN"

# Container images for dependencies
POSTGRES_IMAGE="postgres:15-alpine"
REDIS_IMAGE="redis:7-alpine"

# Get container names for Authentik resources
get_authentik_postgres_container() {
  local SERVICE="$1"
  echo "dokku.auth.frontend.${SERVICE}.postgres"
}

get_authentik_redis_container() {
  local SERVICE="$1"
  echo "dokku.auth.frontend.${SERVICE}.redis"
}

# Create and start the Authentik containers
provider_create_container() {
  local SERVICE="$1"
  local SERVER_CONTAINER
  SERVER_CONTAINER=$(get_frontend_container_name "$SERVICE")
  local WORKER_CONTAINER="${SERVER_CONTAINER}.worker"
  local POSTGRES_CONTAINER
  POSTGRES_CONTAINER=$(get_authentik_postgres_container "$SERVICE")
  local REDIS_CONTAINER
  REDIS_CONTAINER=$(get_authentik_redis_container "$SERVICE")
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/frontend/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"
  local DATA_DIR="$SERVICE_ROOT/data"

  # Read or generate configuration
  local DOMAIN SECRET_KEY BOOTSTRAP_PASSWORD BOOTSTRAP_TOKEN
  DOMAIN=$(cat "$CONFIG_DIR/DOMAIN" 2>/dev/null || echo "auth.test.local")
  SECRET_KEY=$(cat "$CONFIG_DIR/SECRET_KEY" 2>/dev/null || openssl rand -hex 50)
  BOOTSTRAP_PASSWORD=$(cat "$CONFIG_DIR/BOOTSTRAP_PASSWORD" 2>/dev/null || openssl rand -base64 16 | tr -d '/+=')
  BOOTSTRAP_TOKEN=$(cat "$CONFIG_DIR/BOOTSTRAP_TOKEN" 2>/dev/null || openssl rand -hex 32)

  # Generate postgres credentials
  local POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB
  POSTGRES_USER=$(cat "$CONFIG_DIR/POSTGRES_USER" 2>/dev/null || echo "authentik")
  POSTGRES_PASSWORD=$(cat "$CONFIG_DIR/POSTGRES_PASSWORD" 2>/dev/null || openssl rand -base64 24 | tr -d '/+=')
  POSTGRES_DB=$(cat "$CONFIG_DIR/POSTGRES_DB" 2>/dev/null || echo "authentik")

  # Save configuration
  mkdir -p "$CONFIG_DIR" "$DATA_DIR/media" "$DATA_DIR/templates" "$DATA_DIR/certs" "$DATA_DIR/postgres" "$DATA_DIR/redis"
  echo "$DOMAIN" > "$CONFIG_DIR/DOMAIN"
  echo "$SECRET_KEY" > "$CONFIG_DIR/SECRET_KEY"
  echo "$BOOTSTRAP_PASSWORD" > "$CONFIG_DIR/BOOTSTRAP_PASSWORD"
  echo "$BOOTSTRAP_TOKEN" > "$CONFIG_DIR/BOOTSTRAP_TOKEN"
  echo "$POSTGRES_USER" > "$CONFIG_DIR/POSTGRES_USER"
  echo "$POSTGRES_PASSWORD" > "$CONFIG_DIR/POSTGRES_PASSWORD"
  echo "$POSTGRES_DB" > "$CONFIG_DIR/POSTGRES_DB"
  for f in "$CONFIG_DIR"/*; do
    [[ -f "$f" ]] && chmod 600 "$f"
  done

  # Set permissions for Authentik data directories (Authentik runs as UID 1000)
  # Use world-writable permissions since we can't chown as dokku user
  chmod -R 777 "$DATA_DIR/media" "$DATA_DIR/templates" "$DATA_DIR/certs" 2>/dev/null || true

  # Pull required images
  echo "-----> Pulling PostgreSQL image"
  docker pull "$POSTGRES_IMAGE" >/dev/null

  echo "-----> Pulling Redis image"
  docker pull "$REDIS_IMAGE" >/dev/null

  echo "-----> Pulling Authentik image"
  docker pull "$PROVIDER_IMAGE:$PROVIDER_IMAGE_VERSION" >/dev/null

  # Create PostgreSQL container
  echo "-----> Starting PostgreSQL container"
  docker run -d \
    --name "$POSTGRES_CONTAINER" \
    --restart unless-stopped \
    --network "$AUTH_NETWORK" \
    -e "POSTGRES_USER=$POSTGRES_USER" \
    -e "POSTGRES_PASSWORD=$POSTGRES_PASSWORD" \
    -e "POSTGRES_DB=$POSTGRES_DB" \
    -v "$DATA_DIR/postgres:/var/lib/postgresql/data" \
    "$POSTGRES_IMAGE" >/dev/null

  # Create Redis container
  echo "-----> Starting Redis container"
  docker run -d \
    --name "$REDIS_CONTAINER" \
    --restart unless-stopped \
    --network "$AUTH_NETWORK" \
    -v "$DATA_DIR/redis:/data" \
    "$REDIS_IMAGE" >/dev/null

  # Wait for postgres to be ready
  echo "-----> Waiting for PostgreSQL to be ready"
  local retries=30
  while [[ $retries -gt 0 ]]; do
    if docker exec "$POSTGRES_CONTAINER" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
      break
    fi
    sleep 1
    retries=$((retries - 1))
  done
  if [[ $retries -eq 0 ]]; then
    echo "!     PostgreSQL failed to start" >&2
    return 1
  fi

  # Common environment variables for Authentik
  local ENV_VARS=(
    -e "AUTHENTIK_SECRET_KEY=$SECRET_KEY"
    -e "AUTHENTIK_BOOTSTRAP_PASSWORD=$BOOTSTRAP_PASSWORD"
    -e "AUTHENTIK_BOOTSTRAP_TOKEN=$BOOTSTRAP_TOKEN"
    -e "AUTHENTIK_POSTGRESQL__HOST=$POSTGRES_CONTAINER"
    -e "AUTHENTIK_POSTGRESQL__PORT=5432"
    -e "AUTHENTIK_POSTGRESQL__USER=$POSTGRES_USER"
    -e "AUTHENTIK_POSTGRESQL__PASSWORD=$POSTGRES_PASSWORD"
    -e "AUTHENTIK_POSTGRESQL__NAME=$POSTGRES_DB"
    -e "AUTHENTIK_REDIS__HOST=$REDIS_CONTAINER"
    -e "AUTHENTIK_REDIS__PORT=6379"
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
  # Authentik containers have a built-in healthcheck command 'ak healthcheck'
  echo "-----> Waiting for Authentik to be ready"
  local retries=90
  while [[ $retries -gt 0 ]]; do
    if docker exec "$SERVER_CONTAINER" ak healthcheck 2>/dev/null; then
      break
    fi
    sleep 2
    retries=$((retries - 1))
  done

  if [[ $retries -eq 0 ]]; then
    echo "!     Authentik failed to start" >&2
    docker logs "$SERVER_CONTAINER" 2>&1 | tail -30 >&2
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

  # Check if docker is available
  if ! command -v docker &>/dev/null; then
    echo "!     Docker is required" >&2
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
      if docker exec "$SERVER_CONTAINER" ak healthcheck 2>/dev/null; then
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
  local POSTGRES_CONTAINER
  POSTGRES_CONTAINER=$(get_authentik_postgres_container "$SERVICE")
  local REDIS_CONTAINER
  REDIS_CONTAINER=$(get_authentik_redis_container "$SERVICE")

  local DOMAIN DIRECTORY
  DOMAIN=$(cat "$CONFIG_DIR/DOMAIN" 2>/dev/null || echo "(not set)")
  DIRECTORY=$(cat "$SERVICE_ROOT/DIRECTORY" 2>/dev/null || echo "(none)")

  echo "       Provider: $PROVIDER_DISPLAY_NAME"
  echo "       Image: $PROVIDER_IMAGE:$PROVIDER_IMAGE_VERSION"
  echo "       Server Container: $SERVER_CONTAINER"
  echo "       Worker Container: ${SERVER_CONTAINER}.worker"
  echo "       PostgreSQL Container: $POSTGRES_CONTAINER"
  echo "       Redis Container: $REDIS_CONTAINER"
  echo "       HTTP Port: $PROVIDER_HTTP_PORT"
  echo "       Domain: $DOMAIN"
  echo "       Directory: $DIRECTORY"
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
  "$DOKKU_BIN" config:set --no-restart "$APP" \
    AUTHENTIK_URL="http://$SERVER_CONTAINER:9000" \
    AUTHENTIK_DOMAIN="$DOMAIN" < /dev/null

  # Add to protected apps list
  echo "$APP" >> "$SERVICE_ROOT/PROTECTED"
  sort -u "$SERVICE_ROOT/PROTECTED" -o "$SERVICE_ROOT/PROTECTED"

  # Connect app to auth network
  local APP_CONTAINER
  APP_CONTAINER=$("$DOKKU_BIN" ps:report "$APP" --ps-running-container < /dev/null 2>/dev/null || echo "")
  if [[ -n "$APP_CONTAINER" ]]; then
    docker network connect "$AUTH_NETWORK" "$APP_CONTAINER" 2>/dev/null || true
  fi

  # Write nginx forward auth config
  # The nginx-pre-reload trigger injects auth_request/error_page into location /
  # This file provides: supporting locations + directives for the trigger to extract
  local DOKKU_ROOT="${DOKKU_ROOT:-/home/dokku}"
  local NGINX_CONF_DIR="$DOKKU_ROOT/$APP/nginx.conf.d"
  mkdir -p "$NGINX_CONF_DIR"
  cat > "$NGINX_CONF_DIR/forward-auth.conf" <<EOF
# Authentik forward auth - managed by dokku-auth plugin
# Server-level locations
location /outpost.goauthentik.io {
    internal;
    proxy_pass https://$DOMAIN/outpost.goauthentik.io/auth/nginx;
    proxy_pass_request_body off;
    proxy_ssl_verify off;
    proxy_set_header Content-Length "";
    proxy_set_header X-Original-Method \$request_method;
    proxy_set_header X-Original-URL \$scheme://\$http_host\$request_uri;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header X-Forwarded-Host \$http_host;
    proxy_set_header X-Forwarded-Uri \$request_uri;
}

location @forward_auth_login {
    auth_request off;
    return 302 https://$DOMAIN/outpost.goauthentik.io/start?rd=\$scheme://\$http_host\$request_uri;
}

# Directives below are injected into location / by the nginx-pre-reload trigger
auth_request /outpost.goauthentik.io;
auth_request_set \$authentik_user \$upstream_http_x_authentik_username;
auth_request_set \$authentik_groups \$upstream_http_x_authentik_groups;
auth_request_set \$authentik_name \$upstream_http_x_authentik_name;
auth_request_set \$authentik_email \$upstream_http_x_authentik_email;
error_page 401 = @forward_auth_login;
EOF

  # Rebuild nginx config (triggers nginx-pre-reload hook)
  "$DOKKU_BIN" proxy:build-config "$APP" < /dev/null 2>/dev/null || true

  echo "       App protected. Configure forward auth in Authentik:"
  echo "       1. Create an Application for '$APP'"
  echo "       2. Create a Proxy Provider with forward auth mode"
}

# Remove protection from an app
provider_unprotect_app() {
  local SERVICE="$1"
  local APP="$2"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/frontend/$SERVICE"

  "$DOKKU_BIN" config:unset --no-restart "$APP" AUTHENTIK_URL AUTHENTIK_DOMAIN < /dev/null 2>/dev/null || true

  if [[ -f "$SERVICE_ROOT/PROTECTED" ]]; then
    grep -v "^${APP}$" "$SERVICE_ROOT/PROTECTED" > "$SERVICE_ROOT/PROTECTED.tmp" || true
    mv "$SERVICE_ROOT/PROTECTED.tmp" "$SERVICE_ROOT/PROTECTED"
  fi

  # Remove nginx forward auth include
  local DOKKU_ROOT="${DOKKU_ROOT:-/home/dokku}"
  rm -f "$DOKKU_ROOT/$APP/nginx.conf.d/forward-auth.conf"

  # Rebuild nginx config
  "$DOKKU_BIN" proxy:build-config "$APP" < /dev/null 2>/dev/null || true
}

# Destroy the containers and related resources
provider_destroy() {
  local SERVICE="$1"
  local SERVER_CONTAINER
  SERVER_CONTAINER=$(get_frontend_container_name "$SERVICE")
  local WORKER_CONTAINER="${SERVER_CONTAINER}.worker"
  local POSTGRES_CONTAINER
  POSTGRES_CONTAINER=$(get_authentik_postgres_container "$SERVICE")
  local REDIS_CONTAINER
  REDIS_CONTAINER=$(get_authentik_redis_container "$SERVICE")

  # Stop and remove Authentik containers
  docker stop "$SERVER_CONTAINER" 2>/dev/null || true
  docker rm "$SERVER_CONTAINER" 2>/dev/null || true
  docker stop "$WORKER_CONTAINER" 2>/dev/null || true
  docker rm "$WORKER_CONTAINER" 2>/dev/null || true

  # Stop and remove PostgreSQL container
  if docker ps -a -q -f "name=^${POSTGRES_CONTAINER}$" | grep -q .; then
    echo "       Destroying PostgreSQL container..."
    docker stop "$POSTGRES_CONTAINER" 2>/dev/null || true
    docker rm "$POSTGRES_CONTAINER" 2>/dev/null || true
  fi

  # Stop and remove Redis container
  if docker ps -a -q -f "name=^${REDIS_CONTAINER}$" | grep -q .; then
    echo "       Destroying Redis container..."
    docker stop "$REDIS_CONTAINER" 2>/dev/null || true
    docker rm "$REDIS_CONTAINER" 2>/dev/null || true
  fi
}

# Get container logs
provider_logs() {
  local SERVICE="$1"
  shift
  local SERVER_CONTAINER
  SERVER_CONTAINER=$(get_frontend_container_name "$SERVICE")
  local POSTGRES_CONTAINER
  POSTGRES_CONTAINER=$(get_authentik_postgres_container "$SERVICE")
  local REDIS_CONTAINER
  REDIS_CONTAINER=$(get_authentik_redis_container "$SERVICE")

  echo "=== Server Logs ==="
  docker logs "$@" "$SERVER_CONTAINER" 2>&1 || true

  echo ""
  echo "=== Worker Logs ==="
  docker logs "$@" "${SERVER_CONTAINER}.worker" 2>&1 || true

  echo ""
  echo "=== PostgreSQL Logs ==="
  docker logs "$@" "$POSTGRES_CONTAINER" 2>&1 || true

  echo ""
  echo "=== Redis Logs ==="
  docker logs "$@" "$REDIS_CONTAINER" 2>&1 || true
}

# Check if container is running
provider_is_running() {
  local SERVICE="$1"
  local SERVER_CONTAINER
  SERVER_CONTAINER=$(get_frontend_container_name "$SERVICE")
  local POSTGRES_CONTAINER
  POSTGRES_CONTAINER=$(get_authentik_postgres_container "$SERVICE")
  local REDIS_CONTAINER
  REDIS_CONTAINER=$(get_authentik_redis_container "$SERVICE")

  # Check all required containers are running
  docker ps -q -f "name=^${SERVER_CONTAINER}$" | grep -q . && \
  docker ps -q -f "name=^${POSTGRES_CONTAINER}$" | grep -q . && \
  docker ps -q -f "name=^${REDIS_CONTAINER}$" | grep -q .
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
    if docker exec "$SERVER_CONTAINER" ak healthcheck 2>/dev/null; then
      break
    fi
    sleep 2
    retries=$((retries - 1))
  done
}
