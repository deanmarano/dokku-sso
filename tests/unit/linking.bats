#!/usr/bin/env bats

load '../test_helper'

setup() {
  setup_test_dirs
}

teardown() {
  teardown_test_dirs
}

@test "linking: new service has no linked apps" {
  create_mock_service "test-service"

  run get_linked_apps "test-service"
  assert_success
  assert_output ""

  destroy_mock_service "test-service"
}

@test "linking: can link single app" {
  create_mock_service "test-service"

  add_app_link "test-service" "myapp"

  run get_linked_apps "test-service"
  assert_success
  assert_output "myapp"

  destroy_mock_service "test-service"
}

@test "linking: can link multiple apps" {
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

@test "linking: duplicate links are prevented" {
  create_mock_service "test-service"

  add_app_link "test-service" "myapp"
  add_app_link "test-service" "myapp"
  add_app_link "test-service" "myapp"

  local link_count
  link_count=$(get_linked_apps "test-service" | grep -c "myapp" || echo "0")

  [[ "$link_count" -eq 1 ]]

  destroy_mock_service "test-service"
}

@test "linking: is_app_linked returns true for linked app" {
  create_mock_service "test-service"
  add_app_link "test-service" "myapp"

  run is_app_linked "test-service" "myapp"
  assert_success

  destroy_mock_service "test-service"
}

@test "linking: is_app_linked returns false for unlinked app" {
  create_mock_service "test-service"

  run is_app_linked "test-service" "notlinked"
  assert_failure

  destroy_mock_service "test-service"
}

@test "linking: can remove linked app" {
  create_mock_service "test-service"
  add_app_link "test-service" "myapp"
  add_app_link "test-service" "otherapp"

  remove_app_link "test-service" "myapp"

  run is_app_linked "test-service" "myapp"
  assert_failure

  run is_app_linked "test-service" "otherapp"
  assert_success

  destroy_mock_service "test-service"
}

@test "linking: removing non-existent link is safe" {
  create_mock_service "test-service"

  # Should not fail
  remove_app_link "test-service" "nonexistent"

  destroy_mock_service "test-service"
}

@test "linking: links survive service operations" {
  create_mock_service "test-service"
  add_app_link "test-service" "persistent-app"

  # Simulate some operations
  local SERVICE_ROOT="$PLUGIN_DATA_ROOT/test-service"
  touch "$SERVICE_ROOT/some-temp-file"
  rm "$SERVICE_ROOT/some-temp-file"

  run is_app_linked "test-service" "persistent-app"
  assert_success

  destroy_mock_service "test-service"
}
