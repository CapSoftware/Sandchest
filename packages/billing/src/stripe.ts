/**
 * The few Stripe calls that let a card be taken on Sandchest's own page:
 * a SetupIntent on the Stripe customer Autumn bills, read back once the
 * browser has confirmed it, and the card it saved made the customer's
 * default so Autumn charges it. Card details never reach Sandchest: Stripe's
 * Payment Element sends them straight to Stripe.
 *
 * Like the Autumn client, these are a handful of form posts, not the SDK.
 */

export interface StripeConfig {
  secretKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class StripeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = "StripeError";
  }
}

export interface SetupIntent {
  id: string;
  status: "requires_payment_method" | "requires_confirmation" | "requires_action" | "processing" | "canceled" | "succeeded";
  customer: string | null;
  paymentMethod: string | null;
  clientSecret: string;
  metadata: Record<string, string>;
}

/** A postal address as Stripe stores it. */
export interface PostalAddress {
  line1: string;
  line2?: string | null;
  city: string;
  state?: string | null;
  postal_code: string;
  country: string;
}

export interface Stripe {
  /** A SetupIntent that saves a card for later, off-session charges. Cards only. */
  createSetupIntent(input: { customer: string; metadata: Record<string, string>; idempotencyKey?: string }): Promise<SetupIntent>;
  setupIntent(id: string): Promise<SetupIntent>;
  /** Names the customer for receipts, sets the address invoices show, and makes a saved card the one invoices charge. */
  updateCustomer(customer: string, input: { name?: string; email?: string; address?: PostalAddress; defaultPaymentMethod?: string }): Promise<void>;
  /** Makes this the customer's only tax ID (or clears them, given null), so invoices show it. Stripe checks the format. */
  setTaxId(customer: string, taxId: { type: string; value: string } | null): Promise<void>;
}

/** Flattens `{ a: { b: 1 } }` to `a[b]=1`, Stripe's form encoding. */
export function formEncode(body: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(body).flatMap(([key, value]) => {
    const name = prefix ? `${prefix}[${key}]` : key;
    if (value === undefined) return [];
    if (value !== null && typeof value === "object") return formEncode(value as Record<string, unknown>, name);
    return [`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`];
  });
}

interface RawSetupIntent {
  id: string;
  status: SetupIntent["status"];
  customer: string | null;
  payment_method: string | null;
  client_secret: string;
  metadata?: Record<string, string>;
}

const read = (raw: RawSetupIntent): SetupIntent => ({
  id: raw.id,
  status: raw.status,
  customer: raw.customer,
  paymentMethod: raw.payment_method,
  clientSecret: raw.client_secret,
  metadata: raw.metadata ?? {},
});

export function createStripe(config: StripeConfig): Stripe {
  const base = (config.baseUrl ?? "https://api.stripe.com").replace(/\/$/, "");
  const doFetch = config.fetch ?? fetch;

  async function call<T>(method: "GET" | "POST" | "DELETE", path: string, body?: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
    const response = await doFetch(`${base}/v1/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.secretKey}`,
        ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: body ? formEncode(body).join("&") : undefined,
      signal: AbortSignal.timeout(config.timeoutMs ?? 15_000),
    });
    const json = (await response.json().catch(() => ({}))) as { error?: { message?: string; code?: string } };
    if (!response.ok) throw new StripeError(`Stripe ${path}: ${json.error?.message ?? response.statusText}`, response.status, json.error?.code);
    return json as T;
  }

  return {
    async createSetupIntent({ customer, metadata, idempotencyKey }) {
      const raw = await call<RawSetupIntent>(
        "POST",
        "setup_intents",
        // Cards only (wallets included): they confirm on the page, with 3-D Secure in Stripe's own dialog, never a redirect.
        { customer, usage: "off_session", payment_method_types: ["card"], metadata },
        idempotencyKey,
      );
      return read(raw);
    },

    async setupIntent(id) {
      if (!/^seti_[A-Za-z0-9]+$/.test(id)) throw new StripeError("Stripe setup_intents: not a SetupIntent id", 400, "invalid_id");
      return read(await call<RawSetupIntent>("GET", `setup_intents/${id}`));
    },

    async updateCustomer(customer, { name, email, address, defaultPaymentMethod }) {
      await call("POST", `customers/${encodeURIComponent(customer)}`, {
        name,
        email,
        // Stripe clears an address field sent empty, so optional lines go as "" rather than being left out.
        address: address ? { ...address, line2: address.line2 ?? "", state: address.state ?? "" } : undefined,
        invoice_settings: defaultPaymentMethod ? { default_payment_method: defaultPaymentMethod } : undefined,
      });
    },

    async setTaxId(customer, taxId) {
      const path = `customers/${encodeURIComponent(customer)}/tax_ids`;
      const { data } = await call<{ data: { id: string; type: string; value: string }[] }>("GET", `${path}?limit=100`);
      const same = (old: { type: string; value: string }) => !!taxId && old.type === taxId.type && old.value === taxId.value;
      // The new one first, so a number Stripe rejects leaves the old one in place.
      if (taxId && !data.some(same)) await call("POST", path, { type: taxId.type, value: taxId.value });
      for (const old of data) if (!same(old)) await call("DELETE", `${path}/${encodeURIComponent(old.id)}`);
    },
  };
}
