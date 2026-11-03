/**
 * A business's details for its invoices: the name and address they show,
 * and a tax ID if it has one. They go to the Stripe customer, not to
 * Sandchest's database: Stripe puts them on every invoice it makes.
 */
import { taxIdTypeFor } from "@sandchest/billing";
import { z } from "zod";
import { autumn, stripe } from "./billing";

export const InvoiceDetails = z
  .object({
    name: z.string().trim().min(1).max(256),
    address: z.object({
      line1: z.string().trim().min(1).max(200),
      line2: z.string().trim().max(200).nullish(),
      city: z.string().trim().max(200),
      state: z.string().trim().max(200).nullish(),
      postal_code: z.string().trim().max(40),
      country: z.string().regex(/^[A-Z]{2}$/),
    }),
    taxId: z.object({ type: z.string().max(20), value: z.string().trim().min(1).max(64) }).nullable(),
  })
  .refine((details) => !details.taxId || taxIdTypeFor(details.address.country, details.taxId.type));
export type InvoiceDetailsInput = z.input<typeof InvoiceDetails>;

/** Puts the details on the org's Stripe customer. Throws Stripe's error (`tax_id_invalid` for a bad tax ID). */
export async function applyInvoiceDetails(org: { id: string; githubLogin: string }, details: z.output<typeof InvoiceDetails>): Promise<void> {
  const client = stripe();
  if (!client) throw new Error("Stripe isn't configured");
  const customer = await autumn()!.stripeCustomer(org.id, org.githubLogin);
  await client.updateCustomer(customer, { name: details.name, address: details.address });
  await client.setTaxId(customer, details.taxId);
}
