import { presignDaemonBinary, presignKernel, presignRootfs } from './r2.js'

export interface ProvisionContext {
  readonly nodeId: string
  readonly ip: string
}

export interface ProvisionStep {
  readonly id: string
  readonly name: string
  readonly commands: string[] | ((ctx: ProvisionContext) => string[] | Promise<string[]>)
  readonly validate?: string | undefined
  readonly timeoutMs?: number | undefined
}

export interface StepResult {
  readonly id: string
  readonly status: 'pending' | 'running' | 'completed' | 'failed'
  readonly output?: string | undefined
}

/** OpenSSL commands to generate a full mTLS PKI (CA + server + client certs). */
export function mtlsCertCommands(ip: string): string[] {
  const dir = '/etc/sandchest/certs'
  return [
    `mkdir -p ${dir}`,
    // CA key + self-signed cert (RSA 4096, 10-year validity)
    `openssl genrsa -out ${dir}/ca.key 4096`,
    `openssl req -new -x509 -key ${dir}/ca.key -out ${dir}/ca.pem -days 3650 -subj "/CN=sandchest-ca"`,
    // Server key + CSR + signed cert with SAN=IP
    `openssl genrsa -out ${dir}/server.key 2048`,
    `openssl req -new -key ${dir}/server.key -out ${dir}/server.csr -subj "/CN=sandchest-node"`,
    `printf "[v3_ext]\\nsubjectAltName=IP:${ip}\\nkeyUsage=digitalSignature,keyEncipherment\\nextendedKeyUsage=serverAuth\\n" > ${dir}/server.ext`,
    `openssl x509 -req -in ${dir}/server.csr -CA ${dir}/ca.pem -CAkey ${dir}/ca.key -CAcreateserial -out ${dir}/server.pem -days 3650 -extfile ${dir}/server.ext -extensions v3_ext`,
    // Client key + CSR + signed cert
    `openssl genrsa -out ${dir}/client.key 2048`,
    `openssl req -new -key ${dir}/client.key -out ${dir}/client.csr -subj "/CN=sandchest-api"`,
    `printf "[v3_ext]\\nkeyUsage=digitalSignature,keyEncipherment\\nextendedKeyUsage=clientAuth\\n" > ${dir}/client.ext`,
    `openssl x509 -req -in ${dir}/client.csr -CA ${dir}/ca.pem -CAkey ${dir}/ca.key -CAcreateserial -out ${dir}/client.pem -days 3650 -extfile ${dir}/client.ext -extensions v3_ext`,
    // Tighten permissions
    `chmod 600 ${dir}/*.key`,
    `chmod 644 ${dir}/*.pem`,
    // Cleanup CSR and ext files
    `rm -f ${dir}/*.csr ${dir}/*.ext ${dir}/*.srl`,
  ]
}

export async function resolveCommands(step: ProvisionStep, ctx: ProvisionContext): Promise<string[]> {
  if (typeof step.commands === 'function') {
    return step.commands(ctx)
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
    timeoutMs: 300_000, // 5 min — images can be large
    commands: async () => {
      const kernelUrl = await presignKernel()
      const rootfsUrl = await presignRootfs()
      return [
        'mkdir -p /var/sandchest/images',
        `curl -fsSL --retry 3 --retry-delay 5 '${kernelUrl}' -o /var/sandchest/images/vmlinux-5.10`,
        `curl -fsSL --retry 3 --retry-delay 5 '${rootfsUrl}' -o /var/sandchest/images/rootfs.ext4`,
        'chmod 644 /var/sandchest/images/vmlinux-5.10 /var/sandchest/images/rootfs.ext4',
      ]
    },
    validate: 'test -f /var/sandchest/images/vmlinux-5.10 && test -f /var/sandchest/images/rootfs.ext4 && echo "images ok"',
  },
  {
    id: 'install-certs-mtls',
    name: 'Configure mTLS certificates',
    commands: (ctx) => mtlsCertCommands(ctx.ip),
    validate: 'test -f /etc/sandchest/certs/server.pem && test -f /etc/sandchest/certs/client.pem && echo "certs ok"',
  },
  {
    id: 'configure-firewall',
    name: 'Configure firewall',
    commands: [
      // Write nftables ruleset, apply, and persist (single command to avoid heredoc + && join issues)
      `cat > /etc/nftables.conf << 'NFTEOF'
#!/usr/sbin/nft -f
flush ruleset

table inet sandchest {
  chain input {
    type filter hook input priority 0; policy drop;

    # Loopback
    iif lo accept

    # Established / related
    ct state { established, related } accept

    # SSH
    tcp dport 22 accept

    # gRPC (mTLS-protected)
    tcp dport 50051 accept

    # ICMP
    ip protocol icmp accept
    ip6 nexthdr icmpv6 accept
  }

  chain forward {
    type filter hook forward priority 0; policy drop;

    # Established / related return traffic to TAP devices
    ct state { established, related } accept

    # Sandbox TAP -> outbound
    iifname "tap*" accept
  }

  chain output {
    type filter hook output priority 0; policy accept;
  }
}

table ip sandchest_nat {
  chain postrouting {
    type nat hook postrouting priority 100; policy accept;

    # Masquerade sandbox traffic (172.16.0.0/16 covers all /30 slots)
    ip saddr 172.16.0.0/16 masquerade
  }
}
NFTEOF
nft -f /etc/nftables.conf && systemctl enable nftables`,
    ],
    validate: 'nft list ruleset | grep sandchest',
  },
  {
    id: 'deploy-node-daemon',
    name: 'Deploy node daemon',
    timeoutMs: 300_000, // 5 min — downloads ~27MB binary
    commands: async (ctx) => {
      const url = await presignDaemonBinary()
      const unitFileContent = [
        '[Unit]',
        'Description=Sandchest Node Daemon',
        'After=network.target',
        '',
        '[Service]',
        'Type=simple',
        'ExecStart=/usr/local/bin/sandchest-node',
        'Restart=always',
        'RestartSec=5',
        'EnvironmentFile=-/etc/sandchest/node.env',
        'Environment=RUST_LOG=info',
        'Environment=DATA_DIR=/var/sandchest',
        '',
        '[Install]',
        'WantedBy=multi-user.target',
        '', // trailing newline
      ].join('\n')
      const unitFileB64 = Buffer.from(unitFileContent).toString('base64')
      return [
        '(systemctl stop sandchest-node 2>/dev/null || true)',
        `curl -fsSL --retry 3 --retry-delay 5 '${url}' -o /usr/local/bin/sandchest-node`,
        'chmod +x /usr/local/bin/sandchest-node',
        'mkdir -p /etc/sandchest',
        `printf 'SANDCHEST_NODE_ID=${ctx.nodeId}\\n' > /etc/sandchest/node.env`,
        `(test -f /etc/sandchest/certs/server.pem && printf 'SANDCHEST_GRPC_CERT=/etc/sandchest/certs/server.pem\\nSANDCHEST_GRPC_KEY=/etc/sandchest/certs/server.key\\nSANDCHEST_GRPC_CA=/etc/sandchest/certs/ca.pem\\n' >> /etc/sandchest/node.env || true)`,
        `echo '${unitFileB64}' | base64 -d > /etc/systemd/system/sandchest-node.service`,
        'systemctl daemon-reload',
        'systemctl enable sandchest-node',
      ]
    },
    validate: 'systemctl cat sandchest-node.service > /dev/null && echo "unit ok"',
  },
  {
    id: 'start-services',
    name: 'Start services',
    commands: [
      'systemctl restart sandchest-node',
    ],
    validate: 'systemctl is-enabled sandchest-node',
  },
]
