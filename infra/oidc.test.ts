import { describe, expect, test } from "bun:test";
import {
  GITHUB_OIDC_AUDIENCE,
  GITHUB_OIDC_PROVIDER_URL,
  GITHUB_OIDC_THUMBPRINTS,
  GITHUB_REPO,
  getDeployRoleName,
  getDeployRoleTrustPolicy,
} from "./oidc";

describe("OIDC constants", () => {
  test("provider URL is GitHub OIDC endpoint", () => {
    expect(GITHUB_OIDC_PROVIDER_URL).toBe(
      "https://token.actions.githubusercontent.com",
    );
  });

  test("audience is STS", () => {
    expect(GITHUB_OIDC_AUDIENCE).toBe("sts.amazonaws.com");
  });

  test("thumbprints are valid 40-char hex strings", () => {
    expect(GITHUB_OIDC_THUMBPRINTS.length).toBeGreaterThanOrEqual(1);
    for (const thumb of GITHUB_OIDC_THUMBPRINTS) {
      expect(thumb).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  test("repo matches CapSoftware/Sandchest", () => {
    expect(GITHUB_REPO).toBe("CapSoftware/Sandchest");
  });
});

describe("getDeployRoleName", () => {
  test("includes stage suffix", () => {
    expect(getDeployRoleName("production")).toBe("sandchest-deploy-production");
    expect(getDeployRoleName("dev")).toBe("sandchest-deploy-dev");
    expect(getDeployRoleName("staging")).toBe("sandchest-deploy-staging");
  });
});

describe("getDeployRoleTrustPolicy", () => {
  const providerArn =
    "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com";
  const policy = getDeployRoleTrustPolicy(providerArn, GITHUB_REPO);
  const statement = (policy as { Statement: Array<Record<string, unknown>> })
    .Statement[0];

  test("uses 2012-10-17 policy version", () => {
    expect(policy).toHaveProperty("Version", "2012-10-17");
  });

  test("allows AssumeRoleWithWebIdentity", () => {
    expect(statement.Action).toBe("sts:AssumeRoleWithWebIdentity");
    expect(statement.Effect).toBe("Allow");
  });

  test("trusts the OIDC provider ARN", () => {
    const principal = statement.Principal as Record<string, string>;
    expect(principal.Federated).toBe(providerArn);
  });

  test("requires STS audience", () => {
    const condition = statement.Condition as Record<
      string,
      Record<string, string>
    >;
    expect(
      condition.StringEquals[
        "https://token.actions.githubusercontent.com:aud"
      ],
    ).toBe("sts.amazonaws.com");
  });

  test("scopes to the correct repo", () => {
    const condition = statement.Condition as Record<
      string,
      Record<string, string>
    >;
    expect(
      condition.StringLike["https://token.actions.githubusercontent.com:sub"],
    ).toBe(`repo:${GITHUB_REPO}:*`);
  });

  test("has exactly one statement", () => {
    const statements = (
      policy as { Statement: Array<Record<string, unknown>> }
    ).Statement;
    expect(statements).toHaveLength(1);
  });
});
