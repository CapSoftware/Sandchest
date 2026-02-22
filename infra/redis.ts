import { isProduction } from "./vpc";

export function getRedisInstance(stage: string): string {
  return isProduction(stage) ? "r7g.large" : "t4g.micro";
}

export function getRedisNodes(stage: string): number {
  return isProduction(stage) ? 2 : 1;
}

export function getRedisConfig(stage: string, vpc: unknown) {
  return {
    engine: "valkey" as const,
    version: "7.2",
    instance: getRedisInstance(stage),
    cluster: { nodes: getRedisNodes(stage) },
    vpc,
  };
}
