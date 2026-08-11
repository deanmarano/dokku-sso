#!/usr/bin/env bash
# Traefik proxy adapter
#
# Protection under Traefik is a forwardAuth middleware, defined by labels on the
# auth app and attached by labels on the protected app. Dokku exposes this as a
# supported seam: `dokku traefik:labels:add`, stored under
# /var/lib/dokku/config/traefik/<app>/labels and appended to the container's
# labels at deploy time.
#
# Two consequences of that, both handled below:
#
#   - Labels are read when a container is created, so protection does not take
#     effect until the app is rebuilt.
#   - Traefik has to reach the auth app to run the subrequest. It cannot go via
#     the public URL: that is the NAT hairpin the nginx adapter documents at
#     length and works around with a loopback. Traefik joins the SSO network
#     instead and addresses the auth app by its container alias.

# shellcheck disable=SC2034  # adapter metadata, read after sourcing
PROXY_NAME="traefik"
PROXY_SUPPORTS_BYPASS="true"

# Dokku only builds Traefik routers for the web process type
# (traefik-vhosts/docker-args-process-deploy), so these are the complete set.
fn-traefik-routers() {
  local app="$1"
  echo "${app}-web-https"
  echo "${app}-web-http"
}

fn-traefik-middleware-name() {
  local service="$1"
  echo "sso-${service}"
}

# The running Traefik container, found by the label its compose project sets.
fn-traefik-container() {
  docker ps --filter "label=com.docker.compose.service=traefik" --format '{{.Names}}' 2>/dev/null | head -1
}

# Put Traefik on the SSO network so it can resolve the auth app by alias.
# Idempotent, and re-run on every protect because traefik:stop/start recreates
# the container and drops the attachment.
fn-traefik-attach-network() {
  local container
  container="$(fn-traefik-container)"

  if [[ -z "$container" ]]; then
    echo "!     No running Traefik container found; cannot verify it can reach the auth service" >&2
    return 1
  fi

  if docker network inspect "$SSO_NETWORK" --format '{{range .Containers}}{{.Name}} {{end}}' 2>/dev/null | grep -qw "$container"; then
    return 0
  fi

  echo "-----> Attaching Traefik to $SSO_NETWORK"
  docker network connect "$SSO_NETWORK" "$container" 2>/dev/null || {
    echo "!     Could not attach Traefik to $SSO_NETWORK" >&2
    return 1
  }
}

# proxy_protect_app APP DESCRIPTOR_FILE BYPASS_FILE
proxy_protect_app() {
  local app="$1" descriptor_file="$2" bypass_file="$3"

  local service auth_app internal_host internal_port forward_auth_path response_headers
  service="$(fn-descriptor-get "$descriptor_file" service)"
  auth_app="$(fn-descriptor-get "$descriptor_file" auth_app)"
  internal_host="$(fn-descriptor-get "$descriptor_file" internal_host)"
  internal_port="$(fn-descriptor-get "$descriptor_file" internal_port)"
  forward_auth_path="$(fn-descriptor-get "$descriptor_file" forward_auth_path)"
  response_headers="$(fn-descriptor-get "$descriptor_file" response_headers)"

  local middleware
  middleware="$(fn-traefik-middleware-name "$service")"

  fn-traefik-attach-network || true

  # Define the middleware once, on the auth app itself.
  local address="http://${internal_host}:${internal_port}${forward_auth_path}"
  "$DOKKU_BIN" traefik:labels:add "$auth_app" \
    "traefik.http.middlewares.${middleware}.forwardauth.address" "$address" < /dev/null
  "$DOKKU_BIN" traefik:labels:add "$auth_app" \
    "traefik.http.middlewares.${middleware}.forwardauth.trustForwardHeader" "true" < /dev/null
  "$DOKKU_BIN" traefik:labels:add "$auth_app" \
    "traefik.http.middlewares.${middleware}.forwardauth.maxResponseBodySize" "8192" < /dev/null
  "$DOKKU_BIN" traefik:labels:add "$auth_app" \
    "traefik.http.middlewares.${middleware}.forwardauth.authResponseHeaders" "$response_headers" < /dev/null

  # Attach it to every router the app has. Both, deliberately: Traefik only
  # redirects http to https when a letsencrypt email is configured, so an
  # https-only middleware would leave plain http unauthenticated.
  local router
  while read -r router; do
    [[ -n "$router" ]] || continue
    "$DOKKU_BIN" traefik:labels:add "$app" \
      "traefik.http.routers.${router}.middlewares" "${middleware}@docker" < /dev/null
  done < <(fn-traefik-routers "$app")

  fn-traefik-apply-bypass "$app" "$descriptor_file" "$bypass_file"

  # Labels are inert until the container is recreated. Rebuilding now is what
  # keeps "protected" from meaning "listed as protected but still open".
  if "$DOKKU_BIN" ps:report "$app" --deployed < /dev/null 2>/dev/null | grep -q "true"; then
    echo "-----> Rebuilding $app so Traefik picks up the auth middleware"
    "$DOKKU_BIN" ps:rebuild "$app" < /dev/null
  else
    echo "       $app is not deployed; the auth middleware applies on its first deploy"
  fi
}

# Bypassed paths become a higher-priority router with no middleware attached.
fn-traefik-apply-bypass() {
  local app="$1" descriptor_file="$2" bypass_file="$3"
  local router="${app}-sso-bypass"

  # Always clear first, so removing the last bypass path removes the router.
  "$DOKKU_BIN" traefik:labels:remove "$app" "traefik.http.routers.${router}.rule" < /dev/null 2>/dev/null || true
  "$DOKKU_BIN" traefik:labels:remove "$app" "traefik.http.routers.${router}.priority" < /dev/null 2>/dev/null || true
  "$DOKKU_BIN" traefik:labels:remove "$app" "traefik.http.routers.${router}.service" < /dev/null 2>/dev/null || true
  "$DOKKU_BIN" traefik:labels:remove "$app" "traefik.http.routers.${router}.entrypoints" < /dev/null 2>/dev/null || true
  "$DOKKU_BIN" traefik:labels:remove "$app" "traefik.http.routers.${router}.tls.certresolver" < /dev/null 2>/dev/null || true

  [[ -s "$bypass_file" ]] || return 0

  local domains domain_rule=""
  domains="$("$DOKKU_BIN" domains:report "$app" --domains-app-vhosts < /dev/null 2>/dev/null | xargs || true)"
  local d
  for d in $domains; do
    [[ -n "$domain_rule" ]] && domain_rule="$domain_rule || "
    domain_rule="${domain_rule}Host(\`${d}\`)"
  done
  if [[ -z "$domain_rule" ]]; then
    echo "!     $app has no domains; skipping bypass paths" >&2
    return 0
  fi

  local path_rule="" p
  while IFS= read -r p; do
    [[ -n "$p" ]] || continue
    [[ -n "$path_rule" ]] && path_rule="$path_rule || "
    path_rule="${path_rule}PathPrefix(\`${p}\`)"
  done <"$bypass_file"
  [[ -n "$path_rule" ]] || return 0

  "$DOKKU_BIN" traefik:labels:add "$app" \
    "traefik.http.routers.${router}.rule" "($domain_rule) && ($path_rule)" < /dev/null
  # Above the app's own routers, so these paths skip the middleware entirely.
  "$DOKKU_BIN" traefik:labels:add "$app" \
    "traefik.http.routers.${router}.priority" "100" < /dev/null
  "$DOKKU_BIN" traefik:labels:add "$app" \
    "traefik.http.routers.${router}.service" "${app}-web-https" < /dev/null
  "$DOKKU_BIN" traefik:labels:add "$app" \
    "traefik.http.routers.${router}.entrypoints" "https" < /dev/null
  "$DOKKU_BIN" traefik:labels:add "$app" \
    "traefik.http.routers.${router}.tls.certresolver" "leresolver" < /dev/null
}

# proxy_unprotect_app APP
proxy_unprotect_app() {
  local app="$1"
  local router

  while read -r router; do
    [[ -n "$router" ]] || continue
    "$DOKKU_BIN" traefik:labels:remove "$app" \
      "traefik.http.routers.${router}.middlewares" < /dev/null 2>/dev/null || true
  done < <(fn-traefik-routers "$app")

  local bypass_router="${app}-sso-bypass"
  local key
  for key in rule priority service entrypoints tls.certresolver; do
    "$DOKKU_BIN" traefik:labels:remove "$app" \
      "traefik.http.routers.${bypass_router}.${key}" < /dev/null 2>/dev/null || true
  done

  # The middleware definition lives on the auth app and is shared, so it stays.

  if "$DOKKU_BIN" ps:report "$app" --deployed < /dev/null 2>/dev/null | grep -q "true"; then
    echo "-----> Rebuilding $app so Traefik drops the auth middleware"
    "$DOKKU_BIN" ps:rebuild "$app" < /dev/null
  fi
}

# proxy_doctor_app APP DESCRIPTOR_FILE
proxy_doctor_app() {
  local app="$1" descriptor_file="$2"

  local service auth_app
  service="$(fn-descriptor-get "$descriptor_file" service)"
  auth_app="$(fn-descriptor-get "$descriptor_file" auth_app)"
  local middleware
  middleware="$(fn-traefik-middleware-name "$service")"

  local labels
  labels="$("$DOKKU_BIN" traefik:labels:show "$app" < /dev/null 2>/dev/null || true)"
  if ! grep -q "middlewares=${middleware}@docker" <<<"$labels"; then
    echo "no auth middleware attached to $app's routers; re-run sso:protect"
    return 1
  fi

  local auth_labels
  auth_labels="$("$DOKKU_BIN" traefik:labels:show "$auth_app" < /dev/null 2>/dev/null || true)"
  if ! grep -q "middlewares.${middleware}.forwardauth.address" <<<"$auth_labels"; then
    echo "the ${middleware} middleware is not defined on $auth_app; re-run sso:protect"
    return 1
  fi

  local container
  container="$(fn-traefik-container)"
  if [[ -z "$container" ]]; then
    echo "no running Traefik container found"
    return 1
  fi
  if ! docker network inspect "$SSO_NETWORK" --format '{{range .Containers}}{{.Name}} {{end}}' 2>/dev/null | grep -qw "$container"; then
    echo "Traefik is not attached to $SSO_NETWORK, so it cannot reach the auth service; re-run sso:protect"
    return 1
  fi

  return 0
}
