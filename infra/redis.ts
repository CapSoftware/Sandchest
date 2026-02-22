import { isProduction } from "./vpc";

// Redis holds only ephemeral state (leases, rate limits, SSE buffers).
// PlanetScale is the durable source of truth, so a small instance is fine.
// t4g.small gives 1.37 GiB — plenty for the current key patterns.
export function getRedisInstance(stage: string): string {
  return isProduction(stage) ? "t4g.small" : "t4g.micro";
}

// Single node, no replication. Acceptable because all Redis data is ephemeral
// and reconstructable — a cold restart only loses in-flight rate limit windows
// and active SSE buffers. Scale to 2 nodes when uptime SLA requires it.
export function getRedisNodes(_stage: string): number {
  return 1;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- vpc is sst.aws.Vpc, unavailable outside sst.config.ts
export function getRedisConfig(stage: string, vpc: any) {
  return {
    engine: "valkey" as const,
    version: "7.2",
    instance: getRedisInstance(stage),
    cluster: { nodes: getRedisNodes(stage) },
    vpc,
  };
}
