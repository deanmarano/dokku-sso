#!/usr/bin/env bats

load '../test_helper'

setup() {
  setup_test_dirs
}

teardown() {
  teardown_test_dirs
}

@test "provider: lldap provider directory exists" {
  [[ -d "$PLUGIN_BASE_PATH/providers/lldap" ]]
}

@test "provider: lldap provider.sh exists and is executable" {
  [[ -f "$PLUGIN_BASE_PATH/providers/lldap/provider.sh" ]]
  [[ -x "$PLUGIN_BASE_PATH/providers/lldap/provider.sh" ]]
}

@test "provider: lldap config.sh exists and is executable" {
  [[ -f "$PLUGIN_BASE_PATH/providers/lldap/config.sh" ]]
  [[ -x "$PLUGIN_BASE_PATH/providers/lldap/config.sh" ]]
}

@test "provider: load_provider succeeds for existing service" {
  create_mock_service "test-service"

  run load_provider "test-service"
  assert_success

  destroy_mock_service "test-service"
}

@test "provider: load_provider sources provider functions" {
  create_mock_service "test-service"

  load_provider "test-service"
  # After loading, provider functions should be available
  declare -f provider_create_container >/dev/null

  destroy_mock_service "test-service"
}

@test "provider: provider config contains required functions" {
  source "$PLUGIN_BASE_PATH/providers/lldap/config.sh"

  # Check that config variables are set
  [[ -n "$PROVIDER_NAME" ]]
  [[ "$PROVIDER_NAME" == "lldap" ]]
}

@test "provider: provider.sh contains required functions" {
  create_mock_service "test-service"
  load_provider "test-service"

  # Check that required functions exist
  declare -f provider_create_container >/dev/null
  declare -f provider_destroy_container >/dev/null
  declare -f provider_container_status >/dev/null

  destroy_mock_service "test-service"
}
