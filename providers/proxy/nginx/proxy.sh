#!/usr/bin/env bash
# nginx proxy adapter
#
# Protection under nginx is a pair of files in the app's nginx.conf.d: server
# level locations that talk to Authelia, and a .directives file that the
# nginx-pre-reload trigger injects into each `location /`. Both are rebuilt
# from scratch on every protect, so this is idempotent.
#
# The generated output is snapshotted byte-for-byte in
# tests/unit/proxy-nginx-golden.test.ts.

# shellcheck disable=SC2034  # adapter metadata, read after sourcing
PROXY_NAME="nginx"
PROXY_SUPPORTS_BYPASS="true"

# proxy_protect_app APP DESCRIPTOR_FILE BYPASS_FILE
proxy_protect_app() {
  local app="$1" descriptor_file="$2" bypass_file="$3"

  local auth_domain auth_scheme auth_request_path
  auth_domain="$(fn-descriptor-get "$descriptor_file" auth_domain)"
  auth_scheme="$(fn-descriptor-get "$descriptor_file" auth_scheme)"
  auth_request_path="$(fn-descriptor-get "$descriptor_file" auth_request_path)"

  # Write nginx forward auth config
  # The nginx-pre-reload trigger injects auth_request/error_page into location /
  # This file provides: supporting locations + directives for the trigger to extract
  local DOKKU_ROOT="${DOKKU_ROOT:-/home/dokku}"
  local NGINX_CONF_DIR="$DOKKU_ROOT/$app/nginx.conf.d"
  mkdir -p "$NGINX_CONF_DIR"
  # Server-level locations (included by nginx via *.conf glob)
  cat > "$NGINX_CONF_DIR/forward-auth.conf" <<EOF
# Authelia forward auth - managed by dokku-sso plugin
location /authelia-auth {
    internal;
    # Reach Authelia over the local nginx loopback rather than the public
    # \$DOMAIN. This subrequest is issued by nginx on the Dokku host itself; when
    # \$DOMAIN resolves to a public IP the host frequently cannot route back to
    # itself (no NAT hairpin/loopback behind CGNAT or consumer routers such as
    # eero), so proxying to the public name hangs and every protected request
    # times out at the auth check. Connecting to 127.0.0.1 while presenting
    # \$DOMAIN for TLS SNI and the Host header keeps the request on-box and still
    # selects the Authelia vhost with a matching certificate and host — identical
    # to what proxying to \$DOMAIN did back when it resolved to a local address.
    proxy_pass $auth_scheme://127.0.0.1$auth_request_path;
    proxy_ssl_server_name on;
    proxy_ssl_name $auth_domain;
    proxy_set_header Host $auth_domain;
    proxy_pass_request_body off;
    proxy_ssl_verify off;
    proxy_set_header Content-Length "";
    proxy_set_header X-Original-Method \$request_method;
    proxy_set_header X-Original-URL https://\$http_host\$request_uri;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header X-Forwarded-Host \$http_host;
    proxy_set_header X-Forwarded-Uri \$request_uri;
}

location @forward_auth_login {
    auth_request off;
    # Both URLs stay https. Authelia refuses an insecure rd target and falls
    # back to its default_redirection_url instead, so an app protected this
    # way has to be served over TLS -- there is no http variant that works.
    return 302 $auth_scheme://$auth_domain/?rd=https://\$http_host\$request_uri;
}

# Bypass auth for ACME challenges (letsencrypt)
location /.well-known/acme-challenge/ {
    allow all;
    auth_request off;
    auth_basic off;
    root /var/lib/dokku/data/letsencrypt/${APP};
}
EOF

  # Paths registered with `dokku sso:bypass` skip the auth subrequest. These are
  # for machine callers that cannot complete an interactive Authelia flow —
  # mobile apps, webhooks, OAuth callbacks — and that carry their own bearer
  # tokens. Each bypass has to re-declare the proxy: nginx dispatches on the
  # most specific prefix, so these locations replace `location /` for their
  # paths and would otherwise match no handler and 404.
  local BYPASS_FILE="$bypass_file"
  if [[ -s "$BYPASS_FILE" ]]; then
    local UPSTREAM_PORT UPSTREAM
    UPSTREAM_PORT=$("$DOKKU_BIN" ports:report "$app" --ports-map < /dev/null 2>/dev/null | tr ' ' '\n' | head -1 | cut -d: -f3)
    if [[ -z "$UPSTREAM_PORT" ]]; then
      echo "!     Could not determine upstream port for $APP; skipping bypass paths" >&2
    else
      UPSTREAM="${app}-${UPSTREAM_PORT}"
      while IFS= read -r BYPASS_PATH; do
        [[ -n "$BYPASS_PATH" ]] || continue
        cat >> "$NGINX_CONF_DIR/forward-auth.conf" <<EOF

# Bypass auth for $BYPASS_PATH (dokku sso:bypass)
location $BYPASS_PATH {
    auth_request off;
    proxy_pass http://${UPSTREAM};
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$http_connection;
    proxy_set_header Host \$http_host;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header X-Forwarded-Port \$server_port;
    proxy_set_header X-Forwarded-Proto \$scheme;
    # Long-lived websockets (e.g. a mobile app's push connection) must outlive
    # the 60s read timeout Dokku applies to ordinary requests.
    proxy_read_timeout 3600s;
}
EOF
      done < "$BYPASS_FILE"
    fi
  fi

  # Directives injected into location / by the nginx-pre-reload trigger.
  # Stored in a .directives file so nginx doesn't include them at server level.
  cat > "$NGINX_CONF_DIR/forward-auth.directives" <<EOF
auth_request /authelia-auth;
auth_request_set \$authelia_user \$upstream_http_remote_user;
auth_request_set \$authelia_groups \$upstream_http_remote_groups;
auth_request_set \$authelia_name \$upstream_http_remote_name;
auth_request_set \$authelia_email \$upstream_http_remote_email;
proxy_set_header Remote-User \$authelia_user;
proxy_set_header Remote-Groups \$authelia_groups;
proxy_set_header Remote-Name \$authelia_name;
proxy_set_header Remote-Email \$authelia_email;
error_page 401 = @forward_auth_login;
EOF


  # Rebuild nginx config (triggers nginx-pre-reload hook)
  "$DOKKU_BIN" proxy:build-config "$app" < /dev/null 2>/dev/null || true
}

# proxy_unprotect_app APP
proxy_unprotect_app() {
  local app="$1"
  local DOKKU_ROOT="${DOKKU_ROOT:-/home/dokku}"

  rm -f "$DOKKU_ROOT/$app/nginx.conf.d/forward-auth.conf"
  rm -f "$DOKKU_ROOT/$app/nginx.conf.d/forward-auth.directives"

  "$DOKKU_BIN" proxy:build-config "$app" < /dev/null 2>/dev/null || true
}

# proxy_doctor_app APP DESCRIPTOR_FILE
proxy_doctor_app() {
  local app="$1"
  local DOKKU_ROOT="${DOKKU_ROOT:-/home/dokku}"
  local conf_dir="$DOKKU_ROOT/$app/nginx.conf.d"

  if [[ ! -f "$conf_dir/forward-auth.conf" ]]; then
    echo "forward-auth.conf missing; re-run sso:protect"
    return 1
  fi
  if [[ ! -f "$conf_dir/forward-auth.directives" ]]; then
    echo "forward-auth.directives missing; the nginx-pre-reload hook will regenerate it on the next build"
    return 1
  fi
  if ! grep -q 'auth_request /authelia-auth' "$DOKKU_ROOT/$app/nginx.conf" 2>/dev/null; then
    echo "nginx.conf has no auth_request directive; run dokku proxy:build-config $app"
    return 1
  fi
  return 0
}
