#!/usr/bin/env bats

# Integration tests for subcommand help
load "${BATS_TEST_DIRNAME}/../test_helper/bats-support/load"
load "${BATS_TEST_DIRNAME}/../test_helper/bats-assert/load"

setup() {
  if ! command -v dokku &>/dev/null; then
    skip "Dokku is not installed"
  fi
  unset PLUGIN_BASE_PATH
  unset PLUGIN_DATA_ROOT
}

@test "subcommand-help: auth:create --help shows usage" {
  run dokku auth:create --help
  assert_success
  assert_output --partial "usage:"
  assert_output --partial "create"
}

@test "subcommand-help: auth:destroy --help shows usage" {
  run dokku auth:destroy --help
  assert_success
  assert_output --partial "usage:"
}

@test "subcommand-help: auth:link --help shows usage" {
  run dokku auth:link --help
  assert_success
  assert_output --partial "usage:"
}

@test "subcommand-help: auth:unlink --help shows usage" {
  run dokku auth:unlink --help
  assert_success
  assert_output --partial "usage:"
}

@test "subcommand-help: auth:info --help shows usage" {
  run dokku auth:info --help
  assert_success
  assert_output --partial "usage:"
}

@test "subcommand-help: auth:status --help shows usage" {
  run dokku auth:status --help
  assert_success
  assert_output --partial "usage:"
}

@test "subcommand-help: auth:logs --help shows usage" {
  run dokku auth:logs --help
  assert_success
  assert_output --partial "usage:"
}

@test "subcommand-help: auth:oidc:add --help shows usage" {
  run dokku auth:oidc:add --help
  assert_success
  assert_output --partial "usage:"
}

@test "subcommand-help: auth:oidc:remove --help shows usage" {
  run dokku auth:oidc:remove --help
  assert_success
  assert_output --partial "usage:"
}

@test "subcommand-help: auth:oidc:list --help shows usage" {
  run dokku auth:oidc:list --help
  assert_success
  assert_output --partial "usage:"
}

@test "subcommand-help: auth:protect --help shows usage" {
  run dokku auth:protect --help
  assert_success
  assert_output --partial "usage:"
}

@test "subcommand-help: auth:unprotect --help shows usage" {
  run dokku auth:unprotect --help
  assert_success
  assert_output --partial "usage:"
}

@test "subcommand-help: create help shows provider flag" {
  run dokku auth:create --help
  assert_success
  assert_output --partial "--provider"
}

@test "subcommand-help: create help shows gateway-domain flag" {
  run dokku auth:create --help
  assert_success
  assert_output --partial "--gateway-domain"
}

@test "subcommand-help: oidc:add help shows redirect-uri flag" {
  run dokku auth:oidc:add --help
  assert_success
  assert_output --partial "--redirect-uri"
}

@test "subcommand-help: protect help shows policy flag" {
  run dokku auth:protect --help
  assert_success
  assert_output --partial "--policy"
}

@test "subcommand-help: logs help shows tail flag" {
  run dokku auth:logs --help
  assert_success
  assert_output --partial "--tail"
}
