#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

usage() {
    cat <<EOF
Usage: $0 [command] [options]

Commands:
    up          Start the test VM (creates if needed)
    down        Stop the test VM (preserves state)
    destroy     Destroy the test VM completely
    ssh         SSH into the test VM
    test        Run tests inside the VM
    quick       Run quick smoke test
    reload      Reload plugin (after code changes)
    status      Show VM status
    logs        Show VM console output

Test options (for 'test' command):
    unit        Run unit tests only
    integration Run integration tests only
    e2e         Run E2E tests only
    all         Run all tests (default)

Examples:
    $0 up                    # Start VM
    $0 test quick            # Run smoke test
    $0 test integration      # Run integration tests
    $0 ssh                   # Interactive shell
    $0 reload                # Reload plugin after changes
    $0 destroy               # Clean up
EOF
}

# Check vagrant is installed
check_vagrant() {
    if ! command -v vagrant &>/dev/null; then
        echo "Vagrant not installed. Run: ./vagrant/setup-host.sh"
        exit 1
    fi
}

cmd_up() {
    check_vagrant
    echo "=== Starting Test VM ==="
    vagrant up --provider=libvirt
    echo ""
    echo "VM is ready. Run tests with: $0 test quick"
}

cmd_down() {
    check_vagrant
    echo "=== Stopping Test VM ==="
    vagrant halt
}

cmd_destroy() {
    check_vagrant
    echo "=== Destroying Test VM ==="
    vagrant destroy -f
}

cmd_ssh() {
    check_vagrant
    vagrant ssh
}

cmd_test() {
    check_vagrant
    local test_type="${1:-all}"
    echo "=== Running Tests: $test_type ==="
    vagrant ssh -c "/vagrant/vagrant/run-tests.sh $test_type"
}

cmd_reload() {
    check_vagrant
    echo "=== Reloading Plugin ==="
    vagrant rsync
    vagrant ssh -c "/vagrant/vagrant/install-plugin.sh"
}

cmd_status() {
    check_vagrant
    vagrant status
}

cmd_logs() {
    check_vagrant
    vagrant ssh -c "sudo journalctl -u dokku -n 50"
}

# Main
case "${1:-help}" in
    up)
        cmd_up
        ;;
    down)
        cmd_down
        ;;
    destroy)
        cmd_destroy
        ;;
    ssh)
        cmd_ssh
        ;;
    test)
        shift
        cmd_test "$@"
        ;;
    quick)
        cmd_test quick
        ;;
    reload)
        cmd_reload
        ;;
    status)
        cmd_status
        ;;
    logs)
        cmd_logs
        ;;
    help|--help|-h)
        usage
        ;;
    *)
        echo "Unknown command: $1"
        usage
        exit 1
        ;;
esac
