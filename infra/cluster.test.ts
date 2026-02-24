import { describe, expect, test } from "bun:test";
import {
  getServiceCpu,
  getServiceDomain,
  getServiceEnvironment,
  getLoadBalancerHealthCheck,
  getServiceMemory,
  getServiceRules,
  getServiceScaling,
} from "./cluster";

describe("getServiceCpu", () => {
  test("uses 1 vCPU for production", () => {
    expect(getServiceCpu("production")).toBe("1 vCPU");
  });

  test("uses 0.25 vCPU for non-production stages", () => {
    expect(getServiceCpu("dev")).toBe("0.25 vCPU");
    expect(getServiceCpu("preview")).toBe("0.25 vCPU");
  });
});

describe("getServiceMemory", () => {
  test("uses 2 GB for production", () => {
    expect(getServiceMemory("production")).toBe("2 GB");
  });

  test("uses 0.5 GB for non-production stages", () => {
    expect(getServiceMemory("dev")).toBe("0.5 GB");
    expect(getServiceMemory("preview")).toBe("0.5 GB");
  });
});

describe("getServiceScaling", () => {
  test("production scales from 2 to 10 tasks", () => {
    const scaling = getServiceScaling("production");
    expect(scaling.min).toBe(2);
    expect(scaling.max).toBe(10);
  });

  test("production targets 70% utilization", () => {
    const scaling = getServiceScaling("production");
    expect(scaling.cpuUtilization).toBe(70);
    expect(scaling.memoryUtilization).toBe(70);
  });

  test("dev scales from 1 to 2 tasks", () => {
    const scaling = getServiceScaling("dev");
    expect(scaling.min).toBe(1);
    expect(scaling.max).toBe(2);
  });

  test("dev targets 80% utilization", () => {
    const scaling = getServiceScaling("dev");
    expect(scaling.cpuUtilization).toBe(80);
    expect(scaling.memoryUtilization).toBe(80);
  });
});

describe("getLoadBalancerHealthCheck", () => {
  test("uses /healthz endpoint on 3001/http", () => {
    const health = getLoadBalancerHealthCheck();
    expect(health["3001/http"].path).toBe("/healthz");
  });

  test("checks every 15 seconds", () => {
    const health = getLoadBalancerHealthCheck();
    expect(health["3001/http"].interval).toBe("15 seconds");
  });

  test("times out after 5 seconds", () => {
    const health = getLoadBalancerHealthCheck();
    expect(health["3001/http"].timeout).toBe("5 seconds");
  });
});

describe("getServiceDomain", () => {
  test("uses api.sandchest.com for production", () => {
    expect(getServiceDomain("production")).toBe("api.sandchest.com");
  });

  test("uses stage-prefixed domain for non-production", () => {
    expect(getServiceDomain("dev")).toBe("dev.api.sandchest.com");
  });
});

describe("getServiceRules", () => {
  test("redirects HTTP to HTTPS", () => {
    const rules = getServiceRules();
    const redirect = rules.find((r) => "redirect" in r);
    expect(redirect?.listen).toBe("80/http");
    expect(redirect && "redirect" in redirect ? redirect.redirect : undefined).toBe("443/https");
  });

  test("forwards HTTPS to port 3001 HTTP", () => {
    const rules = getServiceRules();
    const forward = rules.find((r) => "forward" in r);
    expect(forward?.listen).toBe("443/https");
    expect(forward && "forward" in forward ? forward.forward : undefined).toBe("3001/http");
  });

  test("returns exactly 2 rules", () => {
    expect(getServiceRules()).toHaveLength(2);
  });
});

describe("getServiceEnvironment", () => {
  test("sets PORT to 3001", () => {
    expect(getServiceEnvironment("dev").PORT).toBe("3001");
    expect(getServiceEnvironment("production").PORT).toBe("3001");
  });

  test("sets NODE_ENV to production for production stage", () => {
    expect(getServiceEnvironment("production").NODE_ENV).toBe("production");
  });

  test("sets NODE_ENV to development for non-production stages", () => {
    expect(getServiceEnvironment("dev").NODE_ENV).toBe("development");
  });

  test("sets DRAIN_TIMEOUT_MS to 30000", () => {
    expect(getServiceEnvironment("dev").DRAIN_TIMEOUT_MS).toBe("30000");
    expect(getServiceEnvironment("production").DRAIN_TIMEOUT_MS).toBe("30000");
  });

  test("sets production BETTER_AUTH_BASE_URL to api.sandchest.com", () => {
    expect(getServiceEnvironment("production").BETTER_AUTH_BASE_URL).toBe(
      "https://api.sandchest.com",
    );
  });

  test("sets non-production BETTER_AUTH_BASE_URL with stage prefix", () => {
    expect(getServiceEnvironment("dev").BETTER_AUTH_BASE_URL).toBe(
      "https://dev.api.sandchest.com",
    );
  });

  test("sets RESEND_FROM_EMAIL", () => {
    expect(getServiceEnvironment("dev").RESEND_FROM_EMAIL).toBe(
      "Sandchest Auth <noreply@send.sandchest.com>",
    );
    expect(getServiceEnvironment("production").RESEND_FROM_EMAIL).toBe(
      "Sandchest Auth <noreply@send.sandchest.com>",
    );
  });
});
