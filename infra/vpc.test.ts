import { describe, expect, test } from "bun:test";
import { getVpcConfig, getVpcNat, isProduction } from "./vpc";

describe("isProduction", () => {
  test("returns true for production stage", () => {
    expect(isProduction("production")).toBe(true);
  });

  test("returns false for non-production stages", () => {
    expect(isProduction("dev")).toBe(false);
    expect(isProduction("preview")).toBe(false);
  });
});

describe("getVpcNat", () => {
  test("uses ec2 fck-nat for all stages", () => {
    expect(getVpcNat("production")).toBe("ec2");
    expect(getVpcNat("dev")).toBe("ec2");
    expect(getVpcNat("preview")).toBe("ec2");
  });
});

describe("getVpcConfig", () => {
  test("configures 2 availability zones", () => {
    const config = getVpcConfig("dev");
    expect(config.az).toBe(2);
  });

  test("uses ec2 nat for dev stage", () => {
    const config = getVpcConfig("dev");
    expect(config.nat).toBe("ec2");
  });

  test("uses ec2 nat for production stage", () => {
    const config = getVpcConfig("production");
    expect(config.nat).toBe("ec2");
  });
});
