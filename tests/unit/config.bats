#!/usr/bin/env bats

load '../test_helper'

setup() {
  setup_test_dirs
}

teardown() {
  teardown_test_dirs
}

@test "config: PLUGIN_COMMAND_PREFIX is set" {
  [[ -n "$PLUGIN_COMMAND_PREFIX" ]]
  [[ "$PLUGIN_COMMAND_PREFIX" == "auth" ]]
}

@test "config: PLUGIN_DATA_ROOT is set" {
  [[ -n "$PLUGIN_DATA_ROOT" ]]
}

@test "config: AUTH_DEFAULT_PROVIDER is set" {
  [[ -n "$AUTH_DEFAULT_PROVIDER" ]]
  [[ "$AUTH_DEFAULT_PROVIDER" == "lldap" ]]
}

@test "config: LLDAP_DOCKER_IMAGE is set" {
  [[ -n "$LLDAP_DOCKER_IMAGE" ]]
  [[ "$LLDAP_DOCKER_IMAGE" == *"lldap"* ]]
}

@test "config: AUTHELIA_DOCKER_IMAGE is set" {
  [[ -n "$AUTHELIA_DOCKER_IMAGE" ]]
  [[ "$AUTHELIA_DOCKER_IMAGE" == *"authelia"* ]]
}

@test "config: LLDAP_LDAP_PORT is set" {
  [[ -n "$LLDAP_LDAP_PORT" ]]
  [[ "$LLDAP_LDAP_PORT" == "3890" ]]
}

@test "config: LLDAP_WEB_PORT is set" {
  [[ -n "$LLDAP_WEB_PORT" ]]
  [[ "$LLDAP_WEB_PORT" == "17170" ]]
}

@test "config: AUTHELIA_PORT is set" {
  [[ -n "$AUTHELIA_PORT" ]]
  [[ "$AUTHELIA_PORT" == "9091" ]]
}
