import { isTrial, MAX_PURCHASE_CREDITS, planById, TOP_UP } from "@sandchest/billing/plans";
import { orgForAdmin } from "@sandchest/db";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { z } from "zod";
import { PageShape } from "@/components/app/skeleton";
import { isUuid } from "@/lib/uuid";
import { viewer } from "@/server/access";
import { autumn } from "@/server/billing";
import { db } from "@/server/db";
import { ConfirmView } from "./confirm-view";

export const metadata: Metadata = { title: "Confirm · Sandchest" };

/** Shows exactly what a plan change or credits will charge the card on file, before charging it. */
export default async function ConfirmPage({ searchParams }: { searchParams: Promise<{ org?: string; plan?: string; credits?: string; topup?: string; purchase?: string }> }) {
  const params = await searchParams;
  const user = await viewer();
  const client = autumn();
  const row = client && isUuid(params.org) ? await orgForAdmin(db(), user.id, params.org) : undefined;
  if (!client || !row) redirect("/dashboard/settings");

  const plan = planById(params.plan);
  const amount = (raw: string | undefined) => {
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1 && n <= MAX_PURCHASE_CREDITS ? n : undefined;
  };
  const credits = amount(plan ? params.credits : params.topup);
  // Free credits aren't a plan anything is charged on: joining from them goes through Settings, to Stripe Checkout.
  const current = isTrial(row.billing?.planId) ? undefined : planById(row.billing?.planId);
  if ((plan ? !plan.offered : !credits) || !current || plan?.id === current.id) redirect("/dashboard/settings#billing");
  // The purchase is charged under this id, kept in the address so a reload or a second tab can't charge it twice.
  const purchase = z.uuid().safeParse(params.purchase);
  if (!purchase.success) {
    const what = plan ? `plan=${plan.id}${credits ? `&credits=${credits}` : ""}` : `topup=${credits}`;
    redirect(`/dashboard/billing/confirm?org=${row.org.id}&${what}&purchase=${crypto.randomUUID()}`);
  }

  const preview = await client.preview({ customerId: row.org.id, planId: plan ? plan.id : TOP_UP.id, credits }).catch(() => undefined);
  const downgrade = plan && plan.price < current.price;
  const title = plan ? `Switch ${row.org.githubLogin} to ${plan.name}` : `Buy ${credits!.toLocaleString("en-US")} credits for ${row.org.githubLogin}`;
  const fields: Record<string, string> = {
    ...(plan ? { kind: "plan", plan: plan.id, ...(credits ? { credits: String(credits) } : {}) } : { kind: "top_up", credits: String(credits) }),
    purchase: purchase.data,
  };
  const monthly = (p: { credits: number }) => (p.credits > 0 ? ` with ${p.credits.toLocaleString("en-US")} credits a month` : "");

  const help = plan
    ? downgrade
      ? `${current.name} stays until the end of this period, then ${plan.name} starts${monthly(plan)}. Credits you bought stay yours.`
      : `${plan.name} starts now${monthly(plan)}. You pay the difference for the rest of this period.`
    : "Charged to the card on file. Bought credits never expire.";
  return (
    <PageShape id="confirm">
      <ConfirmView orgId={row.org.id} title={title} preview={preview && { ...preview, nextCycle: plan ? preview.nextCycle : null }} help={help} fields={fields} />
    </PageShape>
  );
}
