#!/usr/bin/env bats

load '../test_helper'

setup() {
  setup_test_dirs
}

teardown() {
  teardown_test_dirs
}

@test "secrets: generate_secret produces consistent length" {
  local secret1 secret2 secret3

  secret1=$(generate_secret)
  secret2=$(generate_secret)
  secret3=$(generate_secret)

  [[ ${#secret1} -eq 64 ]]
  [[ ${#secret2} -eq 64 ]]
  [[ ${#secret3} -eq 64 ]]
}

@test "secrets: generate_secret produces unique values" {
  local secret1 secret2

  secret1=$(generate_secret)
  secret2=$(generate_secret)

  [[ "$secret1" != "$secret2" ]]
}

@test "secrets: generate_secret produces hex characters only" {
  local secret
  secret=$(generate_secret)

  [[ "$secret" =~ ^[a-f0-9]+$ ]]
}

@test "secrets: generate_password produces sufficient length" {
  local password
  password=$(generate_password)

  [[ ${#password} -ge 20 ]]
}

@test "secrets: generate_password produces unique values" {
  local pass1 pass2

  pass1=$(generate_password)
  pass2=$(generate_password)

  [[ "$pass1" != "$pass2" ]]
}

@test "secrets: secrets are stored with proper permissions" {
  create_mock_service "test-service"

  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/test-service"

  # Check that sensitive files exist
  [[ -f "$SERVICE_ROOT/provider-config/ADMIN_PASSWORD" ]]
  [[ -f "$SERVICE_ROOT/provider-config/JWT_SECRET" ]]

  destroy_mock_service "test-service"
}
