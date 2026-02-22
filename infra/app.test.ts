import { describe, expect, test } from "bun:test";
import { getAppConfig } from "./app";

describe("getAppConfig", () => {
  test("returns sandchest as app name", () => {
    const config = getAppConfig("dev");
    expect(config.name).toBe("sandchest");
  });

  test("uses aws as home provider", () => {
    const config = getAppConfig("dev");
    expect(config.home).toBe("aws");
  });

  test("configures aws provider with us-east-1 region", () => {
    const config = getAppConfig("dev");
    expect(config.providers.aws.region).toBe("us-east-1");
  });

  test("retains resources in production", () => {
    const config = getAppConfig("production");
    expect(config.removal).toBe("retain");
  });

  test("removes resources in non-production stages", () => {
    expect(getAppConfig("dev").removal).toBe("remove");
    expect(getAppConfig("staging").removal).toBe("remove");
    expect(getAppConfig("preview").removal).toBe("remove");
  });

  test("protects production stage from accidental removal", () => {
    expect(getAppConfig("production").protect).toBe(true);
  });

  test("does not protect non-production stages", () => {
    expect(getAppConfig("dev").protect).toBe(false);
    expect(getAppConfig("staging").protect).toBe(false);
  });
});
