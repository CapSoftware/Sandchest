import { isProduction } from "./vpc";

export function getServiceCpu(stage: string): string {
  return isProduction(stage) ? "1 vCPU" : "0.25 vCPU";
}

export function getServiceMemory(stage: string): string {
  return isProduction(stage) ? "2 GB" : "0.5 GB";
}

export function getServiceScaling(stage: string) {
  if (isProduction(stage)) {
    return { min: 2, max: 10, cpuUtilization: 70, memoryUtilization: 70 };
  }
  return { min: 1, max: 2, cpuUtilization: 80, memoryUtilization: 80 };
}

export function getServiceHealthCheck() {
  return {
    path: "/healthz",
    interval: "15 seconds",
    timeout: "5 seconds",
  } as const;
}

export function getServicePort() {
  return { listen: "80/http", forward: "3001/http" } as const;
}

export function getServiceEnvironment(stage: string) {
  return {
    PORT: "3001",
    NODE_ENV: isProduction(stage) ? "production" : "development",
    DRAIN_TIMEOUT_MS: "30000",
  };
}
