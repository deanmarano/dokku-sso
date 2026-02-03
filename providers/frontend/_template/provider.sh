#!/usr/bin/env bash
# shellcheck disable=SC2034
# Frontend Provider Template
# Copy this file to a new directory and implement all functions
# SC2034 disabled: Variables are used when this script is sourced

# Provider metadata - MUST set these
PROVIDER_NAME=""                    # Short name (e.g., "authelia")
PROVIDER_DISPLAY_NAME=""            # Display name (e.g., "Authelia SSO")
PROVIDER_IMAGE=""                   # Docker image
PROVIDER_IMAGE_VERSION=""           # Docker image tag
PROVIDER_HTTP_PORT=""               # HTTP port for the frontend
PROVIDER_REQUIRED_CONFIG=""         # Space-separated list of required config keys

# Create and start the frontend container
# Arguments: SERVICE - name of the service
# Called by: frontend:create
provider_create_container() {
  local SERVICE="$1"
  echo "!     provider_create_container not implemented" >&2
  return 1
}

# Validate provider configuration
# Arguments: SERVICE
# Return: 0 if valid, 1 if invalid
provider_validate_config() {
  local SERVICE="$1"
  echo "!     provider_validate_config not implemented" >&2
  return 1
}

# Verify the service is working
# Arguments: SERVICE
# Return: 0 if working, 1 if not
provider_verify() {
  local SERVICE="$1"
  echo "!     provider_verify not implemented" >&2
  return 1
}

# Display provider configuration
# Arguments: SERVICE
provider_info() {
  local SERVICE="$1"
  echo "!     provider_info not implemented" >&2
}

# Configure the frontend to use a directory service
# Arguments: SERVICE DIRECTORY_SERVICE
provider_use_directory() {
  local SERVICE="$1"
  local DIRECTORY_SERVICE="$2"
  echo "!     provider_use_directory not implemented" >&2
  return 1
}

# Protect an app with this frontend
# Arguments: SERVICE APP
provider_protect_app() {
  local SERVICE="$1"
  local APP="$2"
  echo "!     provider_protect_app not implemented" >&2
  return 1
}

# Remove protection from an app
# Arguments: SERVICE APP
provider_unprotect_app() {
  local SERVICE="$1"
  local APP="$2"
  echo "!     provider_unprotect_app not implemented" >&2
  return 1
}

# Enable OIDC for the frontend
# Arguments: SERVICE
provider_enable_oidc() {
  local SERVICE="$1"
  echo "!     provider_enable_oidc not implemented" >&2
  return 1
}

# Disable OIDC for the frontend
# Arguments: SERVICE
provider_disable_oidc() {
  local SERVICE="$1"
  echo "!     provider_disable_oidc not implemented" >&2
  return 1
}

# Add an OIDC client
# Arguments: SERVICE CLIENT_ID CLIENT_SECRET REDIRECT_URI
provider_add_oidc_client() {
  local SERVICE="$1"
  local CLIENT_ID="$2"
  local CLIENT_SECRET="$3"
  local REDIRECT_URI="$4"
  echo "!     provider_add_oidc_client not implemented" >&2
  return 1
}

# Remove an OIDC client
# Arguments: SERVICE CLIENT_ID
provider_remove_oidc_client() {
  local SERVICE="$1"
  local CLIENT_ID="$2"
  echo "!     provider_remove_oidc_client not implemented" >&2
  return 1
}

# List OIDC clients
# Arguments: SERVICE
# Output: CLIENT_ID lines
provider_list_oidc_clients() {
  local SERVICE="$1"
  echo "!     provider_list_oidc_clients not implemented" >&2
  return 1
}

# Destroy the container
# Arguments: SERVICE
provider_destroy() {
  local SERVICE="$1"
  echo "!     provider_destroy not implemented" >&2
  return 1
}

# Get container logs
# Arguments: SERVICE [OPTIONS]
provider_logs() {
  local SERVICE="$1"
  shift
  echo "!     provider_logs not implemented" >&2
  return 1
}

# Check if container is running
# Arguments: SERVICE
provider_is_running() {
  local SERVICE="$1"
  echo "!     provider_is_running not implemented" >&2
  return 1
}
