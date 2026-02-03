#!/bin/bash
set -e

cd "$(dirname "$0")/.."

echo "=== dokku-auth Docker Test Environment ==="
echo ""

# Parse arguments
CLEANUP=true
INTERACTIVE=false
TEST_TYPE="all"

while [[ $# -gt 0 ]]; do
  case $1 in
    --no-cleanup) CLEANUP=false; shift ;;
    -i|--interactive) INTERACTIVE=true; shift ;;
    --unit) TEST_TYPE="unit"; shift ;;
    --integration) TEST_TYPE="integration"; shift ;;
    --e2e) TEST_TYPE="e2e"; shift ;;
    *) shift ;;
  esac
done

# Clean up any existing containers
echo "Cleaning up old containers..."
docker compose -f docker-compose.test.yml down -v 2>/dev/null || true

# Build test runner
echo "Building test runner..."
docker compose -f docker-compose.test.yml build test-runner

# Start dokku
echo "Starting Dokku..."
docker compose -f docker-compose.test.yml up -d dokku

# Wait for dokku to be healthy
echo "Waiting for Dokku to be ready..."
timeout 120 bash -c 'until docker compose -f docker-compose.test.yml exec -T dokku dokku version 2>/dev/null; do sleep 2; done'
echo "Dokku is ready!"

# Install the plugin
echo "Installing auth plugin..."
docker compose -f docker-compose.test.yml exec -T dokku dokku plugin:install file:///plugin-src --name auth 2>/dev/null || \
  docker compose -f docker-compose.test.yml exec -T dokku dokku plugin:update auth file:///plugin-src 2>/dev/null || true

# Show plugin is installed
echo ""
echo "Installed plugins:"
docker compose -f docker-compose.test.yml exec -T dokku dokku plugin:list

# Create test service for E2E tests
if [[ "$TEST_TYPE" == "all" ]] || [[ "$TEST_TYPE" == "e2e" ]] || [[ "$TEST_TYPE" == "integration" ]]; then
  echo ""
  echo "Creating test LLDAP service..."
  docker compose -f docker-compose.test.yml exec -T dokku dokku auth:create e2e-test 2>/dev/null || true

  # Wait for service to be ready
  echo "Waiting for LLDAP to be ready..."
  sleep 15

  # Show service status
  echo ""
  echo "Service info:"
  docker compose -f docker-compose.test.yml exec -T dokku dokku auth:info e2e-test 2>/dev/null || true
fi

# Interactive mode - drop into shell
if [[ "$INTERACTIVE" == "true" ]]; then
  echo ""
  echo "=== Interactive Mode ==="
  echo "Dropping into test-runner shell..."
  echo "Run tests with: npm run test:unit / test:integration / test:e2e"
  echo ""
  docker compose -f docker-compose.test.yml run --rm \
    -e SKIP_GLOBAL_SETUP=true \
    -e E2E_SERVICE_NAME=e2e-test \
    test-runner bash
else
  # Run tests
  echo ""
  echo "=== Running Tests ==="
  echo ""

  TEST_EXIT_CODE=0

  if [[ "$TEST_TYPE" == "all" ]] || [[ "$TEST_TYPE" == "unit" ]]; then
    echo "--- Unit Tests ---"
    docker compose -f docker-compose.test.yml run --rm test-runner npm run test:unit || TEST_EXIT_CODE=$?
  fi

  if [[ "$TEST_TYPE" == "all" ]] || [[ "$TEST_TYPE" == "integration" ]]; then
    echo ""
    echo "--- Integration Tests ---"
    docker compose -f docker-compose.test.yml run --rm \
      -e SKIP_GLOBAL_SETUP=true \
      -e E2E_SERVICE_NAME=e2e-test \
      test-runner npm run test:integration || TEST_EXIT_CODE=$?
  fi

  if [[ "$TEST_TYPE" == "all" ]] || [[ "$TEST_TYPE" == "e2e" ]]; then
    echo ""
    echo "--- E2E Tests (auth-ui) ---"
    docker compose -f docker-compose.test.yml run --rm \
      -e SKIP_GLOBAL_SETUP=true \
      -e E2E_SERVICE_NAME=e2e-test \
      -e BASE_URL=http://dokku:17170 \
      -e LLDAP_URL=http://dokku:17170 \
      test-runner npm run test:e2e:ui || TEST_EXIT_CODE=$?
  fi

  echo ""
  echo "=== Tests Complete (exit code: $TEST_EXIT_CODE) ==="
fi

# Cleanup
if [[ "$CLEANUP" == "true" ]]; then
  echo ""
  echo "Cleaning up..."
  docker compose -f docker-compose.test.yml down -v
else
  echo ""
  echo "Test environment still running (--no-cleanup)."
  echo "  - Dokku:  http://localhost:8080"
  echo "  - LLDAP:  http://localhost:17170"
  echo "  - SSH:    ssh -p 3022 dokku@localhost"
  echo ""
  echo "To clean up: docker compose -f docker-compose.test.yml down -v"
fi

exit ${TEST_EXIT_CODE:-0}
