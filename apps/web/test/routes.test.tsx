/**
 * Routing that happens before any page or function runs: the landing page
 * chosen by the session cookie, and the old dashboard links redirected to
 * /dashboard. Matched with Next's own path matcher.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { navLinks } from "@/components/app/app-header";
import { currentSection } from "@/components/app/nav";
import { SiteHeader } from "@/components/site-chrome";
import { appRedirects, homeRewrites, SESSION_COOKIES } from "@/lib/app-routes";
import { site } from "@/lib/site";
import { resetConfig } from "@/server/config";
import { sessionCookieName } from "@/server/session-token";

const ENV = { DATABASE_URL: "postgres://x", GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "k", GITHUB_WEBHOOK_SECRET: "s" };

afterEach(() => resetConfig());

/** Where a redirect rule sends a path, or undefined if no rule matches (first match wins, as in Next). */
function redirected(path: string): string | undefined {
  for (const rule of appRedirects) {
    const params = getPathMatch(rule.source)(path);
    if (params) return rule.destination.replace(/:(\w+)/g, (_, name: string) => String(params[name]));
  }
  return undefined;
}

describe("landing page", () => {
  test("is chosen by better-auth's own session cookie, over https and over http", () => {
    for (const [url, index] of [["https://sandchest.test", 0], ["http://localhost:3000", 1]] as const) {
      Object.assign(process.env, ENV, { SANDCHEST_APP_URL: url });
      resetConfig();
      expect(sessionCookieName()).toBe(SESSION_COOKIES[index]);
    }
    expect(homeRewrites).toEqual(SESSION_COOKIES.map((key) => ({ source: "/", has: [{ type: "cookie", key }], destination: "/home" })));
  });

  test("Get started opens recruiting at its first step, where signing in with GitHub is the way on", () => {
    expect(site.links.getStarted).toBe("/get-started");
    expect(site.links.signIn).toBe("/sign-in");
  });

  test("shows a Dashboard key to people with a session and Sign in to everyone else", () => {
    const signedIn = renderToStaticMarkup(<SiteHeader visitor="signed-in" />);
    expect(signedIn).toContain('href="/dashboard"');
    expect(signedIn).toContain(">Dashboard<");
    expect(signedIn).not.toContain("Sign in");

    const signedOut = renderToStaticMarkup(<SiteHeader visitor="signed-out" />);
    expect(signedOut).toContain('<a href="/sign-in" data-track="nav-sign-in">Sign in</a>');
    expect(signedOut).not.toContain("Dashboard");

    // Docs and legal pages are one static page for everyone: neither.
    const docs = renderToStaticMarkup(<SiteHeader current="docs" />);
    expect(docs).not.toContain("Sign in");
    expect(docs).not.toContain("Dashboard");
  });
});

describe("old dashboard links", () => {
  test("redirect for good to the same page under /dashboard", () => {
    const id = "0b5e9a6c-1f2d-4e3a-9b8c-7d6e5f4a3b2c";
    expect(redirected("/repos")).toBe("/dashboard/repos");
    expect(redirected("/findings")).toBe("/dashboard/findings");
    expect(redirected(`/findings/${id}`)).toBe(`/dashboard/findings/${id}`);
    expect(redirected(`/scans/${id}`)).toBe(`/dashboard/scans/${id}`);
    expect(redirected("/settings")).toBe("/dashboard/settings");
    expect(redirected("/billing/confirm")).toBe("/dashboard/billing/confirm");
    expect(redirected("/billing/return")).toBe("/dashboard/billing/return");
    expect(appRedirects.filter((rule) => rule.source !== "/home").every((rule) => rule.permanent)).toBe(true);
  });

  test("leave everything else alone, and /home is never a page of its own", () => {
    for (const path of ["/", "/dashboard", "/dashboard/findings", "/docs", "/docs/findings", "/sign-in", "/billing/other", "/findings/a/b", "/repositories"]) {
      expect(redirected(path)).toBeUndefined();
    }
    expect(redirected("/home")).toBe("/");
  });
});

describe("dashboard nav", () => {
  test("lights exactly one section on every dashboard page", () => {
    const id = "0b5e9a6c-1f2d-4e3a-9b8c-7d6e5f4a3b2c";
    const links = navLinks(true);
    const cases: Array<[string, string | undefined]> = [
      ["/dashboard", "/dashboard"],
      ["/dashboard/scans", "/dashboard/scans"],
      [`/dashboard/scans/${id}`, "/dashboard/scans"],
      ["/dashboard/repos", "/dashboard/repos"],
      [`/dashboard/repos/${id}`, "/dashboard/repos"],
      ["/dashboard/findings", "/dashboard/findings"],
      [`/dashboard/findings/${id}`, "/dashboard/findings"],
      ["/dashboard/settings", "/dashboard/settings"],
      ["/dashboard/billing/confirm", "/dashboard"],
      ["/admin/cost", "/admin"],
      ["/dashboardx", undefined],
    ];
    for (const [path, section] of cases) expect([path, currentSection(path, links)]).toEqual([path, section]);
  });
});
