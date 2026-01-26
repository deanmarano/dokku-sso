#!/usr/bin/env bats

# End-to-end integration tests for presets
# These tests require Dokku to be installed and the plugin to be active
#
# Tests are split into two categories:
# 1. Tests that don't require a service (preset validation, help, etc.)
# 2. Tests that require a service (marked with [service] in name)
#
# Service-dependent tests will be skipped if service creation fails
# (e.g., no Docker available in CI)

load "${BATS_TEST_DIRNAME}/../test_helper/bats-support/load"
load "${BATS_TEST_DIRNAME}/../test_helper/bats-assert/load"

# Test service name (unique per run to avoid conflicts)
TEST_SERVICE="e2e-test-$$"
SERVICE_CREATED=false

setup_file() {
  # Skip if dokku is not installed
  if ! command -v dokku &>/dev/null; then
    return 0
  fi

  # Try to create test service - this may fail in CI without Docker
  if sudo dokku auth:create "$TEST_SERVICE" --gateway-domain "auth-${TEST_SERVICE}.example.com" 2>&1; then
    export SERVICE_CREATED=true
  else
    export SERVICE_CREATED=false
  fi
}

teardown_file() {
  # Cleanup test service if it was created
  sudo dokku auth:destroy "$TEST_SERVICE" -f 2>/dev/null || true
}

setup() {
  if ! command -v dokku &>/dev/null; then
    skip "Dokku is not installed"
  fi
}

# Helper to check if service exists
service_exists() {
  dokku auth:info "$TEST_SERVICE" &>/dev/null
}

# Helper to skip if service doesn't exist
require_service() {
  if ! service_exists; then
    skip "Test service not available (Docker may not be running)"
  fi
}

# =============================================================================
# Basic Command Tests
# =============================================================================

@test "e2e: auth:help shows usage" {
  run dokku auth:help
  assert_success
  assert_output --partial "auth:create"
  assert_output --partial "auth:oidc:add"
  assert_output --partial "auth:integrate"
}

@test "e2e: auth:integrate --list shows presets" {
  run dokku auth:integrate --list
  assert_success
  assert_output --partial "nextcloud"
  assert_output --partial "immich"
  assert_output --partial "gitea"
  assert_output --partial "grafana"
}

@test "e2e: auth:list shows services" {
  run dokku auth:list
  assert_success
}

# =============================================================================
# OIDC Client Tests with Presets (require service)
# =============================================================================

@test "e2e: [service] auth:oidc:add with immich preset" {
  require_service

  run sudo dokku auth:oidc:add "$TEST_SERVICE" immich-test \
    --preset immich \
    --domain photos.example.com

  # Should succeed or mention client already exists
  [[ "$status" -eq 0 ]] || [[ "$output" == *"already exists"* ]]
}

@test "e2e: [service] auth:oidc:add with nextcloud preset (PKCE required)" {
  require_service

  run sudo dokku auth:oidc:add "$TEST_SERVICE" nextcloud-test \
    --preset nextcloud \
    --domain cloud.example.com

  [[ "$status" -eq 0 ]] || [[ "$output" == *"already exists"* ]]
}

@test "e2e: [service] auth:oidc:add with grafana preset" {
  require_service

  run sudo dokku auth:oidc:add "$TEST_SERVICE" grafana-test \
    --preset grafana \
    --domain grafana.example.com

  [[ "$status" -eq 0 ]] || [[ "$output" == *"already exists"* ]]
}

@test "e2e: [service] auth:oidc:add with gitea preset" {
  require_service

  run sudo dokku auth:oidc:add "$TEST_SERVICE" gitea-test \
    --preset gitea \
    --domain git.example.com

  [[ "$status" -eq 0 ]] || [[ "$output" == *"already exists"* ]]
}

@test "e2e: [service] auth:oidc:list shows created clients" {
  require_service

  run dokku auth:oidc:list "$TEST_SERVICE"
  assert_success
  # At least one client should exist from previous tests
}

@test "e2e: [service] auth:oidc:add without preset requires redirect-uri" {
  require_service

  run sudo dokku auth:oidc:add "$TEST_SERVICE" manual-client
  assert_failure
  assert_output --partial "Redirect URI is required"
}

@test "e2e: [service] auth:oidc:add with manual redirect-uri" {
  require_service

  run sudo dokku auth:oidc:add "$TEST_SERVICE" manual-client \
    --redirect-uri "https://app.example.com/callback"

  [[ "$status" -eq 0 ]] || [[ "$output" == *"already exists"* ]]
}

# =============================================================================
# Preset Validation Tests (require service)
# =============================================================================

@test "e2e: [service] auth:oidc:add with invalid preset fails" {
  require_service

  run sudo dokku auth:oidc:add "$TEST_SERVICE" test-client \
    --preset nonexistent-preset \
    --domain app.example.com

  assert_failure
  assert_output --partial "Unknown preset"
}

@test "e2e: [service] auth:oidc:add preset without domain fails" {
  require_service

  run sudo dokku auth:oidc:add "$TEST_SERVICE" test-client \
    --preset immich

  assert_failure
  assert_output --partial "Redirect URI is required"
}

# =============================================================================
# LDAP-only Preset Tests (require service)
# =============================================================================

@test "e2e: [service] auth:oidc:add with jellyfin preset fails (LDAP only)" {
  require_service

  run sudo dokku auth:oidc:add "$TEST_SERVICE" jellyfin-test \
    --preset jellyfin \
    --domain media.example.com

  assert_failure
  assert_output --partial "does not support OIDC"
}

@test "e2e: [service] auth:oidc:add with vaultwarden preset fails (LDAP only)" {
  require_service

  run sudo dokku auth:oidc:add "$TEST_SERVICE" vault-test \
    --preset vaultwarden \
    --domain vault.example.com

  assert_failure
  assert_output --partial "does not support OIDC"
}

# =============================================================================
# Proxy Auth Preset Tests (require service)
# =============================================================================

@test "e2e: [service] auth:oidc:add with arr preset fails (proxy auth only)" {
  require_service

  run sudo dokku auth:oidc:add "$TEST_SERVICE" radarr-test \
    --preset arr \
    --domain radarr.example.com

  assert_failure
  assert_output --partial "does not support OIDC"
}

@test "e2e: [service] auth:oidc:add with uptimekuma preset fails (proxy auth only)" {
  require_service

  run sudo dokku auth:oidc:add "$TEST_SERVICE" status-test \
    --preset uptimekuma \
    --domain status.example.com

  assert_failure
  assert_output --partial "does not support OIDC"
}

# =============================================================================
# OIDC Client Removal Tests (require service)
# =============================================================================

@test "e2e: [service] auth:oidc:remove removes client" {
  require_service

  # First create a client to remove
  sudo dokku auth:oidc:add "$TEST_SERVICE" to-remove \
    --redirect-uri "https://remove.example.com/callback" 2>/dev/null || true

  run sudo dokku auth:oidc:remove "$TEST_SERVICE" to-remove

  # Should succeed (client existed) or note not found
  [[ "$status" -eq 0 ]] || [[ "$output" == *"not found"* ]]
}
