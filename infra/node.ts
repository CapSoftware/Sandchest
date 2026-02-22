import { isProduction } from "./vpc";

export function getNodeInstanceType(stage: string): string {
  return isProduction(stage) ? "i3.metal" : "c5.metal";
}

export function getNodeRootVolumeGb(): number {
  return 50;
}

export function getNodeGrpcPort(): number {
  return 50051;
}

export function getNodeAmiSsmParameter(): string {
  return "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64";
}

export function getNodeEnvironment(stage: string): Record<string, string> {
  return {
    RUST_LOG: isProduction(stage) ? "info" : "debug",
    SANDCHEST_DATA_DIR: "/var/sandchest",
    SANDCHEST_NODE_GRPC_PORT: "50051",
    SANDCHEST_JAILER_ENABLED: isProduction(stage) ? "true" : "false",
    SANDCHEST_FIRECRACKER_BINARY: "/usr/bin/firecracker",
    SANDCHEST_JAILER_BINARY: "/usr/bin/jailer",
    SANDCHEST_OUTBOUND_IFACE: "ens5",
    SANDCHEST_BANDWIDTH_MBPS: isProduction(stage) ? "200" : "100",
  };
}

export function getNodeSystemdUnit(): string {
  return [
    "[Unit]",
    "Description=Sandchest Node Daemon",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    "User=sandchest",
    "Group=sandchest",
    "EnvironmentFile=/etc/sandchest/node.env",
    "ExecStart=/usr/local/bin/sandchest-node",
    "Restart=on-failure",
    "RestartSec=5s",
    "StandardOutput=journal",
    "StandardError=journal",
    "LimitNOFILE=65536",
    "AmbientCapabilities=CAP_NET_ADMIN",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
  ].join("\n");
}

export function getNodeUserData(stage: string): string {
  const env = getNodeEnvironment(stage);
  const envFileLines = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const unit = getNodeSystemdUnit();

  return [
    "#!/bin/bash",
    "set -euo pipefail",
    "",
    "# SSM Agent is pre-installed on Amazon Linux 2023",
    "systemctl enable amazon-ssm-agent",
    "systemctl start amazon-ssm-agent",
    "",
    "# Create sandchest system user",
    "useradd --system --shell /usr/sbin/nologin sandchest || true",
    "",
    "# Create data directories",
    "mkdir -p /var/sandchest/{images,snapshots,sandboxes,jailer}",
    "chown -R sandchest:sandchest /var/sandchest",
    "",
    "# Write environment file",
    "mkdir -p /etc/sandchest",
    "cat > /etc/sandchest/node.env << 'ENVEOF'",
    envFileLines,
    "ENVEOF",
    "",
    "# Write systemd unit file",
    "cat > /etc/systemd/system/sandchest-node.service << 'UNITEOF'",
    unit,
    "UNITEOF",
    "",
    "# Reload and enable (binary deployed separately)",
    "systemctl daemon-reload",
    "systemctl enable sandchest-node.service",
  ].join("\n");
}
