#!/bin/bash
set -euo pipefail

echo "=== Provisioning Dokku Test VM ==="

# Update system
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get upgrade -y

# Install Docker
echo "=== Installing Docker ==="
apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Add vagrant user to docker and dokku groups
usermod -aG docker vagrant
usermod -aG dokku vagrant

# Create services directory with proper permissions
mkdir -p /var/lib/dokku/services
chown dokku:dokku /var/lib/dokku/services

# Install Dokku
echo "=== Installing Dokku ==="
curl -fsSL https://packagecloud.io/dokku/dokku/gpgkey | gpg --dearmor -o /etc/apt/keyrings/dokku.gpg
echo "deb [signed-by=/etc/apt/keyrings/dokku.gpg] https://packagecloud.io/dokku/dokku/ubuntu/ $(lsb_release -cs) main" | tee /etc/apt/sources.list.d/dokku.list

# Set dokku answers for unattended install
echo "dokku dokku/web_config boolean false" | debconf-set-selections
echo "dokku dokku/vhost_enable boolean true" | debconf-set-selections
echo "dokku dokku/hostname string dokku-test.local" | debconf-set-selections
echo "dokku dokku/skip_key_file boolean true" | debconf-set-selections

apt-get update
apt-get install -y dokku

# Install Node.js 20
echo "=== Installing Node.js ==="
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Install test dependencies
apt-get install -y ldap-utils netcat-openbsd jq

# Install Playwright system dependencies
npx playwright install-deps chromium || true

echo "=== Provisioning Complete ==="
dokku version
node --version
npm --version
docker --version
