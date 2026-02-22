import { describe, expect, test } from "bun:test";
import {
  getNodeAmiSsmParameter,
  getNodeEnvironment,
  getNodeGrpcPort,
  getNodeInstanceType,
  getNodeRootVolumeGb,
  getNodeSystemdUnit,
  getNodeUserData,
} from "./node";

describe("getNodeInstanceType", () => {
  test("uses i3.metal for production", () => {
    expect(getNodeInstanceType("production")).toBe("i3.metal");
  });

  test("uses c5.metal for non-production stages", () => {
    expect(getNodeInstanceType("dev")).toBe("c5.metal");
    expect(getNodeInstanceType("staging")).toBe("c5.metal");
  });
});

describe("getNodeRootVolumeGb", () => {
  test("returns 50 GB", () => {
    expect(getNodeRootVolumeGb()).toBe(50);
  });
});

describe("getNodeGrpcPort", () => {
  test("returns 50051", () => {
    expect(getNodeGrpcPort()).toBe(50051);
  });
});

describe("getNodeAmiSsmParameter", () => {
  test("returns AL2023 x86_64 SSM parameter path", () => {
    expect(getNodeAmiSsmParameter()).toBe(
      "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64",
    );
  });
});

describe("getNodeEnvironment", () => {
  test("sets RUST_LOG to info for production", () => {
    expect(getNodeEnvironment("production").RUST_LOG).toBe("info");
  });

  test("sets RUST_LOG to debug for non-production", () => {
    expect(getNodeEnvironment("dev").RUST_LOG).toBe("debug");
    expect(getNodeEnvironment("staging").RUST_LOG).toBe("debug");
  });

  test("sets SANDCHEST_DATA_DIR to /var/sandchest", () => {
    expect(getNodeEnvironment("dev").SANDCHEST_DATA_DIR).toBe(
      "/var/sandchest",
    );
    expect(getNodeEnvironment("production").SANDCHEST_DATA_DIR).toBe(
      "/var/sandchest",
    );
  });

  test("sets SANDCHEST_NODE_GRPC_PORT to 50051", () => {
    expect(getNodeEnvironment("dev").SANDCHEST_NODE_GRPC_PORT).toBe("50051");
    expect(getNodeEnvironment("production").SANDCHEST_NODE_GRPC_PORT).toBe(
      "50051",
    );
  });

  test("enables jailer for production", () => {
    expect(getNodeEnvironment("production").SANDCHEST_JAILER_ENABLED).toBe(
      "true",
    );
  });

  test("disables jailer for non-production", () => {
    expect(getNodeEnvironment("dev").SANDCHEST_JAILER_ENABLED).toBe("false");
    expect(getNodeEnvironment("staging").SANDCHEST_JAILER_ENABLED).toBe(
      "false",
    );
  });

  test("uses ens5 network interface", () => {
    expect(getNodeEnvironment("dev").SANDCHEST_OUTBOUND_IFACE).toBe("ens5");
  });

  test("sets bandwidth to 200 Mbps for production", () => {
    expect(getNodeEnvironment("production").SANDCHEST_BANDWIDTH_MBPS).toBe(
      "200",
    );
  });

  test("sets bandwidth to 100 Mbps for non-production", () => {
    expect(getNodeEnvironment("dev").SANDCHEST_BANDWIDTH_MBPS).toBe("100");
  });
});

describe("getNodeSystemdUnit", () => {
  const unit = getNodeSystemdUnit();

  test("has Unit section with network dependency", () => {
    expect(unit).toContain("After=network-online.target");
    expect(unit).toContain("Wants=network-online.target");
  });

  test("runs as sandchest user and group", () => {
    expect(unit).toContain("User=sandchest");
    expect(unit).toContain("Group=sandchest");
  });

  test("reads environment from /etc/sandchest/node.env", () => {
    expect(unit).toContain("EnvironmentFile=/etc/sandchest/node.env");
  });

  test("starts the sandchest-node binary", () => {
    expect(unit).toContain("ExecStart=/usr/local/bin/sandchest-node");
  });

  test("restarts on failure with 5s delay", () => {
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=5s");
  });

  test("logs to journal", () => {
    expect(unit).toContain("StandardOutput=journal");
    expect(unit).toContain("StandardError=journal");
  });

  test("raises file descriptor limit", () => {
    expect(unit).toContain("LimitNOFILE=65536");
  });

  test("grants CAP_NET_ADMIN for TAP and iptables", () => {
    expect(unit).toContain("AmbientCapabilities=CAP_NET_ADMIN");
  });

  test("targets multi-user", () => {
    expect(unit).toContain("WantedBy=multi-user.target");
  });
});

describe("getNodeUserData", () => {
  const userData = getNodeUserData("dev");

  test("starts with bash shebang and strict mode", () => {
    expect(userData).toStartWith("#!/bin/bash\nset -euo pipefail");
  });

  test("enables and starts SSM agent", () => {
    expect(userData).toContain("systemctl enable amazon-ssm-agent");
    expect(userData).toContain("systemctl start amazon-ssm-agent");
  });

  test("creates sandchest system user", () => {
    expect(userData).toContain(
      "useradd --system --shell /usr/sbin/nologin sandchest",
    );
  });

  test("creates data directories", () => {
    expect(userData).toContain(
      "mkdir -p /var/sandchest/{images,snapshots,sandboxes,jailer}",
    );
    expect(userData).toContain("chown -R sandchest:sandchest /var/sandchest");
  });

  test("writes environment file to /etc/sandchest/node.env", () => {
    expect(userData).toContain("cat > /etc/sandchest/node.env");
    expect(userData).toContain("RUST_LOG=debug");
    expect(userData).toContain("SANDCHEST_DATA_DIR=/var/sandchest");
  });

  test("writes systemd unit file", () => {
    expect(userData).toContain(
      "cat > /etc/systemd/system/sandchest-node.service",
    );
    expect(userData).toContain("ExecStart=/usr/local/bin/sandchest-node");
  });

  test("reloads systemd and enables service", () => {
    expect(userData).toContain("systemctl daemon-reload");
    expect(userData).toContain("systemctl enable sandchest-node.service");
  });

  test("includes stage-specific environment values", () => {
    const prodData = getNodeUserData("production");
    expect(prodData).toContain("RUST_LOG=info");
    expect(prodData).toContain("SANDCHEST_JAILER_ENABLED=true");
    expect(prodData).toContain("SANDCHEST_BANDWIDTH_MBPS=200");

    const devData = getNodeUserData("dev");
    expect(devData).toContain("RUST_LOG=debug");
    expect(devData).toContain("SANDCHEST_JAILER_ENABLED=false");
    expect(devData).toContain("SANDCHEST_BANDWIDTH_MBPS=100");
  });
});
