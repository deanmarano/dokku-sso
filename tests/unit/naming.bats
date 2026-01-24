#!/usr/bin/env bats

load '../test_helper'

setup() {
  setup_test_dirs
}

teardown() {
  teardown_test_dirs
}

@test "naming: service root follows convention" {
  run get_service_root "myservice"
  assert_success
  assert_output "$PLUGIN_DATA_ROOT/myservice"
}

@test "naming: data dir follows convention" {
  run get_service_data_dir "myservice"
  assert_success
  assert_output "$AUTH_DATA_ROOT/auth-myservice"
}

@test "naming: lldap container follows convention" {
  run get_lldap_container "myservice"
  assert_success
  assert_output "auth-myservice-lldap"
}

@test "naming: authelia container follows convention" {
  run get_authelia_container "myservice"
  assert_success
  assert_output "auth-myservice-authelia"
}

@test "naming: network follows convention" {
  run get_service_network "myservice"
  assert_success
  assert_output "auth-myservice"
}

@test "naming: handles hyphenated service names" {
  run get_lldap_container "my-test-service"
  assert_success
  assert_output "auth-my-test-service-lldap"

  run get_authelia_container "my-test-service"
  assert_success
  assert_output "auth-my-test-service-authelia"
}

@test "naming: handles numeric service names" {
  run get_lldap_container "service123"
  assert_success
  assert_output "auth-service123-lldap"
}

@test "naming: containers are uniquely named per service" {
  local lldap1 lldap2 authelia1 authelia2

  lldap1=$(get_lldap_container "service1")
  lldap2=$(get_lldap_container "service2")
  authelia1=$(get_authelia_container "service1")
  authelia2=$(get_authelia_container "service2")

  [[ "$lldap1" != "$lldap2" ]]
  [[ "$authelia1" != "$authelia2" ]]
  [[ "$lldap1" != "$authelia1" ]]
}
