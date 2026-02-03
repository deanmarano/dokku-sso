# -*- mode: ruby -*-
# vi: set ft=ruby :

Vagrant.configure("2") do |config|
  config.vm.box = "generic/ubuntu2204"
  config.vm.hostname = "dokku-test"

  # Use libvirt provider
  config.vm.provider :libvirt do |libvirt|
    libvirt.memory = 4096
    libvirt.cpus = 2
    libvirt.driver = "kvm"
  end

  # Forward ports for debugging (optional)
  config.vm.network "forwarded_port", guest: 80, host: 8080, host_ip: "127.0.0.1"
  config.vm.network "forwarded_port", guest: 17170, host: 17170, host_ip: "127.0.0.1"
  config.vm.network "forwarded_port", guest: 9091, host: 9091, host_ip: "127.0.0.1"

  # Sync the plugin source
  config.vm.synced_folder ".", "/vagrant", type: "rsync",
    rsync__exclude: [".git/", "node_modules/", ".vagrant/", "test-results/"]

  # Provisioning script
  config.vm.provision "shell", path: "vagrant/provision.sh"

  # Install plugin
  config.vm.provision "shell", path: "vagrant/install-plugin.sh", privileged: false

  # Run tests (optional, can also run manually)
  config.vm.provision "shell", path: "vagrant/run-tests.sh", privileged: false, run: "never"
end
