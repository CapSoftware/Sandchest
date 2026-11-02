import { describe, expect, test } from "bun:test";
import { createStripe, formEncode, StripeError } from "../src/stripe";

function fake(respond: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const doFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const { status = 200, body } = respond(url, init);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, client: createStripe({ secretKey: "sk_test_x", fetch: doFetch }) };
}

const intent = { id: "seti_1", status: "succeeded", customer: "cus_1", payment_method: "pm_1", client_secret: "seti_1_secret_x", metadata: { sandchest_org: "o" } };

describe("stripe", () => {
  test("form encoding nests and skips undefined", () => {
    expect(formEncode({ a: 1, b: { c: "x y", d: undefined }, e: ["card"] })).toEqual(["a=1", "b%5Bc%5D=x%20y", "e%5B0%5D=card"]);
  });

  test("a SetupIntent is for cards, off session, on the customer", async () => {
    const { calls, client } = fake(() => ({ body: intent }));
    const created = await client.createSetupIntent({ customer: "cus_1", metadata: { sandchest_org: "o" } });
    expect(created).toEqual({ id: "seti_1", status: "succeeded", customer: "cus_1", paymentMethod: "pm_1", clientSecret: "seti_1_secret_x", metadata: { sandchest_org: "o" } });
    const body = decodeURIComponent(String(calls[0]!.init.body));
    expect(calls[0]!.url).toBe("https://api.stripe.com/v1/setup_intents");
    expect(body).toContain("customer=cus_1");
    expect(body).toContain("usage=off_session");
    expect(body).toContain("payment_method_types[0]=card");
    expect(body).toContain("metadata[sandchest_org]=o");
  });

  test("only SetupIntent ids are read", async () => {
    const { calls, client } = fake(() => ({ body: intent }));
    await expect(client.setupIntent("../customers/cus_1")).rejects.toBeInstanceOf(StripeError);
    expect(calls).toHaveLength(0);
    expect((await client.setupIntent("seti_1")).status).toBe("succeeded");
  });

  test("a business address goes on the customer, with empty optional lines cleared", async () => {
    const { calls, client } = fake(() => ({ body: {} }));
    await client.updateCustomer("cus_1", { name: "Acme Ltd", address: { line1: "1 Example Street", city: "London", postal_code: "N1 1AA", country: "GB" } });
    const body = decodeURIComponent(String(calls[0]!.init.body));
    expect(body).toContain("name=Acme Ltd");
    expect(body).toContain("address[line1]=1 Example Street");
    expect(body).toContain("address[line2]=&");
    expect(body).toContain("address[country]=GB");
  });

  test("a tax ID replaces the customer's others; the same one isn't added twice", async () => {
    const existing = [
      { id: "txi_old", type: "eu_vat", value: "DE111111111" },
      { id: "txi_same", type: "gb_vat", value: "GB123456789" },
    ];
    const { calls, client } = fake((url) => ({ body: url.includes("?limit") ? { data: existing } : {} }));
    await client.setTaxId("cus_1", { type: "gb_vat", value: "GB123456789" });
    expect(calls.map((c) => `${c.init.method} ${c.url.replace("https://api.stripe.com/v1/", "")}`)).toEqual([
      "GET customers/cus_1/tax_ids?limit=100",
      "DELETE customers/cus_1/tax_ids/txi_old",
    ]);
  });

  test("a new tax ID is added before the old ones go, so a rejected one leaves them", async () => {
    const { calls, client } = fake((url, init) =>
      url.includes("?limit") ? { body: { data: [{ id: "txi_old", type: "us_ein", value: "12-3456789" }] } } : init.method === "POST" ? { status: 400, body: { error: { message: "Invalid value", code: "tax_id_invalid" } } } : { body: {} },
    );
    const failed = await client.setTaxId("cus_1", { type: "eu_vat", value: "nope" }).catch((error: StripeError) => error.code);
    expect(failed).toBe("tax_id_invalid");
    expect(calls.some((c) => c.init.method === "DELETE")).toBe(false);
  });

  test("no tax ID clears them", async () => {
    const { calls, client } = fake((url) => ({ body: url.includes("?limit") ? { data: [{ id: "txi_1", type: "us_ein", value: "12-3456789" }] } : {} }));
    await client.setTaxId("cus_1", null);
    expect(calls.map((c) => c.init.method)).toEqual(["GET", "DELETE"]);
  });

  test("the saved card becomes the default for invoices", async () => {
    const { calls, client } = fake(() => ({ body: {} }));
    await client.updateCustomer("cus_1", { defaultPaymentMethod: "pm_1" });
    expect(decodeURIComponent(String(calls[0]!.init.body))).toBe("invoice_settings[default_payment_method]=pm_1");
  });

  test("errors carry Stripe's message", async () => {
    const { client } = fake(() => ({ status: 402, body: { error: { message: "Your card was declined.", code: "card_declined" } } }));
    await expect(client.updateCustomer("cus_1", { name: "Acme" })).rejects.toMatchObject({ status: 402, code: "card_declined" });
  });
});
