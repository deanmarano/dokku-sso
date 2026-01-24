#!/usr/bin/env bats

load '../test_helper'

setup() {
  setup_test_dirs
}

teardown() {
  teardown_test_dirs
}

@test "service: directory structure is created correctly" {
  local SERVICE="test-service"
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/$SERVICE"

  mkdir -p "$SERVICE_ROOT"/{provider-config,oidc-clients,gateway-config}

  [[ -d "$SERVICE_ROOT" ]]
  [[ -d "$SERVICE_ROOT/provider-config" ]]
  [[ -d "$SERVICE_ROOT/oidc-clients" ]]
  [[ -d "$SERVICE_ROOT/gateway-config" ]]
}

@test "service: provider is stored correctly" {
  create_mock_service "test-service"

  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/test-service"

  [[ -f "$SERVICE_ROOT/PROVIDER" ]]
  [[ "$(cat "$SERVICE_ROOT/PROVIDER")" == "lldap" ]]

  destroy_mock_service "test-service"
}

@test "service: LDAP config files are created" {
  create_mock_service "test-service"

  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/test-service"

  [[ -f "$SERVICE_ROOT/provider-config/BASE_DN" ]]
  [[ -f "$SERVICE_ROOT/provider-config/ADMIN_PASSWORD" ]]
  [[ -f "$SERVICE_ROOT/provider-config/JWT_SECRET" ]]

  destroy_mock_service "test-service"
}

@test "service: gateway config files are created" {
  create_mock_service "test-service"

  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/test-service"

  [[ -f "$SERVICE_ROOT/gateway-config/DOMAIN" ]]
  [[ "$(cat "$SERVICE_ROOT/gateway-config/DOMAIN")" == "auth.test.local" ]]

  destroy_mock_service "test-service"
}

@test "service: links file can store multiple apps" {
  create_mock_service "test-service"

  add_app_link "test-service" "app1"
  add_app_link "test-service" "app2"
  add_app_link "test-service" "app3"

  run get_linked_apps "test-service"
  assert_success

  [[ "$output" == *"app1"* ]]
  [[ "$output" == *"app2"* ]]
  [[ "$output" == *"app3"* ]]

  destroy_mock_service "test-service"
}

@test "service: verify_service_exists fails for missing service" {
  run verify_service_exists "nonexistent"
  assert_failure
}

@test "service: verify_service_exists passes for existing service" {
  create_mock_service "test-service"

  run verify_service_exists "test-service"
  assert_success

  destroy_mock_service "test-service"
}

@test "service: verify_service_not_exists passes for missing service" {
  run verify_service_not_exists "nonexistent"
  assert_success
}

@test "service: verify_service_not_exists fails for existing service" {
  create_mock_service "test-service"

  run verify_service_not_exists "test-service"
  assert_failure

  destroy_mock_service "test-service"
}

@test "service: data directory path is correct" {
  run get_service_data_dir "myservice"
  assert_success
  assert_output "$AUTH_DATA_ROOT/auth-myservice"
}

@test "service: container names follow naming convention" {
  run get_lldap_container "myservice"
  assert_success
  assert_output "auth-myservice-lldap"

  run get_authelia_container "myservice"
  assert_success
  assert_output "auth-myservice-authelia"
}

@test "service: network name follows naming convention" {
  run get_service_network "myservice"
  assert_success
  assert_output "auth-myservice"
}
