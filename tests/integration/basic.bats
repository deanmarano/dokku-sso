#!/usr/bin/env bats

# Integration tests - do NOT load test_helper as it sets PLUGIN_BASE_PATH
# which conflicts with the actual installed plugin paths

# Load only BATS assertions
HELPER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
load "${HELPER_DIR}/test_helper/bats-support/load"
load "${HELPER_DIR}/test_helper/bats-assert/load"

# Integration tests require Dokku to be installed
# These tests run against a real Dokku installation

setup() {
  # Skip if dokku is not available
  if ! command -v dokku &>/dev/null; then
    skip "Dokku is not installed"
  fi
  # Clear any test environment variables that might interfere
  unset PLUGIN_BASE_PATH
  unset PLUGIN_DATA_ROOT
}

@test "integration: plugin is installed" {
  run dokku plugin:list
  assert_success
  assert_output --partial "auth"
}

@test "integration: help command works" {
  run dokku auth:help
  assert_success
  assert_output --partial "auth:create"
  assert_output --partial "auth:destroy"
}

@test "integration: list shows no services initially" {
  run dokku auth:list
  assert_success
  # Output should be empty or show "no services"
}

# Note: The following tests create real Docker containers
# They should only be run in CI or dedicated test environments

@test "integration: create and destroy service" {
  skip "Requires Docker - run manually or in CI"

  local SERVICE="test-$$"

  # Create service
  run dokku auth:create "$SERVICE"
  assert_success

  # Verify service exists
  run dokku auth:list
  assert_success
  assert_output --partial "$SERVICE"

  # Destroy service
  run dokku auth:destroy "$SERVICE" --force
  assert_success

  # Verify service is gone
  run dokku auth:list
  refute_output --partial "$SERVICE"
}
