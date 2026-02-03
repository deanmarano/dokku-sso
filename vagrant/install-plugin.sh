#!/bin/bash
set -euo pipefail

echo "=== Installing Auth Plugin ==="

PLUGIN_DIR="/var/lib/dokku/plugins/available/auth"
ENABLED_DIR="/var/lib/dokku/plugins/enabled/auth"

# Remove old installation if exists
sudo rm -rf "$PLUGIN_DIR" "$ENABLED_DIR"

# Copy plugin from synced folder
sudo mkdir -p "$PLUGIN_DIR"
sudo cp -r /vagrant/* "$PLUGIN_DIR/"
sudo rm -rf "$PLUGIN_DIR/node_modules" "$PLUGIN_DIR/.vagrant" "$PLUGIN_DIR/test-results"

# Set permissions
sudo chown -R dokku:dokku "$PLUGIN_DIR"
sudo chmod +x "$PLUGIN_DIR/subcommands"/* 2>/dev/null || true

# Enable plugin
sudo ln -sf "$PLUGIN_DIR" "$ENABLED_DIR"

# Initialize plugin
sudo dokku plugin:install-dependencies || true

echo "=== Plugin Installed ==="
dokku help auth 2>/dev/null || echo "Plugin commands will be available after dokku restart"

# Verify subcommands
echo ""
echo "Available subcommands:"
ls -la "$PLUGIN_DIR/subcommands/" | head -20
