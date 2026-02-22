export function isProduction(stage: string): boolean {
  return stage === "production";
}

// fck-nat (ec2) for all stages. Managed NAT Gateway is ~$33/mo per AZ and not
// justified until sustained cross-AZ traffic warrants it. Return type keeps
// "managed" in the union for when we need to scale up.
export function getVpcNat(_stage: string): "managed" | "ec2" {
  return "ec2";
}

export function getVpcConfig(stage: string) {
  return {
    az: 2,
    nat: getVpcNat(stage),
  } as const;
}
