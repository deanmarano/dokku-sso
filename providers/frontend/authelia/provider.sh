#!/usr/bin/env bash
# shellcheck disable=SC2034
# Authelia Frontend Provider
# SSO portal with 2FA support
# SC2034 disabled: Variables are used when this script is sourced

# Provider metadata
PROVIDER_NAME="authelia"
PROVIDER_DISPLAY_NAME="Authelia SSO"
PROVIDER_IMAGE="authelia/authelia"
PROVIDER_IMAGE_VERSION="latest"
PROVIDER_HTTP_PORT="9091"
PROVIDER_REQUIRED_CONFIG="DOMAIN"

# Create and start the Authelia container
# Arguments: SERVICE - name of the service
provider_create_container() {
  local SERVICE="$1"
  local CONTAINER_NAME
  CONTAINER_NAME=$(get_frontend_container_name "$SERVICE")
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/frontend/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"
  local DATA_DIR="$SERVICE_ROOT/data"

  # Read or generate configuration
  local DOMAIN JWT_SECRET SESSION_SECRET STORAGE_KEY IDENTITY_VALIDATION_SECRET
  DOMAIN=$(cat "$CONFIG_DIR/DOMAIN" 2>/dev/null || echo "auth.test.local")
  JWT_SECRET=$(cat "$CONFIG_DIR/JWT_SECRET" 2>/dev/null || openssl rand -hex 32)
  SESSION_SECRET=$(cat "$CONFIG_DIR/SESSION_SECRET" 2>/dev/null || openssl rand -hex 32)
  STORAGE_KEY=$(cat "$CONFIG_DIR/STORAGE_KEY" 2>/dev/null || openssl rand -hex 32)

  IDENTITY_VALIDATION_SECRET=$(cat "$CONFIG_DIR/IDENTITY_VALIDATION_SECRET" 2>/dev/null || openssl rand -hex 32)

  # Save configuration
  mkdir -p "$CONFIG_DIR" "$DATA_DIR"
  echo "$DOMAIN" > "$CONFIG_DIR/DOMAIN"
  echo "$JWT_SECRET" > "$CONFIG_DIR/JWT_SECRET"
  echo "$SESSION_SECRET" > "$CONFIG_DIR/SESSION_SECRET"
  echo "$STORAGE_KEY" > "$CONFIG_DIR/STORAGE_KEY"
  echo "$IDENTITY_VALIDATION_SECRET" > "$CONFIG_DIR/IDENTITY_VALIDATION_SECRET"
  # Only chmod regular files, not directories (directories need execute bit)
  for f in "$CONFIG_DIR"/*; do
    [[ -f "$f" ]] && chmod 600 "$f"
  done

  # Get directory service info if linked
  local LDAP_URL LDAP_BASE_DN LDAP_BIND_DN LDAP_BIND_PASSWORD
  if [[ -f "$SERVICE_ROOT/DIRECTORY" ]]; then
    local DIRECTORY_SERVICE
    DIRECTORY_SERVICE=$(cat "$SERVICE_ROOT/DIRECTORY")
    if directory_service_exists "$DIRECTORY_SERVICE"; then
      load_directory_provider "$DIRECTORY_SERVICE"
      eval "$(provider_get_bind_credentials "$DIRECTORY_SERVICE")"
    fi
  fi

  # Generate Authelia configuration
  generate_authelia_config "$SERVICE"

  # Restore Authelia provider variables (may have been overwritten by load_directory_provider inside generate_authelia_config)
  PROVIDER_IMAGE="authelia/authelia"
  PROVIDER_IMAGE_VERSION="latest"

  # Pull image
  echo "-----> Pulling $PROVIDER_IMAGE:$PROVIDER_IMAGE_VERSION"
  docker pull "$PROVIDER_IMAGE:$PROVIDER_IMAGE_VERSION" >/dev/null

  # Create container (no host port binding - use network for communication)
  echo "-----> Starting Authelia container"
  docker run -d \
    --name "$CONTAINER_NAME" \
    --restart unless-stopped \
    --network "$AUTH_NETWORK" \
    -v "$CONFIG_DIR/configuration.yml:/config/configuration.yml:ro" \
    -v "$DATA_DIR:/data" \
    -e "TZ=${TZ:-UTC}" \
    "$PROVIDER_IMAGE:$PROVIDER_IMAGE_VERSION" >/dev/null

  # Wait for container to be ready
  echo "-----> Waiting for Authelia to be ready"
  local retries=30
  while [[ $retries -gt 0 ]]; do
    # Check if health endpoint responds
    if docker exec "$CONTAINER_NAME" wget -q --spider http://localhost:9091/api/health 2>/dev/null || \
       docker exec "$CONTAINER_NAME" curl -sf http://localhost:9091/api/health >/dev/null 2>&1; then
      break
    fi
    sleep 2
    retries=$((retries - 1))
  done

  if [[ $retries -eq 0 ]]; then
    echo "!     Authelia failed to start" >&2
    docker logs "$CONTAINER_NAME" 2>&1 | tail -10 >&2
    return 1
  fi
}

# Generate Authelia configuration file
generate_authelia_config() {
  local SERVICE="$1"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/frontend/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"

  local DOMAIN JWT_SECRET SESSION_SECRET STORAGE_KEY IDENTITY_VALIDATION_SECRET
  DOMAIN=$(cat "$CONFIG_DIR/DOMAIN")
  JWT_SECRET=$(cat "$CONFIG_DIR/JWT_SECRET")
  SESSION_SECRET=$(cat "$CONFIG_DIR/SESSION_SECRET")
  STORAGE_KEY=$(cat "$CONFIG_DIR/STORAGE_KEY")
  IDENTITY_VALIDATION_SECRET=$(cat "$CONFIG_DIR/IDENTITY_VALIDATION_SECRET" 2>/dev/null || echo "$JWT_SECRET")

  # Extract cookie domain (parent domain for sharing cookies)
  # e.g., auth.example.com -> example.com
  local COOKIE_DOMAIN
  if [[ "$DOMAIN" == *.*.* ]]; then
    # Has at least 2 dots, strip first subdomain
    COOKIE_DOMAIN="${DOMAIN#*.}"
  else
    # Single subdomain like auth.local, use as-is
    COOKIE_DOMAIN="$DOMAIN"
  fi

  # Determine URL scheme - use http for localhost (testing), https otherwise
  local URL_SCHEME="https"
  if [[ "$DOMAIN" == localhost* ]]; then
    URL_SCHEME="http"
  fi

  # Get LDAP settings if available
  local LDAP_URL="" LDAP_BASE_DN="" LDAP_BIND_DN="" LDAP_BIND_PASSWORD=""
  if [[ -f "$SERVICE_ROOT/DIRECTORY" ]]; then
    local DIRECTORY_SERVICE
    DIRECTORY_SERVICE=$(cat "$SERVICE_ROOT/DIRECTORY")
    if directory_service_exists "$DIRECTORY_SERVICE"; then
      load_directory_provider "$DIRECTORY_SERVICE"
      eval "$(provider_get_bind_credentials "$DIRECTORY_SERVICE")"
    fi
  fi

  # Generate OIDC clients section if any exist
  local OIDC_CLIENTS_YAML=""
  if [[ -d "$CONFIG_DIR/oidc_clients" ]]; then
    OIDC_CLIENTS_YAML=$(generate_oidc_clients_yaml "$SERVICE")
  fi

  cat > "$CONFIG_DIR/configuration.yml" <<EOF
---
theme: light

server:
  address: tcp://0.0.0.0:9091/

log:
  level: info

totp:
  issuer: $DOMAIN

webauthn:
  disable: false
  display_name: $DOMAIN

duo_api:
  disable: true

authentication_backend:
EOF

  if [[ -n "$LDAP_URL" ]]; then
    cat >> "$CONFIG_DIR/configuration.yml" <<EOF
  ldap:
    address: $LDAP_URL
    implementation: custom
    timeout: 5s
    start_tls: false
    base_dn: $LDAP_BASE_DN
    additional_users_dn: ou=people
    users_filter: (&(|({username_attribute}={input})({mail_attribute}={input}))(objectClass=person))
    additional_groups_dn: ou=groups
    groups_filter: (member={dn})
    user: $LDAP_BIND_DN
    password: $LDAP_BIND_PASSWORD
    attributes:
      distinguished_name: ''
      username: uid
      display_name: displayName
      mail: mail
      member_of: memberOf
      group_name: cn
EOF
  else
    cat >> "$CONFIG_DIR/configuration.yml" <<EOF
  file:
    path: /data/users.yml
    watch: true
    search:
      email: true
      case_insensitive: true
    password:
      algorithm: argon2
EOF
  fi

  cat >> "$CONFIG_DIR/configuration.yml" <<EOF

identity_validation:
  reset_password:
    jwt_secret: $IDENTITY_VALIDATION_SECRET

access_control:
  default_policy: deny
  rules:
    - domain: '*.$COOKIE_DOMAIN'
      policy: one_factor

session:
  name: authelia_session
  secret: $SESSION_SECRET
  cookies:
    - domain: '$COOKIE_DOMAIN'
      authelia_url: '$URL_SCHEME://$DOMAIN'
      default_redirection_url: '$URL_SCHEME://$COOKIE_DOMAIN'

regulation:
  max_retries: 3
  find_time: 2m
  ban_time: 5m

storage:
  encryption_key: $STORAGE_KEY
  local:
    path: /data/db.sqlite3

notifier:
  filesystem:
    filename: /data/notification.txt
EOF

  # Add OIDC section if enabled
  if [[ -f "$CONFIG_DIR/OIDC_ENABLED" ]] && [[ "$(cat "$CONFIG_DIR/OIDC_ENABLED")" == "true" ]]; then
    local OIDC_HMAC_SECRET OIDC_PRIVATE_KEY
    OIDC_HMAC_SECRET=$(cat "$CONFIG_DIR/OIDC_HMAC_SECRET" 2>/dev/null || openssl rand -hex 32)
    echo "$OIDC_HMAC_SECRET" > "$CONFIG_DIR/OIDC_HMAC_SECRET"
    chmod 600 "$CONFIG_DIR/OIDC_HMAC_SECRET"

    # Generate RSA key if not exists
    if [[ ! -f "$CONFIG_DIR/oidc_private_key.pem" ]]; then
      openssl genrsa -out "$CONFIG_DIR/oidc_private_key.pem" 4096 2>/dev/null
      chmod 600 "$CONFIG_DIR/oidc_private_key.pem"
    fi

    cat >> "$CONFIG_DIR/configuration.yml" <<EOF

identity_providers:
  oidc:
    hmac_secret: $OIDC_HMAC_SECRET
    jwks:
      - key: |
$(sed 's/^/          /' "$CONFIG_DIR/oidc_private_key.pem")
    cors:
      endpoints:
        - authorization
        - token
        - revocation
        - introspection
      allowed_origins_from_client_redirect_uris: true
EOF

    if [[ -n "$OIDC_CLIENTS_YAML" ]]; then
      cat >> "$CONFIG_DIR/configuration.yml" <<EOF
    clients:
$OIDC_CLIENTS_YAML
EOF
    fi
  fi

  chmod 600 "$CONFIG_DIR/configuration.yml"
}

# Generate OIDC clients YAML
generate_oidc_clients_yaml() {
  local SERVICE="$1"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/frontend/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"

  for client_file in "$CONFIG_DIR/oidc_clients"/*; do
    [[ -f "$client_file" ]] || continue
    local CLIENT_ID
    CLIENT_ID=$(basename "$client_file")
    local CLIENT_SECRET REDIRECT_URI
    CLIENT_SECRET=$(grep '^SECRET=' "$client_file" | cut -d= -f2-)
    REDIRECT_URI=$(grep '^REDIRECT_URI=' "$client_file" | cut -d= -f2-)

    # Hash the secret
    local HASHED_SECRET
    HASHED_SECRET=$(docker run --rm authelia/authelia:latest authelia crypto hash generate argon2 --password "$CLIENT_SECRET" 2>/dev/null | grep 'Digest:' | cut -d' ' -f2)

    cat <<EOF
      - client_id: $CLIENT_ID
        client_name: $CLIENT_ID
        client_secret: '$HASHED_SECRET'
        public: false
        authorization_policy: one_factor
        consent_mode: implicit
        redirect_uris:
          - $REDIRECT_URI
        scopes:
          - openid
          - profile
          - email
          - groups
        userinfo_signed_response_alg: none
        token_endpoint_auth_method: client_secret_post
EOF
  done
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

  return 0
}

# Verify the service is working
provider_verify() {
  local SERVICE="$1"
  local CONTAINER_NAME
  CONTAINER_NAME=$(get_frontend_container_name "$SERVICE")

  # Give container time to settle after startup (up to 30 seconds)
  local retries=15
  while [[ $retries -gt 0 ]]; do
    if docker ps -q -f "name=^${CONTAINER_NAME}$" | grep -q .; then
      # Check if HTTP endpoint is responding (Authelia has /api/health)
      if docker exec "$CONTAINER_NAME" wget -q --spider http://localhost:9091/api/health 2>/dev/null || \
         docker exec "$CONTAINER_NAME" curl -sf http://localhost:9091/api/health >/dev/null 2>&1; then
        echo "       HTTP port responding"
        return 0
      fi
    fi
    sleep 2
    retries=$((retries - 1))
  done

  echo "!     Container not running or not healthy" >&2
  return 1
}

# Display provider configuration
provider_info() {
  local SERVICE="$1"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/frontend/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"
  local CONTAINER_NAME
  CONTAINER_NAME=$(get_frontend_container_name "$SERVICE")

  local DOMAIN DIRECTORY OIDC_ENABLED
  DOMAIN=$(cat "$CONFIG_DIR/DOMAIN" 2>/dev/null || echo "(not set)")
  DIRECTORY=$(cat "$SERVICE_ROOT/DIRECTORY" 2>/dev/null || echo "(none)")
  OIDC_ENABLED=$(cat "$CONFIG_DIR/OIDC_ENABLED" 2>/dev/null || echo "false")

  echo "       Provider: $PROVIDER_DISPLAY_NAME"
  echo "       Image: $PROVIDER_IMAGE:$PROVIDER_IMAGE_VERSION"
  echo "       Container: $CONTAINER_NAME"
  echo "       HTTP Port: $PROVIDER_HTTP_PORT"
  echo "       Domain: $DOMAIN"
  echo "       Directory: $DIRECTORY"
  echo "       OIDC Enabled: $OIDC_ENABLED"
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

  # Regenerate config
  generate_authelia_config "$SERVICE"
}

# Protect an app with Authelia
provider_protect_app() {
  local SERVICE="$1"
  local APP="$2"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/frontend/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"
  local CONTAINER_NAME
  CONTAINER_NAME=$(get_frontend_container_name "$SERVICE")

  local DOMAIN
  DOMAIN=$(cat "$CONFIG_DIR/DOMAIN")

  # Set nginx configuration for forward auth
  dokku config:set --no-restart "$APP" \
    AUTHELIA_URL="http://$CONTAINER_NAME:9091" \
    AUTHELIA_DOMAIN="$DOMAIN"

  # Add to protected apps list
  echo "$APP" >> "$SERVICE_ROOT/PROTECTED"
  sort -u "$SERVICE_ROOT/PROTECTED" -o "$SERVICE_ROOT/PROTECTED"

  # Connect app to auth network
  local APP_CONTAINER
  APP_CONTAINER=$(dokku ps:report "$APP" --ps-running-container 2>/dev/null || echo "")
  if [[ -n "$APP_CONTAINER" ]]; then
    docker network connect "$AUTH_NETWORK" "$APP_CONTAINER" 2>/dev/null || true
  fi
}

# Remove protection from an app
provider_unprotect_app() {
  local SERVICE="$1"
  local APP="$2"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/frontend/$SERVICE"

  # Remove Authelia config
  dokku config:unset --no-restart "$APP" AUTHELIA_URL AUTHELIA_DOMAIN 2>/dev/null || true

  # Remove from protected apps list
  if [[ -f "$SERVICE_ROOT/PROTECTED" ]]; then
    grep -v "^${APP}$" "$SERVICE_ROOT/PROTECTED" > "$SERVICE_ROOT/PROTECTED.tmp" || true
    mv "$SERVICE_ROOT/PROTECTED.tmp" "$SERVICE_ROOT/PROTECTED"
  fi
}

# Enable OIDC
provider_enable_oidc() {
  local SERVICE="$1"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/frontend/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"

  echo "true" > "$CONFIG_DIR/OIDC_ENABLED"
  mkdir -p "$CONFIG_DIR/oidc_clients"

  # Regenerate config
  generate_authelia_config "$SERVICE"
}

# Disable OIDC
provider_disable_oidc() {
  local SERVICE="$1"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/frontend/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"

  echo "false" > "$CONFIG_DIR/OIDC_ENABLED"

  # Regenerate config
  generate_authelia_config "$SERVICE"
}

# Add an OIDC client
provider_add_oidc_client() {
  local SERVICE="$1"
  local CLIENT_ID="$2"
  local CLIENT_SECRET="$3"
  local REDIRECT_URI="$4"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/frontend/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"

  mkdir -p "$CONFIG_DIR/oidc_clients"

  cat > "$CONFIG_DIR/oidc_clients/$CLIENT_ID" <<EOF
SECRET=$CLIENT_SECRET
REDIRECT_URI=$REDIRECT_URI
EOF
  chmod 600 "$CONFIG_DIR/oidc_clients/$CLIENT_ID"

  # Regenerate config
  generate_authelia_config "$SERVICE"
}

# Remove an OIDC client
provider_remove_oidc_client() {
  local SERVICE="$1"
  local CLIENT_ID="$2"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/frontend/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"

  rm -f "$CONFIG_DIR/oidc_clients/$CLIENT_ID"

  # Regenerate config
  generate_authelia_config "$SERVICE"
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

# Destroy the container
provider_destroy() {
  local SERVICE="$1"
  local CONTAINER_NAME
  CONTAINER_NAME=$(get_frontend_container_name "$SERVICE")

  docker stop "$CONTAINER_NAME" 2>/dev/null || true
  docker rm "$CONTAINER_NAME" 2>/dev/null || true
}

# Get container logs
provider_logs() {
  local SERVICE="$1"
  shift
  local CONTAINER_NAME
  CONTAINER_NAME=$(get_frontend_container_name "$SERVICE")

  docker logs "$@" "$CONTAINER_NAME"
}

# Check if container is running
provider_is_running() {
  local SERVICE="$1"
  local CONTAINER_NAME
  CONTAINER_NAME=$(get_frontend_container_name "$SERVICE")

  docker ps -q -f "name=^${CONTAINER_NAME}$" | grep -q .
}
