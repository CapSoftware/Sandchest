export const GITHUB_OIDC_PROVIDER_URL =
  "https://token.actions.githubusercontent.com";

// Trust policy condition keys use the issuer hostname without the https:// scheme.
// AWS IAM evaluates OIDC conditions against the bare hostname, not the full URL.
export const GITHUB_OIDC_ISSUER = "token.actions.githubusercontent.com";

export const GITHUB_OIDC_THUMBPRINTS = [
  "6938fd4d98bab03faadb97b34396831e3780aea1",
  "1c58a3a8518e8759bf075b76b750d4f2df264fcd",
];

export const GITHUB_OIDC_AUDIENCE = "sts.amazonaws.com";

export const GITHUB_REPO = "CapSoftware/Sandchest";

export function getDeployRoleName(stage: string): string {
  return `sandchest-deploy-${stage}`;
}

export function getDeployRoleTrustPolicy(
  providerArn: string,
  repo: string,
): Record<string, unknown> {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Federated: providerArn },
        Action: "sts:AssumeRoleWithWebIdentity",
        Condition: {
          StringEquals: {
            [`${GITHUB_OIDC_ISSUER}:aud`]: GITHUB_OIDC_AUDIENCE,
          },
          StringLike: {
            [`${GITHUB_OIDC_ISSUER}:sub`]: `repo:${repo}:*`,
          },
        },
      },
    ],
  };
}
