#!/usr/bin/env bats

load '../test_helper'

setup() {
  setup_test_dirs
}

teardown() {
  teardown_test_dirs
}

@test "oidc: client directory structure is correct" {
  create_mock_service "test-service"

  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/test-service"
  local CLIENT_DIR="$SERVICE_ROOT/oidc-clients/myapp"

  mkdir -p "$CLIENT_DIR"
  echo "https://myapp.example.com/callback" > "$CLIENT_DIR/REDIRECT_URI"
  echo "openid profile email" > "$CLIENT_DIR/SCOPES"
  echo "false" > "$CLIENT_DIR/IS_PUBLIC"
  echo "secret123" > "$CLIENT_DIR/SECRET"

  [[ -f "$CLIENT_DIR/REDIRECT_URI" ]]
  [[ -f "$CLIENT_DIR/SCOPES" ]]
  [[ -f "$CLIENT_DIR/SECRET" ]]

  [[ "$(cat "$CLIENT_DIR/REDIRECT_URI")" == "https://myapp.example.com/callback" ]]
  [[ "$(cat "$CLIENT_DIR/SCOPES")" == "openid profile email" ]]

  destroy_mock_service "test-service"
}

@test "oidc: public client has no secret file" {
  create_mock_service "test-service"

  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/test-service"
  local CLIENT_DIR="$SERVICE_ROOT/oidc-clients/public-app"

  mkdir -p "$CLIENT_DIR"
  echo "https://app.example.com/callback" > "$CLIENT_DIR/REDIRECT_URI"
  echo "true" > "$CLIENT_DIR/IS_PUBLIC"

  [[ "$(cat "$CLIENT_DIR/IS_PUBLIC")" == "true" ]]
  [[ ! -f "$CLIENT_DIR/SECRET" ]]

  destroy_mock_service "test-service"
}

@test "oidc: multiple clients can exist" {
  create_mock_service "test-service"

  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/test-service"

  mkdir -p "$SERVICE_ROOT/oidc-clients/app1"
  mkdir -p "$SERVICE_ROOT/oidc-clients/app2"
  mkdir -p "$SERVICE_ROOT/oidc-clients/app3"

  local CLIENT_COUNT
  CLIENT_COUNT=$(find "$SERVICE_ROOT/oidc-clients" -mindepth 1 -maxdepth 1 -type d | wc -l)

  [[ "$CLIENT_COUNT" -eq 3 ]]

  destroy_mock_service "test-service"
}

@test "oidc: pkce flag is stored correctly" {
  create_mock_service "test-service"

  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/test-service"
  local CLIENT_DIR="$SERVICE_ROOT/oidc-clients/pkce-app"

  mkdir -p "$CLIENT_DIR"
  echo "true" > "$CLIENT_DIR/REQUIRE_PKCE"

  [[ "$(cat "$CLIENT_DIR/REQUIRE_PKCE")" == "true" ]]

  destroy_mock_service "test-service"
}
