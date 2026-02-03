.PHONY: test test-unit test-integration test-e2e test-docker deps lint install help

# Default target
help:
	@echo "dokku-auth development commands:"
	@echo ""
	@echo "  make deps              Install test dependencies"
	@echo "  make test              Run all tests (unit + integration)"
	@echo "  make test-unit         Run unit tests only"
	@echo "  make test-integration  Run integration tests (requires Dokku)"
	@echo "  make test-e2e          Run E2E browser tests"
	@echo "  make test-docker       Run tests in isolated Docker environment"
	@echo ""
	@echo "  make test-env-up       Start test environment"
	@echo "  make test-env-down     Stop test environment"
	@echo "  make test-env-shell    Shell into Dokku container"
	@echo "  make test-env-run      Run tests against running environment"
	@echo ""
	@echo "  make lint              Run shellcheck on all scripts"
	@echo "  make install           Install plugin locally"
	@echo ""

# Install dependencies
deps:
	npm install
	npx playwright install chromium

# Run all tests
test: test-unit test-integration

# Unit tests (fast, no external deps)
test-unit:
	npm run test:unit

# Integration tests (requires Dokku)
test-integration:
	npm run test:integration

# E2E browser tests
test-e2e:
	npm run test:e2e

# Run tests in Docker
test-docker:
	./scripts/test-docker.sh

# Start test environment
test-env-up:
	docker compose -f docker-compose.test.yml up -d dokku
	@echo "Waiting for Dokku..."
	@sleep 30
	docker compose -f docker-compose.test.yml exec -T dokku dokku plugin:install file:///plugin-src --name auth || true
	@echo ""
	@echo "Dokku running at localhost:8080"
	@echo "SSH: ssh -p 3022 dokku@localhost"

# Stop test environment
test-env-down:
	docker compose -f docker-compose.test.yml down -v

# Shell into Dokku container
test-env-shell:
	docker compose -f docker-compose.test.yml exec dokku bash

# Run tests against running environment
test-env-run:
	docker compose -f docker-compose.test.yml run --rm test-runner npm run test:all

# Lint shell scripts
lint:
	@echo "Running shellcheck..."
	@shellcheck -x commands config install
	@shellcheck -x subcommands/*
	@shellcheck -x providers/loader.sh
	@shellcheck -x providers/directory/*/provider.sh
	@shellcheck -x providers/frontend/*/provider.sh
	@echo "Shellcheck passed!"

# Run E2E tests with environment
test-e2e-full:
	$(MAKE) test-env-up
	docker compose -f docker-compose.test.yml run --rm test-runner npm run test:e2e
	$(MAKE) test-env-down

# Install plugin locally
install:
	@echo "Installing plugin..."
	@sudo dokku plugin:install file://$$(pwd) --name auth || \
		sudo dokku plugin:update auth

# Uninstall plugin
uninstall:
	@echo "Uninstalling plugin..."
	@sudo dokku plugin:uninstall auth || true
