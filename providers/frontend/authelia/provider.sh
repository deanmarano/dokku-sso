#!/usr/bin/env bash
# shellcheck disable=SC2034
# Authelia Frontend Provider
# SSO portal with 2FA support — managed as a Dokku app
# SC2034 disabled: Variables are used when this script is sourced

# Provider metadata
PROVIDER_NAME="authelia"
PROVIDER_DISPLAY_NAME="Authelia SSO"
PROVIDER_IMAGE="authelia/authelia"
PROVIDER_IMAGE_VERSION="latest"
PROVIDER_HTTP_PORT="9091"
PROVIDER_REQUIRED_CONFIG="DOMAIN"

# Create and deploy Authelia as a Dokku app
# Arguments: SERVICE - name of the service
provider_create_container() {
  local SERVICE="$1"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/frontend/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"
  local DATA_DIR="$SERVICE_ROOT/data"

  # Determine app name
  local APP_NAME
  APP_NAME=$(get_frontend_app_name "$SERVICE")
  if [[ -z "$APP_NAME" ]]; then
    APP_NAME="authelia"
    echo "$APP_NAME" > "$SERVICE_ROOT/APP_NAME"
  fi

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

  # Create users.yml if using file-based auth (no LDAP linked)
  # Authelia v4.39+ crashes fatally if users.yml is missing or empty
  if [[ ! -f "$SERVICE_ROOT/DIRECTORY" ]] && [[ ! -f "$DATA_DIR/users.yml" ]]; then
    cat > "$DATA_DIR/users.yml" <<'USERSEOF'
users:
  placeholder:
    disabled: true
    displayname: "Placeholder"
    email: placeholder@localhost
    password: "$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
USERSEOF
    chmod 644 "$DATA_DIR/users.yml"
  fi

  # Authelia container runs as non-root (UID 8000 since v4.38+).
  # Data directory must be writable for SQLite DB and notification files.
  chmod 777 "$DATA_DIR"

  # Restore Authelia provider variables (may have been overwritten by load_directory_provider)
  PROVIDER_IMAGE="authelia/authelia"
  PROVIDER_IMAGE_VERSION="latest"

  # Create Dokku app if it doesn't exist
  if ! "$DOKKU_BIN" apps:exists "$APP_NAME" < /dev/null 2>/dev/null; then
    echo "-----> Creating Dokku app $APP_NAME"
    "$DOKKU_BIN" apps:create "$APP_NAME" < /dev/null
  fi

  # Mount config and data directories (|| true for idempotent re-runs where mount already exists)
  echo "-----> Mounting storage volumes"
  "$DOKKU_BIN" storage:mount "$APP_NAME" "$CONFIG_DIR/configuration.yml:/config/configuration.yml" < /dev/null 2>/dev/null || true
  "$DOKKU_BIN" storage:mount "$APP_NAME" "$DATA_DIR:/data" < /dev/null 2>/dev/null || true
  # Verify mounts were registered
  if ! "$DOKKU_BIN" storage:report "$APP_NAME" < /dev/null 2>/dev/null | grep -q "configuration.yml"; then
    echo "!     Warning: config mount may not be registered" >&2
  fi

  # Set environment variables
  echo "-----> Setting environment variables"
  "$DOKKU_BIN" config:set --no-restart "$APP_NAME" \
    TZ="${TZ:-UTC}" < /dev/null

  # Set domain
  echo "-----> Setting domain $DOMAIN"
  "$DOKKU_BIN" domains:set "$APP_NAME" "$DOMAIN" < /dev/null

  # Generate self-signed TLS certificate if none exists.
  # Authelia v4.39+ requires HTTPS for authelia_url/session cookies, so the
  # Dokku app must serve HTTPS. Without a cert, session cookies (Secure flag)
  # won't work and browser logins fail silently.
  if ! "$DOKKU_BIN" certs:report "$APP_NAME" < /dev/null 2>/dev/null | grep -q "has info.*true"; then
    echo "-----> Generating self-signed TLS certificate for $DOMAIN"
    local CERT_DIR
    CERT_DIR=$(mktemp -d)
    openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
      -keyout "$CERT_DIR/server.key" -out "$CERT_DIR/server.crt" \
      -subj "/CN=$DOMAIN" \
      -addext "subjectAltName=DNS:$DOMAIN" 2>/dev/null
    # Dokku certs:add reads a tar stream of server.crt + server.key from stdin
    tar cf - -C "$CERT_DIR" server.crt server.key | "$DOKKU_BIN" certs:add "$APP_NAME" 2>/dev/null || true
    rm -rf "$CERT_DIR"
  fi

  # Set port mapping: HTTPS for browser access, HTTP for internal auth_request
  echo "-----> Setting port mapping"
  "$DOKKU_BIN" ports:set "$APP_NAME" https:443:9091 http:80:9091 < /dev/null

  # Attach to SSO network at container creation time so Authelia can resolve
  # directory service hostnames (e.g., LLDAP) during startup config validation.
  # Must use attach-post-create (not attach-post-deploy) because Authelia validates
  # LDAP connectivity at startup, before healthchecks pass.
  echo "-----> Attaching to network $SSO_NETWORK"
  "$DOKKU_BIN" network:set "$APP_NAME" attach-post-create "$SSO_NETWORK" < /dev/null

  # Deploy from image or restart container if already deployed
  echo "-----> Deploying $PROVIDER_IMAGE:$PROVIDER_IMAGE_VERSION"
  if "$DOKKU_BIN" ps:report "$APP_NAME" --deployed < /dev/null 2>/dev/null | grep -q "true"; then
    # Config is bind-mounted — just restart the Docker container directly.
    # Dokku's ps:restart/ps:rebuild do a full redeploy with healthchecks which
    # can fail during the transition. A direct docker restart is sufficient
    # since only the config file changed, not the image.
    echo "       App already deployed, restarting container..."
    local CONTAINER_ID
    CONTAINER_ID=$(docker ps -q -f "label=com.dokku.app-name=$APP_NAME" 2>/dev/null | head -1 || true)
    if [[ -n "$CONTAINER_ID" ]]; then
      docker restart "$CONTAINER_ID" 2>/dev/null || true
    else
      # Fallback: try ps:restart if we can't find the container
      "$DOKKU_BIN" ps:restart "$APP_NAME" < /dev/null || true
    fi
  else
    if ! "$DOKKU_BIN" git:from-image "$APP_NAME" "$PROVIDER_IMAGE:$PROVIDER_IMAGE_VERSION" < /dev/null; then
      echo "!     Deployment failed — capturing container logs:" >&2
      "$DOKKU_BIN" logs "$APP_NAME" --num 20 < /dev/null 2>&1 >&2 || true
      echo "!     Storage mounts:" >&2
      "$DOKKU_BIN" storage:report "$APP_NAME" < /dev/null 2>&1 >&2 || true
      echo "!     Port config:" >&2
      "$DOKKU_BIN" ports:report "$APP_NAME" < /dev/null 2>&1 >&2 || true
      return 1
    fi
  fi

  # Wait for app to be running.
  # Note: Cannot use provider_is_running here because load_directory_provider
  # above may have overridden it with the LLDAP version. Check Dokku directly.
  echo "-----> Waiting for Authelia to be ready"
  local retries=30
  while [[ $retries -gt 0 ]]; do
    local RUNNING
    RUNNING=$("$DOKKU_BIN" ps:report "$APP_NAME" --running < /dev/null 2>/dev/null || echo "false")
    if [[ "$RUNNING" == "true" ]]; then
      break
    fi
    sleep 2
    retries=$((retries - 1))
  done

  if [[ $retries -eq 0 ]]; then
    echo "!     Authelia failed to start" >&2
    "$DOKKU_BIN" logs "$APP_NAME" --num 20 < /dev/null 2>&1 >&2 || true
    return 1
  fi
}

# Adopt an existing Dokku app as the Authelia frontend
# Arguments: SERVICE - name of the service, APP_NAME - name of the existing Dokku app
provider_adopt_app() {
  local SERVICE="$1"
  local APP_NAME="$2"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/frontend/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"

  # Validate the Dokku app exists
  if ! "$DOKKU_BIN" apps:exists "$APP_NAME" < /dev/null 2>/dev/null; then
    echo "!     Dokku app $APP_NAME does not exist" >&2
    return 1
  fi

  # Store app name
  echo "$APP_NAME" > "$SERVICE_ROOT/APP_NAME"

  # Read domain from the Dokku app
  local DOMAIN
  DOMAIN=$("$DOKKU_BIN" domains:report "$APP_NAME" --domains-app-vhosts < /dev/null 2>/dev/null || true)
  if [[ -n "$DOMAIN" ]]; then
    mkdir -p "$CONFIG_DIR"
    echo "$DOMAIN" > "$CONFIG_DIR/DOMAIN"
    echo "       Domain: $DOMAIN"
  fi

  # Check if it's running
  if provider_is_running "$SERVICE"; then
    echo "       Status: running"
  else
    echo "!     Warning: app $APP_NAME is not currently running" >&2
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
    COOKIE_DOMAIN="${DOMAIN#*.}"
  else
    COOKIE_DOMAIN="$DOMAIN"
  fi

  # Determine URL scheme - use http for localhost (testing), https otherwise
  # Note: .local domains still use https here because Authelia v4.39+ requires
  # secure schemes for authelia_url and default_redirection_url in config
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

  # Remove existing file to avoid permission issues on re-generation
  rm -f "$CONFIG_DIR/configuration.yml"

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

  # Authelia container runs as non-root (UID 8000 since v4.38+).
  # Config must be world-readable for the container user to access the bind mount.
  chmod 644 "$CONFIG_DIR/configuration.yml"
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
  local APP_NAME
  APP_NAME=$(get_frontend_app_name "$SERVICE")

  if [[ -z "$APP_NAME" ]]; then
    echo "!     No app configured for service $SERVICE" >&2
    return 1
  fi

  # Check directly via Dokku (provider_is_running may be overridden by directory provider)
  local retries=15
  while [[ $retries -gt 0 ]]; do
    local RUNNING
    RUNNING=$("$DOKKU_BIN" ps:report "$APP_NAME" --running < /dev/null 2>/dev/null || echo "false")
    if [[ "$RUNNING" == "true" ]]; then
      echo "       App $APP_NAME is running"
      return 0
    fi
    sleep 2
    retries=$((retries - 1))
  done

  echo "!     App $APP_NAME is not running or not healthy" >&2
  return 1
}

# Display provider configuration
provider_info() {
  local SERVICE="$1"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/frontend/$SERVICE"
  local CONFIG_DIR="$SERVICE_ROOT/config"
  local APP_NAME
  APP_NAME=$(get_frontend_app_name "$SERVICE")

  local DOMAIN DIRECTORY OIDC_ENABLED
  DOMAIN=$(cat "$CONFIG_DIR/DOMAIN" 2>/dev/null || echo "(not set)")
  DIRECTORY=$(cat "$SERVICE_ROOT/DIRECTORY" 2>/dev/null || echo "(none)")
  OIDC_ENABLED=$(cat "$CONFIG_DIR/OIDC_ENABLED" 2>/dev/null || echo "false")

  echo "       Provider: $PROVIDER_DISPLAY_NAME"
  echo "       Image: $PROVIDER_IMAGE:$PROVIDER_IMAGE_VERSION"
  echo "       Dokku App: ${APP_NAME:-(not set)}"
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

  local DOMAIN
  DOMAIN=$(cat "$CONFIG_DIR/DOMAIN")

  # Always use HTTPS for Authelia URLs. The Authelia Dokku app is configured
  # with a self-signed TLS cert (generated during create), and Authelia v4.39+
  # requires HTTPS for session cookies (Secure flag). Using HTTP would cause
  # silent login failures because cookies can't be set over HTTP.
  local URL_SCHEME="https"

  # Get the Authelia app name for internal auth_request subrequest
  # Use internal Dokku-proxied URL to avoid SSL issues with auth_request
  local APP_NAME
  APP_NAME=$(get_frontend_app_name "$SERVICE")

  # Set AUTHELIA_DOMAIN env var on the protected app
  "$DOKKU_BIN" config:set --no-restart "$APP" \
    AUTHELIA_DOMAIN="$DOMAIN" \
    < /dev/null

  # Add to protected apps list
  echo "$APP" >> "$SERVICE_ROOT/PROTECTED"
  sort -u "$SERVICE_ROOT/PROTECTED" -o "$SERVICE_ROOT/PROTECTED"

  # Write nginx forward auth config
  # The nginx-pre-reload trigger injects auth_request/error_page into location /
  # This file provides: supporting locations + directives for the trigger to extract
  local DOKKU_ROOT="${DOKKU_ROOT:-/home/dokku}"
  local NGINX_CONF_DIR="$DOKKU_ROOT/$APP/nginx.conf.d"
  mkdir -p "$NGINX_CONF_DIR"
  cat > "$NGINX_CONF_DIR/forward-auth.conf" <<EOF
# Authelia forward auth - managed by dokku-sso plugin
# Server-level locations
location /authelia-auth {
    internal;
    proxy_pass ${URL_SCHEME}://$DOMAIN/api/authz/auth-request;
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
    return 302 ${URL_SCHEME}://$DOMAIN/?rd=\$scheme://\$http_host\$request_uri;
}

# Directives below are injected into location / by the nginx-pre-reload trigger
auth_request /authelia-auth;
auth_request_set \$authelia_user \$upstream_http_remote_user;
auth_request_set \$authelia_groups \$upstream_http_remote_groups;
auth_request_set \$authelia_name \$upstream_http_remote_name;
auth_request_set \$authelia_email \$upstream_http_remote_email;
error_page 401 = @forward_auth_login;
EOF

  # Rebuild nginx config (triggers nginx-pre-reload hook)
  "$DOKKU_BIN" proxy:build-config "$APP" < /dev/null 2>/dev/null || true
}

# Remove protection from an app
provider_unprotect_app() {
  local SERVICE="$1"
  local APP="$2"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/frontend/$SERVICE"

  # Remove Authelia config
  "$DOKKU_BIN" config:unset --no-restart "$APP" AUTHELIA_DOMAIN < /dev/null 2>/dev/null || true

  # Remove from protected apps list
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

# Destroy the Dokku app
provider_destroy() {
  local SERVICE="$1"
  local APP_NAME
  APP_NAME=$(get_frontend_app_name "$SERVICE")

  if [[ -n "$APP_NAME" ]] && "$DOKKU_BIN" apps:exists "$APP_NAME" < /dev/null 2>/dev/null; then
    echo "       Destroying Dokku app $APP_NAME"
    "$DOKKU_BIN" apps:destroy "$APP_NAME" --force < /dev/null
  fi
}

# Get app logs
provider_logs() {
  local SERVICE="$1"
  shift
  local APP_NAME
  APP_NAME=$(get_frontend_app_name "$SERVICE")

  if [[ -z "$APP_NAME" ]]; then
    echo "!     No app configured for service $SERVICE" >&2
    return 1
  fi

  "$DOKKU_BIN" logs "$APP_NAME" "$@" < /dev/null
}

# Check if the Dokku app is running
provider_is_running() {
  local SERVICE="$1"
  local APP_NAME
  APP_NAME=$(get_frontend_app_name "$SERVICE")

  if [[ -z "$APP_NAME" ]]; then
    return 1
  fi

  local RUNNING
  RUNNING=$("$DOKKU_BIN" ps:report "$APP_NAME" --running < /dev/null 2>/dev/null || echo "false")
  [[ "$RUNNING" == "true" ]]
}
