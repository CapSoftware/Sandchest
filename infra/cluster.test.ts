import { describe, expect, test } from "bun:test";
import {
  getServiceCpu,
  getServiceEnvironment,
  getServiceHealthCheck,
  getServiceMemory,
  getServicePort,
  getServiceScaling,
} from "./cluster";

describe("getServiceCpu", () => {
  test("uses 1 vCPU for production", () => {
    expect(getServiceCpu("production")).toBe("1 vCPU");
  });

  test("uses 0.25 vCPU for non-production stages", () => {
    expect(getServiceCpu("dev")).toBe("0.25 vCPU");
    expect(getServiceCpu("staging")).toBe("0.25 vCPU");
    expect(getServiceCpu("preview")).toBe("0.25 vCPU");
  });
});

describe("getServiceMemory", () => {
  test("uses 2 GB for production", () => {
    expect(getServiceMemory("production")).toBe("2 GB");
  });

  test("uses 0.5 GB for non-production stages", () => {
    expect(getServiceMemory("dev")).toBe("0.5 GB");
    expect(getServiceMemory("staging")).toBe("0.5 GB");
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

describe("getServiceHealthCheck", () => {
  test("uses /healthz endpoint", () => {
    expect(getServiceHealthCheck().path).toBe("/healthz");
  });

  test("checks every 15 seconds", () => {
    expect(getServiceHealthCheck().interval).toBe("15 seconds");
  });

  test("times out after 5 seconds", () => {
    expect(getServiceHealthCheck().timeout).toBe("5 seconds");
  });
});

describe("getServicePort", () => {
  test("listens on port 80 HTTP", () => {
    expect(getServicePort().listen).toBe("80/http");
  });

  test("forwards to port 3001 HTTP", () => {
    expect(getServicePort().forward).toBe("3001/http");
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
    expect(getServiceEnvironment("staging").NODE_ENV).toBe("development");
  });

  test("sets DRAIN_TIMEOUT_MS to 30000", () => {
    expect(getServiceEnvironment("dev").DRAIN_TIMEOUT_MS).toBe("30000");
    expect(getServiceEnvironment("production").DRAIN_TIMEOUT_MS).toBe("30000");
  });
});
