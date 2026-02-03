#!/bin/bash
set -euo pipefail

echo "=== Running Tests ==="

cd /vagrant

# Install npm dependencies if needed
if [[ ! -d "node_modules" ]]; then
    echo "Installing npm dependencies..."
    npm ci
fi

# Install Playwright browsers if needed
if [[ ! -d "$HOME/.cache/ms-playwright" ]]; then
    echo "Installing Playwright browsers..."
    npx playwright install chromium
fi

# Parse arguments
TEST_TYPE="${1:-all}"
shift || true

case "$TEST_TYPE" in
    unit)
        echo "=== Running Unit Tests ==="
        npm run test:unit "$@"
        ;;
    integration)
        echo "=== Running Integration Tests ==="
        npm run test:integration "$@"
        ;;
    e2e)
        echo "=== Running E2E Tests ==="
        npm run test:e2e "$@"
        ;;
    all)
        echo "=== Running All Tests ==="
        npm run test:unit "$@"
        npm run test:integration "$@"
        npm run test:e2e "$@"
        ;;
    quick)
        echo "=== Running Quick Smoke Test ==="
        # Just test basic plugin functionality
        SERVICE_NAME="smoke-test-$$"

        echo "Creating service..."
        sudo dokku auth:create "$SERVICE_NAME"

        echo "Checking status..."
        sudo dokku auth:status "$SERVICE_NAME"

        echo "Getting info..."
        sudo dokku auth:info "$SERVICE_NAME"

        echo "Destroying service..."
        sudo dokku auth:destroy "$SERVICE_NAME" --force

        echo "=== Smoke Test Passed ==="
        ;;
    *)
        echo "Usage: $0 [unit|integration|e2e|all|quick] [extra args...]"
        exit 1
        ;;
esac
