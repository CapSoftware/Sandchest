import { describe, expect, test } from "bun:test";
import { getArtifactLifecycle, getBucketConfig } from "./bucket";

describe("getArtifactLifecycle", () => {
  test("always expires tmp uploads in 1 day", () => {
    const devRules = getArtifactLifecycle("dev");
    const prodRules = getArtifactLifecycle("production");

    const devTmp = devRules.find((r) => r.id === "expire-tmp-uploads");
    const prodTmp = prodRules.find((r) => r.id === "expire-tmp-uploads");

    expect(devTmp?.expiresIn).toBe("1 day");
    expect(prodTmp?.expiresIn).toBe("1 day");
    expect(devTmp?.prefix).toBe("tmp/");
  });

  test("expires event logs after 30 days in dev", () => {
    const rules = getArtifactLifecycle("dev");
    const rule = rules.find((r) => r.id === "expire-event-logs");
    expect(rule?.expiresIn).toBe("30 days");
    expect(rule?.prefix).toBe("events/");
  });

  test("expires event logs after 365 days in production", () => {
    const rules = getArtifactLifecycle("production");
    const rule = rules.find((r) => r.id === "expire-event-logs");
    expect(rule?.expiresIn).toBe("365 days");
  });

  test("expires artifacts after 30 days in dev", () => {
    const rules = getArtifactLifecycle("dev");
    const rule = rules.find((r) => r.id === "expire-artifacts");
    expect(rule?.expiresIn).toBe("30 days");
    expect(rule?.prefix).toBe("artifacts/");
  });

  test("expires artifacts after 365 days in production", () => {
    const rules = getArtifactLifecycle("production");
    const rule = rules.find((r) => r.id === "expire-artifacts");
    expect(rule?.expiresIn).toBe("365 days");
  });

  test("returns 3 lifecycle rules", () => {
    expect(getArtifactLifecycle("dev")).toHaveLength(3);
    expect(getArtifactLifecycle("production")).toHaveLength(3);
  });
});

describe("getBucketConfig", () => {
  test("enforces https", () => {
    expect(getBucketConfig("dev").enforceHttps).toBe(true);
    expect(getBucketConfig("production").enforceHttps).toBe(true);
  });

  test("enables versioning in production", () => {
    expect(getBucketConfig("production").versioning).toBe(true);
  });

  test("disables versioning in non-production stages", () => {
    expect(getBucketConfig("dev").versioning).toBe(false);
    expect(getBucketConfig("staging").versioning).toBe(false);
  });

  test("includes lifecycle rules", () => {
    const config = getBucketConfig("dev");
    expect(config.lifecycle).toHaveLength(3);
  });
});
