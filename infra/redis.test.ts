import { describe, expect, test } from "bun:test";
import {
  getRedisCacheClusterSuffix,
  getRedisConfig,
  getRedisInstance,
  getRedisNodes,
} from "./redis";

describe("getRedisInstance", () => {
  test("uses t4g.small for production", () => {
    expect(getRedisInstance("production")).toBe("t4g.small");
  });

  test("uses t4g.micro for non-production stages", () => {
    expect(getRedisInstance("dev")).toBe("t4g.micro");
    expect(getRedisInstance("preview")).toBe("t4g.micro");
  });
});

describe("getRedisNodes", () => {
  test("uses 1 node for all stages", () => {
    expect(getRedisNodes("production")).toBe(1);
    expect(getRedisNodes("dev")).toBe(1);
  });
});

describe("getRedisCacheClusterSuffix", () => {
  test("returns -001 for single-node cluster", () => {
    expect(getRedisCacheClusterSuffix()).toBe("-001");
  });
});

describe("getRedisConfig", () => {
  const mockVpc = { id: "vpc-123" };

  test("uses valkey engine", () => {
    const config = getRedisConfig("dev", mockVpc);
    expect(config.engine).toBe("valkey");
  });

  test("uses version 7.2", () => {
    const config = getRedisConfig("dev", mockVpc);
    expect(config.version).toBe("7.2");
  });

  test("passes vpc through", () => {
    const config = getRedisConfig("dev", mockVpc);
    expect(config.vpc).toBe(mockVpc);
  });

  test("configures dev with small instance and single node", () => {
    const config = getRedisConfig("dev", mockVpc);
    expect(config.instance).toBe("t4g.micro");
    expect(config.cluster.nodes).toBe(1);
  });

  test("configures production with small instance and single node", () => {
    const config = getRedisConfig("production", mockVpc);
    expect(config.instance).toBe("t4g.small");
    expect(config.cluster.nodes).toBe(1);
  });
});
