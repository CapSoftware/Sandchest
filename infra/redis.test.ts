import { describe, expect, test } from "bun:test";
import { getRedisConfig, getRedisInstance, getRedisNodes } from "./redis";

describe("getRedisInstance", () => {
  test("uses r7g.large for production", () => {
    expect(getRedisInstance("production")).toBe("r7g.large");
  });

  test("uses t4g.micro for non-production stages", () => {
    expect(getRedisInstance("dev")).toBe("t4g.micro");
    expect(getRedisInstance("staging")).toBe("t4g.micro");
    expect(getRedisInstance("preview")).toBe("t4g.micro");
  });
});

describe("getRedisNodes", () => {
  test("uses 2 nodes for production", () => {
    expect(getRedisNodes("production")).toBe(2);
  });

  test("uses 1 node for non-production stages", () => {
    expect(getRedisNodes("dev")).toBe(1);
    expect(getRedisNodes("staging")).toBe(1);
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

  test("configures production with larger instance and replication", () => {
    const config = getRedisConfig("production", mockVpc);
    expect(config.instance).toBe("r7g.large");
    expect(config.cluster.nodes).toBe(2);
  });
});
