import { isProduction } from "./vpc";

// C8i instances support nested virtualization (AWS launched Feb 2026), exposing
// /dev/kvm without requiring .metal instances. ~3% CPU overhead, 2-3x slower
// microVM boot vs bare metal — acceptable at current scale. Both stages use
// c8i.large (2 vCPU). Scale up to c8i.xlarge/2xlarge/4xlarge when needed.
// Fallback if deploy fails: m5zn.metal.
export function getNodeInstanceType(_stage: string): string {
  return "c8i.large";
}

// C8i has no NVMe instance storage (unlike i3.metal), so prod needs a larger
// root EBS volume to store VM images, snapshots, and sandbox working dirs.
export function getNodeRootVolumeGb(stage: string): number {
  return isProduction(stage) ? 50 : 30;
}

// Returns Record<string, unknown> because Pulumi AWS v6.66.2 InstanceCpuOptions
// doesn't include the nestedVirtualization field yet. The underlying Terraform
// provider may already support it — if not, `sst deploy` will fail at preview
// with a clear error before any resources are created.
export function getNodeCpuOptions(): Record<string, unknown> {
  return { nestedVirtualization: "enabled" };
}

export function getNodeGrpcPort(): number {
  return 50051;
}

export function getNodeAmiSsmParameter(): string {
  return "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64";
}

export function getNodeEnvironment(
  stage: string,
  bucketName: string,
): Record<string, string> {
  return {
    RUST_LOG: isProduction(stage) ? "info" : "debug",
    SANDCHEST_DATA_DIR: "/var/sandchest",
    SANDCHEST_NODE_GRPC_PORT: "50051",
    SANDCHEST_JAILER_ENABLED: isProduction(stage) ? "true" : "false",
    SANDCHEST_FIRECRACKER_BINARY: "/usr/bin/firecracker",
    SANDCHEST_JAILER_BINARY: "/usr/bin/jailer",
    SANDCHEST_OUTBOUND_IFACE: "ens5",
    SANDCHEST_BANDWIDTH_MBPS: isProduction(stage) ? "200" : "100",
    SANDCHEST_S3_BUCKET: bucketName,
    SANDCHEST_S3_REGION: "us-east-1",
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

export interface NodeLaunchTemplateConfig {
  instanceType: string;
  rootVolumeGb: number;
  cpuOptions: Record<string, unknown>;
  metadataOptions: { httpEndpoint: string; httpTokens: string };
}

export function getNodeLaunchTemplateConfig(
  stage: string,
): NodeLaunchTemplateConfig {
  return {
    instanceType: getNodeInstanceType(stage),
    rootVolumeGb: getNodeRootVolumeGb(stage),
    cpuOptions: getNodeCpuOptions(),
    metadataOptions: { httpEndpoint: "enabled", httpTokens: "required" },
  };
}

export interface NodeAsgConfig {
  minSize: number;
  maxSize: number;
  desiredCapacity: number;
  healthCheckType: string;
  healthCheckGracePeriod: number;
  defaultCooldown: number;
}

export function getNodeAsgConfig(): NodeAsgConfig {
  return {
    minSize: 1,
    maxSize: 1,
    desiredCapacity: 1,
    healthCheckType: "EC2",
    healthCheckGracePeriod: 300,
    defaultCooldown: 300,
  };
}

export function getNodeUserData(stage: string, bucketName: string): string {
  const env = getNodeEnvironment(stage, bucketName);
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
    "# Enable KVM for nested virtualization (C8i instances)",
    "# Idempotent — no-op if modules are already loaded (e.g. on .metal)",
    "modprobe kvm",
    "modprobe kvm_intel",
    "chmod 666 /dev/kvm",
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
