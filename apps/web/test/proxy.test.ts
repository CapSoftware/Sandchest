/**
 * The proxy in front of the dashboard: signed-out visitors are sent to sign
 * in, remembering where they were going; anyone with a session cookie goes on
 * (every page still verifies the session itself).
 */
import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { config, proxy } from "@/proxy";

function request(path: string, cookie?: string): NextRequest {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  return new NextRequest(new URL(path, "http://sandchest.test"), { headers });
}

const isNext = (response: Response) => response.headers.get("x-middleware-next") === "1";

describe("matcher", () => {
  test("runs only on the dashboard, never on the static landing, docs and legal pages", () => {
    expect(config.matcher).toEqual(["/dashboard/:path*"]);
  });
});

describe("proxy", () => {
  test("sends signed-out visitors to sign in, with where they were going", async () => {
    const response = await proxy(request("/dashboard?x=1"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://sandchest.test/sign-in?next=%2Fdashboard%3Fx%3D1");
    const deep = await proxy(request("/dashboard/findings/0b5e9a6c-1f2d-4e3a-9b8c-7d6e5f4a3b2c"));
    expect(deep.headers.get("location")).toBe("http://sandchest.test/sign-in?next=%2Fdashboard%2Ffindings%2F0b5e9a6c-1f2d-4e3a-9b8c-7d6e5f4a3b2c");
  });

  test("lets anyone with a session cookie through", async () => {
    expect(isNext(await proxy(request("/dashboard/findings", "better-auth.session_token=anything")))).toBe(true);
  });
});
