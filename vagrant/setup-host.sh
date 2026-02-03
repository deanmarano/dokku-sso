#!/bin/bash
set -euo pipefail

echo "=== Setting Up Host for VM Testing ==="

# Check for libvirt
if ! command -v virsh &>/dev/null; then
    echo "ERROR: libvirt not found. Install it first:"
    echo "  sudo apt-get install -y qemu-kvm libvirt-daemon-system"
    exit 1
fi

# Install vagrant if needed
if ! command -v vagrant &>/dev/null; then
    echo "Installing Vagrant..."
    sudo apt-get update
    sudo apt-get install -y vagrant vagrant-libvirt
fi

# Install libvirt plugin if needed
if ! vagrant plugin list | grep -q vagrant-libvirt; then
    echo "Installing vagrant-libvirt plugin..."
    vagrant plugin install vagrant-libvirt
fi

# Ensure user is in libvirt group
if ! groups | grep -q libvirt; then
    echo "Adding user to libvirt group..."
    sudo usermod -aG libvirt "$USER"
    echo "NOTE: Log out and back in for group changes to take effect"
fi

echo "=== Host Setup Complete ==="
echo ""
echo "To start the test VM:"
echo "  cd $(dirname "$0")/.."
echo "  vagrant up"
echo ""
echo "To run tests inside the VM:"
echo "  vagrant ssh -c '/vagrant/vagrant/run-tests.sh quick'"
echo ""
echo "To destroy the VM:"
echo "  vagrant destroy -f"
