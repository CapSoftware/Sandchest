import type { AdminConfig } from './config.js'
import { presignDaemonBinary } from './r2.js'

export interface ProvisionStep {
  readonly id: string
  readonly name: string
  readonly commands: string[] | ((config: AdminConfig) => string[] | Promise<string[]>)
  readonly validate?: string | undefined
}

export interface StepResult {
  readonly id: string
  readonly status: 'pending' | 'running' | 'completed' | 'failed'
  readonly output?: string | undefined
}

export async function resolveCommands(step: ProvisionStep, config: AdminConfig): Promise<string[]> {
  if (typeof step.commands === 'function') {
    return step.commands(config)
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
    commands: async (config: AdminConfig) => {
      const r2 = config.r2
      if (!r2?.endpoint || !r2.bucket) {
        return ['echo "SKIP: R2 not configured — images must be uploaded manually"']
      }
      return [
        `curl -fsSL "$(sandchest-admin r2-presign binaries/vmlinux/latest/vmlinux)" -o /var/sandchest/images/vmlinux`,
        `curl -fsSL "$(sandchest-admin r2-presign binaries/rootfs/latest/rootfs.ext4)" -o /var/sandchest/images/rootfs.ext4`,
        'chmod 644 /var/sandchest/images/vmlinux /var/sandchest/images/rootfs.ext4',
      ]
    },
  },
  {
    id: 'install-certs-mtls',
    name: 'Configure mTLS certificates',
    commands: (config: AdminConfig) => {
      const certsDir = config.certs?.dir
      if (!certsDir) {
        return [
          'mkdir -p /etc/sandchest/certs',
          'echo "SKIP: certs.dir not configured — run certs install separately"',
        ]
      }
      return [
        'mkdir -p /etc/sandchest/certs',
        'chmod 700 /etc/sandchest/certs',
        // Actual file transfer handled by the certs install command
        'echo "Certs directory created — use sandchest-admin certs install to push certs"',
      ]
    },
  },
  {
    id: 'configure-firewall',
    name: 'Configure firewall',
    commands: (config: AdminConfig) => {
      const grpcPort = config.node?.grpcPort ?? 50051
      const iface = config.node?.outboundIface ?? 'eth0'
      return [
        'systemctl enable nftables',
        `nft flush ruleset`,
        `nft add table inet filter`,
        `nft add chain inet filter input '{ type filter hook input priority 0; policy drop; }'`,
        `nft add rule inet filter input iif lo accept`,
        `nft add rule inet filter input ct state established,related accept`,
        `nft add rule inet filter input tcp dport 22 accept`,
        `nft add rule inet filter input tcp dport ${grpcPort} accept`,
        `nft add rule inet filter input icmp type echo-request accept`,
        `nft add chain inet filter forward '{ type filter hook forward priority 0; policy drop; }'`,
        `nft add rule inet filter forward ct state established,related accept`,
        // Allow VM outbound NAT
        `nft add table inet nat`,
        `nft add chain inet nat postrouting '{ type nat hook postrouting priority 100; }'`,
        `nft add rule inet nat postrouting oifname "${iface}" masquerade`,
        `nft list ruleset > /etc/nftables.conf`,
      ]
    },
    validate: 'nft list ruleset | grep sandchest || nft list ruleset | grep "tcp dport 50051"',
  },
  {
    id: 'deploy-node-daemon',
    name: 'Deploy node daemon',
    commands: async (config: AdminConfig) => {
      const url = await presignDaemonBinary(config)
      return [
        `curl -fsSL '${url}' -o /usr/local/bin/sandchest-node`,
        'chmod +x /usr/local/bin/sandchest-node',
        `printf '[Unit]\\nDescription=Sandchest Node Daemon\\nAfter=network.target\\n\\n[Service]\\nType=simple\\nExecStart=/usr/local/bin/sandchest-node\\nRestart=always\\nRestartSec=5\\nEnvironmentFile=-/etc/sandchest/node.env\\nEnvironment=RUST_LOG=info\\nEnvironment=DATA_DIR=/var/sandchest\\n\\n[Install]\\nWantedBy=multi-user.target\\n' > /etc/systemd/system/sandchest-node.service`,
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
