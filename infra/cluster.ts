import { isProduction } from "./vpc";

type ServiceCpu =
  | "0.25 vCPU"
  | "0.5 vCPU"
  | "1 vCPU"
  | "2 vCPU"
  | "4 vCPU"
  | "8 vCPU"
  | "16 vCPU";

export function getServiceCpu(stage: string): ServiceCpu {
  return isProduction(stage) ? "1 vCPU" : "0.25 vCPU";
}

export function getServiceMemory(stage: string): `${number} GB` {
  return isProduction(stage) ? "2 GB" : "0.5 GB";
}

export function getServiceScaling(stage: string) {
  if (isProduction(stage)) {
    return { min: 2, max: 10, cpuUtilization: 70, memoryUtilization: 70 };
  }
  return { min: 1, max: 2, cpuUtilization: 80, memoryUtilization: 80 };
}

export function getLoadBalancerHealthCheck() {
  return {
    "3001/http": {
      path: "/healthz",
      interval: "15 seconds" as const,
      timeout: "5 seconds" as const,
    },
  };
}

export function getServiceHealthCheck() {
  return {
    path: "/healthz",
    interval: "15 seconds" as const,
    timeout: "5 seconds" as const,
  };
}

export function getServicePort() {
  return { listen: "80/http", forward: "3001/http" } as const;
}

export function getServiceDomain(stage: string): string {
  return isProduction(stage)
    ? "api.sandchest.com"
    : `${stage}.api.sandchest.com`;
}

export function getServiceRules() {
  return [
    { listen: "80/http", redirect: "443/https" },
    { listen: "443/https", forward: "3001/http" },
  ] as const;
}

export function getServiceEnvironment(stage: string) {
  return {
    PORT: "3001",
    NODE_ENV: isProduction(stage) ? "production" : "development",
    DRAIN_TIMEOUT_MS: "30000",
    BETTER_AUTH_BASE_URL: isProduction(stage)
      ? "https://api.sandchest.com"
      : `https://${stage}.api.sandchest.com`,
    RESEND_FROM_EMAIL: "Sandchest Auth <noreply@send.sandchest.com>",
  };
}
