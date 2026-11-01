import { expect, test } from "bun:test";
import { createMailer } from "../src";

test("without Resend or SMTP, nothing is sent", async () => {
  const mailer = createMailer({});
  expect(mailer.enabled).toBe(false);
  await mailer.send({ to: ["a@example.com"], subject: "s", html: "h", text: "t" });
});

test("Resend gets one request per recipient, so nobody sees who else was told", async () => {
  const bodies: Array<{ to: string[]; from: string }> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const mailer = createMailer({ RESEND_API_KEY: "k", EMAIL_FROM: "Sandchest <n@example.com>" }, fetchImpl);
  await mailer.send({ to: ["a@example.com", "b@example.com"], subject: "s", html: "h", text: "t" });
  expect(bodies.map((b) => b.to)).toEqual([["a@example.com"], ["b@example.com"]]);
  expect(bodies[0]!.from).toBe("Sandchest <n@example.com>");
});

test("a Resend error is thrown, not swallowed", async () => {
  const fetchImpl = (async () => new Response("no", { status: 422 })) as unknown as typeof fetch;
  await expect(createMailer({ RESEND_API_KEY: "k" }, fetchImpl).send({ to: ["a@example.com"], subject: "s", html: "h", text: "t" })).rejects.toThrow("Resend answered 422");
});
