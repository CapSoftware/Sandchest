import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { loadAppConfig } from "../src";
import { githubRequest } from "../src/client";
import { APP_EVENTS, APP_PERMISSIONS, buildManifest, convertManifest, envBlock, ManifestError, manifestFormAction, type CreatedApp } from "../src/manifest";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

/** GitHub's answer to a conversion, trimmed to what we read plus some of what we don't. */
const conversion = {
  id: 424242,
  slug: "sandchest-acme",
  node_id: "A_kwDOexample",
  name: "Sandchest Acme",
  owner: { login: "acme", id: 1, type: "Organization" },
  html_url: "https://github.com/apps/sandchest-acme",
  permissions: APP_PERMISSIONS,
  events: [...APP_EVENTS],
  client_id: "Iv23liExample123",
  client_secret: "0123456789abcdef0123456789abcdef01234567",
  webhook_secret: "fedcba9876543210fedcba9876543210fedcba98",
  pem,
};

function fakeGitHub(answer: () => Response) {
  const requests: Array<{ url: string; method: string }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push({ url, method: init.method ?? "GET" });
    return answer();
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, requests };
}

describe("manifest", () => {
  const manifest = buildManifest({ appUrl: "https://sandchest.example.com/", redirectUrl: "https://sandchest.example.com/setup/callback", name: "  Sandchest Acme  ", public: false });

  test("points webhooks, sign-in and the post-install page at the deployment", () => {
    expect(manifest.url).toBe("https://sandchest.example.com");
    expect(manifest.hook_attributes).toEqual({ url: "https://sandchest.example.com/api/github/webhooks", active: true });
    expect(manifest.callback_urls).toEqual(["https://sandchest.example.com/api/auth/callback/github"]);
    expect(manifest.setup_url).toBe("https://sandchest.example.com/dashboard");
    expect(manifest.redirect_url).toBe("https://sandchest.example.com/setup/callback");
    expect(manifest.name).toBe("Sandchest Acme");
    expect(manifest.public).toBe(false);
    expect(manifest.request_oauth_on_install).toBe(false);
  });

  test("asks for exactly the permissions and events in SPEC §3", () => {
    expect(manifest.default_permissions).toEqual({
      contents: "read",
      metadata: "read",
      pull_requests: "write",
      checks: "write",
      issues: "read",
      members: "read",
      email_addresses: "read",
    });
    // installation and installation_repositories always arrive; GitHub rejects a manifest that lists them.
    expect(manifest.default_events).toEqual(["pull_request", "push", "issue_comment"]);
  });

  test("keeps names within GitHub's limit and never empty", () => {
    expect(buildManifest({ appUrl: "https://x.test", redirectUrl: "https://x.test/setup/callback", name: "x".repeat(50), public: true }).name).toHaveLength(34);
    expect(buildManifest({ appUrl: "https://x.test", redirectUrl: "https://x.test/setup/callback", name: "   ", public: true }).name).toBe("Sandchest");
  });

  test("posts to the person's account or to an organisation, carrying the state", () => {
    expect(manifestFormAction({ kind: "user" }, "a.b/c")).toBe("https://github.com/settings/apps/new?state=a.b%2Fc");
    expect(manifestFormAction({ kind: "org", org: "acme-corp" }, "s")).toBe("https://github.com/organizations/acme-corp/settings/apps/new?state=s");
    for (const org of ["", "-acme", "acme-", "ac--me", "acme/../evil", "evil.com", "a".repeat(40), "acme?x=1"]) {
      expect(() => manifestFormAction({ kind: "org", org }, "s")).toThrow();
    }
  });
});

describe("conversion", () => {
  test("exchanges the code once and returns the App's credentials", async () => {
    const github = fakeGitHub(() => Response.json(conversion, { status: 201 }));
    const app = await convertManifest("a1b2c3d4e5", { fetch: github.fetch, baseUrl: "https://api.github.test/" });
    expect(github.requests).toEqual([{ url: "https://api.github.test/app-manifests/a1b2c3d4e5/conversions", method: "POST" }]);
    expect(app).toEqual({
      id: 424242,
      slug: "sandchest-acme",
      name: "Sandchest Acme",
      htmlUrl: "https://github.com/apps/sandchest-acme",
      owner: "acme",
      settingsUrl: "https://github.com/organizations/acme/settings/apps/sandchest-acme",
      clientId: conversion.client_id,
      clientSecret: conversion.client_secret,
      webhookSecret: conversion.webhook_secret,
      pem,
    });
  });

  test("links a personal App to the account's own settings", async () => {
    const github = fakeGitHub(() => Response.json({ ...conversion, owner: { login: "someone", type: "User" } }, { status: 201 }));
    expect((await convertManifest("code", { fetch: github.fetch })).settingsUrl).toBe("https://github.com/settings/apps/sandchest-acme");
  });

  test("refuses codes that could change the request path", async () => {
    const github = fakeGitHub(() => Response.json(conversion));
    for (const code of ["", "../../user", "a b", "a?b", "a%2fb"]) {
      await expect(convertManifest(code, { fetch: github.fetch })).rejects.toBeInstanceOf(ManifestError);
    }
    expect(github.requests).toHaveLength(0);
  });

  test("reports GitHub's status without its body, and does not retry a spent code", async () => {
    const github = fakeGitHub(() => Response.json({ message: "Not Found", documentation_url: "https://docs.github.com" }, { status: 404 }));
    const error = (await convertManifest("used", { fetch: github.fetch }).catch((e: unknown) => e)) as ManifestError;
    expect(error).toBeInstanceOf(ManifestError);
    expect(error.status).toBe(404);
    expect(error.message).toBe("GitHub answered 404");
    expect(github.requests).toHaveLength(1);
  });

  test("rejects an answer with missing or unsafe values, without echoing them", async () => {
    for (const broken of [
      { ...conversion, pem: undefined },
      { ...conversion, webhook_secret: null },
      { ...conversion, client_secret: 'abc"; rm -rf /' },
      { ...conversion, slug: "Has Spaces" },
      { ...conversion, pem: `${pem}$(whoami)` },
      { ...conversion, html_url: "javascript:alert(1)" },
    ]) {
      const github = fakeGitHub(() => Response.json(broken, { status: 201 }));
      const error = (await convertManifest("code", { fetch: github.fetch }).catch((e: unknown) => e)) as Error;
      expect(error).toBeInstanceOf(ManifestError);
      expect(error.message).not.toContain(conversion.client_secret);
      expect(error.message).not.toContain("BEGIN");
    }
  });

  test("reports an unreachable GitHub plainly", async () => {
    const failing = (async () => {
      throw new TypeError("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;
    await expect(convertManifest("code", { fetch: failing })).rejects.toThrow("Could not reach GitHub");
  });
});

describe("env block", () => {
  const app: CreatedApp = {
    id: 424242,
    slug: "sandchest-acme",
    name: "Sandchest Acme",
    htmlUrl: "https://github.com/apps/sandchest-acme",
    owner: "acme",
    settingsUrl: "https://github.com/organizations/acme/settings/apps/sandchest-acme",
    clientId: conversion.client_id,
    clientSecret: conversion.client_secret,
    webhookSecret: conversion.webhook_secret,
    pem,
  };
  const block = envBlock(app);

  test("lists every variable the App needs, one per line", () => {
    const names = block.split("\n").map((line) => line.slice(0, line.indexOf("=")));
    expect(names).toEqual(["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GITHUB_WEBHOOK_SECRET", "GITHUB_APP_PRIVATE_KEY"]);
    expect(block).toContain("GITHUB_APP_ID=424242\n");
  });

  test("the private key survives the round trip through an env file", () => {
    const line = block.split("\n").find((l) => l.startsWith("GITHUB_APP_PRIVATE_KEY="))!;
    // As a dashboard or a single-quoted env file passes it: literal \n, which loadAppConfig expands.
    const literal = line.slice("GITHUB_APP_PRIVATE_KEY=".length).replace(/^"|"$/g, "");
    expect(loadAppConfig({ GITHUB_APP_ID: "1", GITHUB_WEBHOOK_SECRET: "s", GITHUB_APP_PRIVATE_KEY: literal }).privateKey).toBe(pem);
    // As Docker Compose reads a double-quoted value: \n becomes a newline.
    const expanded = literal.replace(/\\n/g, "\n");
    expect(expanded).toBe(pem);
  });
});

describe("API base URL", () => {
  test("requests go to the configured base, and GitHub's own absolute links are followed", async () => {
    const github = fakeGitHub(() => Response.json({ ok: true }));
    await githubRequest(async () => "t", "/app", {}, { fetch: github.fetch, baseUrl: "http://fake-github:4010/" });
    await githubRequest(async () => "t", "http://fake-github:4010/next?page=2", {}, { fetch: github.fetch, baseUrl: "http://fake-github:4010" });
    await githubRequest(async () => "t", "/app", {}, { fetch: github.fetch });
    expect(github.requests.map((r) => r.url)).toEqual(["http://fake-github:4010/app", "http://fake-github:4010/next?page=2", "https://api.github.com/app"]);
  });
});
