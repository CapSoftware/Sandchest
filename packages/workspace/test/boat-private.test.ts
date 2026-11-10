/** BoatWorkspace's private files against a fake Boat API: no network, no real sandbox. */
import { describe, expect, test } from "bun:test";
import { BoatWorkspace } from "../src/boat";

const ID = "bx_23456789";

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown> | undefined;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fake Boat API holding files in memory. `failFolder` makes the first folder create fail. */
function fakeBoat(options: { failFolder?: boolean } = {}) {
  const calls: Call[] = [];
  const files = new Map<string, string>();
  const folders = new Map<string, string>();
  let failFolder = options.failFolder === true;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = { method: init?.method ?? "GET", path: url.pathname.replace("/api/v1", ""), query: url.searchParams, body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined };
    calls.push(call);
    const key = `${call.method} ${call.path}`;
    if (key === `GET /sandboxes/${ID}`) return json(200, { ok: true, sandbox: { id: ID, state: "ready" } });
    if (key === `POST /sandboxes/${ID}/files/folder`) {
      if (failFolder) {
        failFolder = false;
        return json(400, { ok: false, code: "bad_request", message: "no" });
      }
      folders.set(String(call.body!.path), String(call.body!.mode));
      return json(200, { ok: true });
    }
    if (key === `PUT /sandboxes/${ID}/files`) {
      files.set(String(call.body!.path), String(call.body!.content));
      return json(200, { ok: true });
    }
    if (key === `POST /sandboxes/${ID}/files/permissions`) return json(200, { ok: true });
    if (key === `GET /sandboxes/${ID}/files`) {
      const path = call.query.get("path")!;
      const content = files.get(path);
      return content === undefined ? json(404, { ok: false, code: "not_found", message: "no such file" }) : json(200, { ok: true, content, size: content.length });
    }
    return json(404, { ok: false, code: "not_found", message: `no fake route for ${key}` });
  }) as typeof fetch;
  return { calls, files, folders, options: { apiKey: "boat_test_0123456789abcdef", baseUrl: "https://boat.test/api/v1", fetch: fetchImpl, backoffMs: 0 } };
}

describe("private files", () => {
  test("go to a mode 700 directory outside the checkout and the agent directory, mode 600, and read back", async () => {
    const boat = fakeBoat();
    const workspace = await BoatWorkspace.attach(ID, boat.options);
    await workspace.writePrivateFiles([
      { name: "slice-hunt.json", content: '{"a":1}' },
      { name: "slice-verify.json", content: "[]" },
    ]);
    expect([...boat.folders]).toEqual([["/home/user/.sandchest", "700"]]);
    expect([...boat.files.keys()]).toEqual(["/home/user/.sandchest/slice-hunt.json", "/home/user/.sandchest/slice-verify.json"]);
    for (const path of boat.files.keys()) {
      expect(path.startsWith(`${workspace.root}/`)).toBe(false);
      expect(path.startsWith(`${workspace.agentDir}/`)).toBe(false);
    }
    expect(boat.calls.filter((c) => c.path.endsWith("/files/permissions")).map((c) => c.body)).toEqual([
      { path: "/home/user/.sandchest/slice-hunt.json", mode: "600" },
      { path: "/home/user/.sandchest/slice-verify.json", mode: "600" },
    ]);
    expect(await workspace.readPrivateFile("slice-hunt.json")).toBe('{"a":1}');
    expect(await workspace.readPrivateFile("missing.json")).toBeUndefined();

    // The directory is made once per workspace object; a later invocation attaches and reads the same files.
    await workspace.writePrivateFiles([{ name: "slice-confirmed.json", content: "[]" }]);
    expect(boat.calls.filter((c) => c.path.endsWith("/files/folder"))).toHaveLength(1);
    const later = await BoatWorkspace.attach(ID, boat.options);
    expect(await later.readPrivateFile("slice-verify.json")).toBe("[]");
  });

  test("refuse paths and the environment files' names", async () => {
    const workspace = await BoatWorkspace.attach(ID, fakeBoat().options);
    for (const name of ["../escape", "a/b", ".hidden", "env-123"]) {
      await expect(workspace.writePrivateFiles([{ name, content: "x" }])).rejects.toThrow("Bad private file name");
      await expect(workspace.readPrivateFile(name)).rejects.toThrow("Bad private file name");
    }
  });

  test("a failed directory create is tried again on the next write", async () => {
    const boat = fakeBoat({ failFolder: true });
    const workspace = await BoatWorkspace.attach(ID, boat.options);
    await expect(workspace.writePrivateFiles([{ name: "state.json", content: "{}" }])).rejects.toThrow();
    expect(boat.files.size).toBe(0);
    await workspace.writePrivateFiles([{ name: "state.json", content: "{}" }]);
    expect(boat.files.get("/home/user/.sandchest/state.json")).toBe("{}");
  });

  test("are refused once the workspace is destroyed", async () => {
    const boat = fakeBoat();
    const workspace = await BoatWorkspace.attach(ID, boat.options);
    await workspace.destroy().catch(() => {});
    await expect(workspace.readPrivateFile("state.json")).rejects.toThrow("destroyed");
  });
});
