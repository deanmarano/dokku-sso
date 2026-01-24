#!/usr/bin/env bats

# Integration tests for dokku auth commands
load "${BATS_TEST_DIRNAME}/../test_helper/bats-support/load"
load "${BATS_TEST_DIRNAME}/../test_helper/bats-assert/load"

setup() {
  if ! command -v dokku &>/dev/null; then
    skip "Dokku is not installed"
  fi
  unset PLUGIN_BASE_PATH
  unset PLUGIN_DATA_ROOT
}

@test "commands: auth:help shows usage" {
  run dokku auth:help
  assert_success
  assert_output --partial "usage: dokku auth"
}

@test "commands: auth:help lists create command" {
  run dokku auth:help
  assert_success
  assert_output --partial "auth:create"
}

@test "commands: auth:help lists destroy command" {
  run dokku auth:help
  assert_success
  assert_output --partial "auth:destroy"
}

@test "commands: auth:help lists link command" {
  run dokku auth:help
  assert_success
  assert_output --partial "auth:link"
}

@test "commands: auth:help lists unlink command" {
  run dokku auth:help
  assert_success
  assert_output --partial "auth:unlink"
}

@test "commands: auth:help lists oidc commands" {
  run dokku auth:help
  assert_success
  assert_output --partial "auth:oidc:add"
  assert_output --partial "auth:oidc:remove"
  assert_output --partial "auth:oidc:list"
}

@test "commands: auth:help lists protect commands" {
  run dokku auth:help
  assert_success
  assert_output --partial "auth:protect"
  assert_output --partial "auth:unprotect"
}

@test "commands: auth:list works" {
  run dokku auth:list
  assert_success
}

@test "commands: auth:create requires service name" {
  run dokku auth:create
  assert_failure
  assert_output --partial "required"
}

@test "commands: auth:destroy requires service name" {
  run dokku auth:destroy
  assert_failure
  assert_output --partial "required"
}

@test "commands: auth:info requires service name" {
  run dokku auth:info
  assert_failure
  assert_output --partial "required"
}

@test "commands: auth:link requires arguments" {
  run dokku auth:link
  assert_failure
}

@test "commands: auth:unlink requires arguments" {
  run dokku auth:unlink
  assert_failure
}

@test "commands: auth:oidc:add requires arguments" {
  run dokku auth:oidc:add
  assert_failure
}

@test "commands: auth:oidc:remove requires arguments" {
  run dokku auth:oidc:remove
  assert_failure
}

@test "commands: auth:oidc:list requires service name" {
  run dokku auth:oidc:list
  assert_failure
  assert_output --partial "required"
}

@test "commands: auth:protect requires arguments" {
  run dokku auth:protect
  assert_failure
}

@test "commands: auth:unprotect requires arguments" {
  run dokku auth:unprotect
  assert_failure
}

@test "commands: auth:status requires service name" {
  run dokku auth:status
  assert_failure
  assert_output --partial "required"
}

@test "commands: auth:logs requires service name" {
  run dokku auth:logs
  assert_failure
  assert_output --partial "required"
}

@test "commands: unknown command shows error" {
  run dokku auth:nonexistent
  assert_failure
  assert_output --partial "Unknown command"
}
