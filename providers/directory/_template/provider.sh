#!/usr/bin/env bash
# shellcheck disable=SC2034
# Directory Provider Template
# Copy this file to a new directory and implement all functions
# SC2034 disabled: Variables are used when this script is sourced

# Provider metadata - MUST set these
PROVIDER_NAME=""                    # Short name (e.g., "lldap")
PROVIDER_DISPLAY_NAME=""            # Display name (e.g., "LLDAP (Lightweight LDAP)")
PROVIDER_IMAGE=""                   # Docker image
PROVIDER_IMAGE_VERSION=""           # Docker image tag
PROVIDER_LDAP_PORT=""               # LDAP port (usually 389 or 3890)
PROVIDER_HTTP_PORT=""               # HTTP/admin port (optional)
PROVIDER_REQUIRED_CONFIG=""         # Space-separated list of required config keys

# Create and start the container
# Arguments: SERVICE - name of the service
# Called by: auth:create, auth:provider:apply
provider_create_container() {
  local SERVICE="$1"
  echo "!     provider_create_container not implemented" >&2
  return 1
}

# Get the LDAP port
provider_get_ldap_port() {
  echo "$PROVIDER_LDAP_PORT"
}

# Get bind credentials for apps
# Arguments: SERVICE
# Output: KEY=VALUE pairs (LDAP_URL, LDAP_BASE_DN, LDAP_BIND_DN, LDAP_BIND_PASSWORD)
provider_get_bind_credentials() {
  local SERVICE="$1"
  echo "!     provider_get_bind_credentials not implemented" >&2
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

# Create a group
# Arguments: SERVICE GROUP_NAME
provider_create_group() {
  local SERVICE="$1"
  local GROUP_NAME="$2"
  echo "!     provider_create_group not implemented" >&2
  return 1
}

# Get members of a group
# Arguments: SERVICE GROUP_NAME
# Output: User IDs (one per line)
provider_get_group_members() {
  local SERVICE="$1"
  local GROUP_NAME="$2"
  echo "!     provider_get_group_members not implemented" >&2
  return 1
}

# Add user to group
# Arguments: SERVICE USER_ID GROUP_NAME
provider_add_user_to_group() {
  local SERVICE="$1"
  local USER_ID="$2"
  local GROUP_NAME="$3"
  echo "!     provider_add_user_to_group not implemented" >&2
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
