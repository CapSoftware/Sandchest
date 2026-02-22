export function isProduction(stage: string): boolean {
  return stage === "production";
}

export function getVpcNat(stage: string): "managed" | "ec2" {
  return isProduction(stage) ? "managed" : "ec2";
}

export function getVpcConfig(stage: string) {
  return {
    az: 2,
    nat: getVpcNat(stage),
  } as const;
}
