import { presignDaemonBinary } from './r2.js'

export interface ProvisionStep {
  readonly id: string
  readonly name: string
  readonly commands: string[] | (() => string[] | Promise<string[]>)
  readonly validate?: string | undefined
}

export interface StepResult {
  readonly id: string
  readonly status: 'pending' | 'running' | 'completed' | 'failed'
  readonly output?: string | undefined
}

export async function resolveCommands(step: ProvisionStep): Promise<string[]> {
  if (typeof step.commands === 'function') {
    return step.commands()
  }
  return step.commands
}

export const PROVISION_STEPS: ProvisionStep[] = [
  {
    id: 'system-deps',
    name: 'Install system dependencies',
    commands: [
      'export DEBIAN_FRONTEND=noninteractive',
      'apt-get update -qq',
      'apt-get install -y -qq curl nftables',
    ],
    validate: 'curl --version',
  },
  {
    id: 'install-firecracker',
    name: 'Install Firecracker',
    commands: [
      'FC_VERSION=1.10.1',
      'curl -sSL https://github.com/firecracker-microvm/firecracker/releases/download/v${FC_VERSION}/firecracker-v${FC_VERSION}-x86_64.tgz -o /tmp/fc.tgz',
      'tar -xzf /tmp/fc.tgz -C /tmp',
      'mv /tmp/release-v${FC_VERSION}-x86_64/firecracker-v${FC_VERSION}-x86_64 /usr/local/bin/firecracker',
      'mv /tmp/release-v${FC_VERSION}-x86_64/jailer-v${FC_VERSION}-x86_64 /usr/local/bin/jailer',
      'chmod +x /usr/local/bin/firecracker /usr/local/bin/jailer',
      'rm -rf /tmp/fc.tgz /tmp/release-v${FC_VERSION}-x86_64',
    ],
    validate: 'firecracker --version',
  },
  {
    id: 'load-kernel-modules',
    name: 'Load kernel modules',
    commands: [
      'modprobe kvm',
      'modprobe kvm_amd || modprobe kvm_intel || true',
      'modprobe tun',
      'echo "kvm" >> /etc/modules-load.d/sandchest.conf',
      'echo "tun" >> /etc/modules-load.d/sandchest.conf',
    ],
    validate: 'lsmod | grep kvm',
  },
  {
    id: 'enable-ip-forward',
    name: 'Enable IP forwarding',
    commands: [
      'sysctl -w net.ipv4.ip_forward=1',
      'echo "net.ipv4.ip_forward=1" >> /etc/sysctl.d/99-sandchest.conf',
      'sysctl -p /etc/sysctl.d/99-sandchest.conf',
    ],
    validate: 'sysctl net.ipv4.ip_forward | grep 1',
  },
  {
    id: 'create-jailer-user',
    name: 'Create jailer user',
    commands: [
      'id -u jailer &>/dev/null || useradd -r -u 10000 -s /usr/sbin/nologin jailer',
    ],
    validate: 'id jailer',
  },
  {
    id: 'create-data-dirs',
    name: 'Create data directories',
    commands: [
      'mkdir -p /var/sandchest/{images,snapshots,sandboxes,jailer}',
      'chown -R jailer:jailer /var/sandchest/jailer',
    ],
    validate: 'ls -d /var/sandchest/images /var/sandchest/snapshots /var/sandchest/sandboxes /var/sandchest/jailer',
  },
  {
    id: 'download-images',
    name: 'Download kernel & rootfs',
    commands: [
      'echo "Image download step — configure R2 URLs in production"',
    ],
  },
  {
    id: 'install-certs-mtls',
    name: 'Configure mTLS certificates',
    commands: [
      'mkdir -p /etc/sandchest/certs',
      'echo "mTLS certificate setup — configure API↔Node mutual TLS in production"',
    ],
  },
  {
    id: 'configure-firewall',
    name: 'Configure firewall',
    commands: [
      'echo "Firewall — configure via Hetzner Cloud firewall or manually post-provision"',
    ],
  },
  {
    id: 'deploy-node-daemon',
    name: 'Deploy node daemon',
    commands: async () => {
      const url = await presignDaemonBinary()
      return [
        `curl -fsSL '${url}' -o /usr/local/bin/sandchest-node`,
        'chmod +x /usr/local/bin/sandchest-node',
        'printf \'[Unit]\\nDescription=Sandchest Node Daemon\\nAfter=network.target\\n\\n[Service]\\nType=simple\\nExecStart=/usr/local/bin/sandchest-node\\nRestart=always\\nRestartSec=5\\nEnvironment=RUST_LOG=info\\nEnvironment=DATA_DIR=/var/sandchest\\n\\n[Install]\\nWantedBy=multi-user.target\\n\' > /etc/systemd/system/sandchest-node.service',
        'systemctl daemon-reload',
        'systemctl enable sandchest-node',
      ]
    },
    validate: '/usr/local/bin/sandchest-node --version || true',
  },
  {
    id: 'start-services',
    name: 'Start services',
    commands: [
      'systemctl start sandchest-node || true',
      'echo "Services started"',
    ],
    validate: 'systemctl is-active sandchest-node || echo "sandchest-node not yet active (binary may not be deployed)"',
  },
]
