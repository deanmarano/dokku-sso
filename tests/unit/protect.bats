#!/usr/bin/env bats

load '../test_helper'

setup() {
  setup_test_dirs
}

teardown() {
  teardown_test_dirs
}

@test "protect: protected app directory structure is correct" {
  create_mock_service "test-service"

  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/test-service"
  local PROTECT_DIR="$SERVICE_ROOT/protected-apps/myapp"

  mkdir -p "$PROTECT_DIR"
  echo "one_factor" > "$PROTECT_DIR/POLICY"

  [[ -d "$PROTECT_DIR" ]]
  [[ -f "$PROTECT_DIR/POLICY" ]]
  [[ "$(cat "$PROTECT_DIR/POLICY")" == "one_factor" ]]

  destroy_mock_service "test-service"
}

@test "protect: two_factor policy is stored correctly" {
  create_mock_service "test-service"

  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/test-service"
  local PROTECT_DIR="$SERVICE_ROOT/protected-apps/secure-app"

  mkdir -p "$PROTECT_DIR"
  echo "two_factor" > "$PROTECT_DIR/POLICY"

  [[ "$(cat "$PROTECT_DIR/POLICY")" == "two_factor" ]]

  destroy_mock_service "test-service"
}

@test "protect: required group is stored correctly" {
  create_mock_service "test-service"

  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/test-service"
  local PROTECT_DIR="$SERVICE_ROOT/protected-apps/admin-app"

  mkdir -p "$PROTECT_DIR"
  echo "one_factor" > "$PROTECT_DIR/POLICY"
  echo "admin" > "$PROTECT_DIR/REQUIRE_GROUP"

  [[ -f "$PROTECT_DIR/REQUIRE_GROUP" ]]
  [[ "$(cat "$PROTECT_DIR/REQUIRE_GROUP")" == "admin" ]]

  destroy_mock_service "test-service"
}

@test "protect: bypass paths are stored correctly" {
  create_mock_service "test-service"

  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/test-service"
  local PROTECT_DIR="$SERVICE_ROOT/protected-apps/api-app"

  mkdir -p "$PROTECT_DIR"
  echo "one_factor" > "$PROTECT_DIR/POLICY"
  printf '%s\n' "/api/health" "/api/metrics" > "$PROTECT_DIR/BYPASS_PATHS"

  [[ -f "$PROTECT_DIR/BYPASS_PATHS" ]]
  grep -q "/api/health" "$PROTECT_DIR/BYPASS_PATHS"
  grep -q "/api/metrics" "$PROTECT_DIR/BYPASS_PATHS"

  destroy_mock_service "test-service"
}

@test "protect: multiple apps can be protected" {
  create_mock_service "test-service"

  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/test-service"

  mkdir -p "$SERVICE_ROOT/protected-apps/app1"
  mkdir -p "$SERVICE_ROOT/protected-apps/app2"
  mkdir -p "$SERVICE_ROOT/protected-apps/app3"

  echo "one_factor" > "$SERVICE_ROOT/protected-apps/app1/POLICY"
  echo "two_factor" > "$SERVICE_ROOT/protected-apps/app2/POLICY"
  echo "one_factor" > "$SERVICE_ROOT/protected-apps/app3/POLICY"

  local PROTECTED_COUNT
  PROTECTED_COUNT=$(find "$SERVICE_ROOT/protected-apps" -mindepth 1 -maxdepth 1 -type d | wc -l)

  [[ "$PROTECTED_COUNT" -eq 3 ]]

  destroy_mock_service "test-service"
}

@test "unprotect: removing protection deletes directory" {
  create_mock_service "test-service"

  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/test-service"
  local PROTECT_DIR="$SERVICE_ROOT/protected-apps/myapp"

  mkdir -p "$PROTECT_DIR"
  echo "one_factor" > "$PROTECT_DIR/POLICY"

  [[ -d "$PROTECT_DIR" ]]

  rm -rf "$PROTECT_DIR"

  [[ ! -d "$PROTECT_DIR" ]]

  destroy_mock_service "test-service"
}
