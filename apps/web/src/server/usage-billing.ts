/**
 * The usage bill of a slice scan priced `usage` or `shadow`, written once its ledger is complete: after the
 * write-up, before the publish that charges it. Everything it needs comes from the scan's pricing, fixed when
 * its credits were reserved, never from the settings now. Returns ids, enums and counts only.
 */
import { ledgerTrust, usageBill } from "@sandchest/billing/usage";
import { billableUsageRows, scanBill, updateScan, usageBudgetState, writeScanBill, type ScanBill, type ScanBillDraft, type ScanBillStatus } from "@sandchest/db";
import { heldCredits } from "./billing";
import { creditMicroUsd } from "./config";
import { STALE_CALL_SECONDS } from "./gateway";
import { requireScan } from "./scans";
import { captureException } from "./sentry";
import { db } from "./services";
import { sandboxCostRecorded, sliceState, usageBilled } from "./slice-scan";

export type BillSliceResult = { state: "skipped" } | { state: "waiting" } | { state: "billed"; status: ScanBillStatus; credits: number };

/**
 * Writes the scan's usage bill, once. While a model call of the scan may still be under way (a `started` row
 * younger than the gateway's stale window) it answers `waiting`, unless `final`: then the ledger is billed as it
 * is, and a `started` row left in it makes it untrusted.
 *
 * - Trusted: the bill from the ledger, `open` for a usage scan (its carry moves) or `shadow` (computed from no
 *   carry, never moving the account's).
 * - Untrusted: nothing is charged and the carry stays; the lines are kept for the record and the reason is
 *   reported. A usage scan's bill is `waived`; a shadow scan's stays `shadow`, with the reason.
 *
 * A usage scan's `credits` become the bill's, which the publish step charges. A shadow scan's are left as the
 * write-up set them. Run again, the stored bill stands.
 */
export async function billSlice(scanId: string, options: { final?: boolean } = {}): Promise<BillSliceResult> {
  const scan = await requireScan(scanId);
  const pricing = scan.pricing;
  if (!usageBilled(pricing) || scan.status !== "running") return { state: "skipped" };
  let bill: ScanBill | undefined = await scanBill(db(), scan.id);
  if (!bill) {
    if (!options.final) {
      const budget = await usageBudgetState(db(), scan.id, STALE_CALL_SECONDS);
      if (budget && budget.inFlight > 0) return { state: "waiting" };
    }
    const shadow = pricing.mode === "shadow";
    const rows = await billableUsageRows(db(), scan.id);
    const state = sliceState(scan);
    const sandbox = await sandboxCostRecorded(scan);
    const trust = ledgerTrust(rows, {
      unwrittenRows: Object.values(state.unwritten ?? {}).reduce((sum, n) => sum + n, 0),
      sandboxExpected: sandbox !== undefined,
      sandboxRecorded: sandbox === true,
    });
    const multiplierThousandths = pricing.multiplierThousandths;
    if (multiplierThousandths === undefined) throw new Error("The scan's pricing has no multiplier");
    const credit = creditMicroUsd(pricing.unit);
    // A shadow scan holds its tier price; its bill is capped at what it would have held billed from usage.
    const reservedCredits = shadow ? heldCredits({ ...pricing, mode: "usage" }, scan.creditsReserved ?? 0) : (scan.creditsReserved ?? 0);
    const written = await writeScanBill(db(), scan.id, (accountCarry): ScanBillDraft => {
      const carryIn = shadow ? 0 : accountCarry;
      const computed = usageBill({ rows, multiplierThousandths, creditMicroUsd: credit, carryInMicroUsd: carryIn, reservedCredits });
      const draft = {
        engine: pricing.engine,
        fast: state.fast === true,
        multiplierThousandths,
        creditMicroUsd: credit,
        costMicroUsd: computed.costMicroUsd,
        dueMicroUsd: computed.dueMicroUsd,
        reservedCredits,
        lines: computed.lines,
        carryInMicroUsd: carryIn,
      };
      if (trust.trusted) return { ...draft, status: shadow ? "shadow" : "open", credits: computed.credits, carryOutMicroUsd: computed.carryOutMicroUsd, capped: computed.capped };
      return { ...draft, status: shadow ? "shadow" : "waived", reason: trust.reason, credits: 0, carryOutMicroUsd: carryIn, capped: false };
    });
    bill = written.bill;
    if (written.created && !trust.trusted) {
      console.error(`Usage bill for scan ${scan.id} not charged: ledger ${trust.reason}`);
      await captureException(Object.assign(new Error("A usage bill was waived"), { name: "UsageBillWaived" }), { source: "billing", tags: { scan_id: scan.id, reason: trust.reason }, handled: true });
    }
  }
  if (pricing.mode === "usage") await updateScan(db(), scan.id, { credits: bill.credits });
  return { state: "billed", status: bill.status, credits: bill.credits };
}
