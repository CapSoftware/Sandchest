/**
 * The GitHub webhook route's body handling against a real Postgres: a
 * request without a well-formed signature, or with a body over GitHub's own
 * 25 MB payload cap, is refused before the body is read in full or hashed,
 * and signed deliveries up to that cap are still handled.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import postgres from "postgres";
import { createDb, type Db } from "@sandchest/db";
import { migrate } from "@sandchest/db/migrate";
import { POST } from "@/app/api/github/webhooks/route";
import { resetConfig } from "@/server/config";
import { setServices } from "@/server/services";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
const NAME = `sandchest_github_webhooks_test_${process.pid}`;
const SECRET = "github-webhooks-test-secret";
const CAP = 25 * 1024 * 1024;
const URL_ = "https://sandchest.test/api/github/webhooks";

let admin: postgres.Sql | undefined;
let database: Db;
let available = true;
const saved = { ...process.env };

beforeAll(async () => {
  try {
    admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${NAME}`);
  } catch {
    available = false;
    return;
  }
  const url = new URL(ADMIN_URL);
  url.pathname = `/${NAME}`;
  Object.assign(process.env, {
    DATABASE_URL: url.toString(),
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: "unused",
    GITHUB_WEBHOOK_SECRET: SECRET,
    SANDCHEST_APP_URL: "https://sandchest.test",
  });
  resetConfig();
  database = createDb(url.toString(), { max: 4 });
  await migrate(database);
  setServices({ db: database });
});

afterAll(async () => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  resetConfig();
  if (!available) return;
  await database.$client.end();
  await admin!.unsafe(`drop database if exists ${NAME} with (force)`);
  await admin!.end();
});

const sign = (body: string | Uint8Array) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
const BOGUS = `sha256=${"de".repeat(32)}`;

/**
 * A body streamed in 64 KB chunks with no length up front, the way a chunked
 * upload arrives, counting how much of it the route pulled.
 */
function streamed(total: number) {
  const chunk = new Uint8Array(64 * 1024).fill(0x20);
  const seen = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (seen.pulled >= total) return controller.close();
      const next = chunk.subarray(0, Math.min(chunk.length, total - seen.pulled));
      seen.pulled += next.length;
      controller.enqueue(next);
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { body, seen };
}

function post(body: BodyInit, headers: Record<string, string>): Request {
  return new Request(URL_, { method: "POST", body, headers: { "content-type": "application/json", ...headers }, duplex: "half" } as RequestInit);
}

describe.skipIf(!available)("GitHub webhook bodies", () => {
  test("a missing or malformed signature is refused before the body is read", async () => {
    for (const signature of [undefined, "sha256=", "sha1=abc", BOGUS.slice(0, -2), `${BOGUS}00`, `sha256=${"zz".repeat(32)}`]) {
      const { body, seen } = streamed(CAP);
      const headers: Record<string, string> = { "x-github-event": "ping", "x-github-delivery": "d-malformed" };
      if (signature !== undefined) headers["x-hub-signature-256"] = signature;
      const response = await POST(post(body, headers));
      expect(response.status).toBe(401);
      expect(seen.pulled).toBeLessThanOrEqual(64 * 1024);
    }
  });

  test("a declared length over the cap is refused with 413 before the body is read or hashed", async () => {
    const { body, seen } = streamed(CAP + 1);
    const response = await POST(post(body, { "content-length": String(CAP + 1), "x-hub-signature-256": BOGUS, "x-github-event": "push", "x-github-delivery": "d-declared" }));
    expect(response.status).toBe(413);
    expect(seen.pulled).toBeLessThanOrEqual(64 * 1024);
  });

  test("a chunked body that runs past the cap is cut off there with 413, not read to the end", async () => {
    const { body, seen } = streamed(CAP * 4);
    const response = await POST(post(body, { "x-hub-signature-256": BOGUS, "x-github-event": "push", "x-github-delivery": "d-chunked" }));
    expect(response.status).toBe(413);
    expect(seen.pulled).toBeLessThanOrEqual(CAP + 2 * 64 * 1024);
    expect(seen.cancelled).toBe(true);
  });

  test("a body one byte over the cap is refused with 413 even when correctly signed", async () => {
    const bytes = new Uint8Array(CAP + 1).fill(0x20);
    const { body } = streamed(CAP + 1);
    const response = await POST(post(body, { "x-hub-signature-256": sign(bytes), "x-github-event": "ping", "x-github-delivery": "d-over" }));
    expect(response.status).toBe(413);
  });

  test("signed deliveries, small and large, are still verified against their exact bytes and handled", async () => {
    const small = JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 1 });
    const ok = await POST(post(small, { "x-hub-signature-256": sign(small), "x-github-event": "ping", "x-github-delivery": "d-small" }));
    expect(ok.status).toBe(202);
    expect(await ok.json()).toMatchObject({ status: "ignored" });

    // Several megabytes, far over the 256 KB other webhooks allow, as a large push can be; with non-ASCII text.
    const large = JSON.stringify({ zen: "é".repeat(3 * 1024 * 1024), hook_id: 2 });
    const big = await POST(post(large, { "x-hub-signature-256": sign(large), "x-github-event": "ping", "x-github-delivery": "d-large" }));
    expect(big.status).toBe(202);

    const altered = await POST(post(`${small} `, { "x-hub-signature-256": sign(small), "x-github-event": "ping", "x-github-delivery": "d-altered" }));
    expect(altered.status).toBe(401);
  });

  test("a signed delivery without its event headers is still a 400", async () => {
    const body = "{}";
    expect((await POST(post(body, { "x-hub-signature-256": sign(body) }))).status).toBe(400);
  });
});
