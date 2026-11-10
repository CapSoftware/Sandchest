/** How many credits one purchase may buy, as the forms and the agent API take it. */
import { CREDIT_PACK, MAX_PURCHASE_CREDITS } from "@sandchest/billing/plans";
import { z } from "zod";

/** Whole packs, from one up to MAX_PURCHASE_CREDITS: any whole number when a pack is one credit, multiples of 100 when credits are sold by the 100. */
export const PurchaseCredits =
  CREDIT_PACK > 1 ? z.coerce.number().int().min(CREDIT_PACK).max(MAX_PURCHASE_CREDITS).multipleOf(CREDIT_PACK) : z.coerce.number().int().min(1).max(MAX_PURCHASE_CREDITS);
