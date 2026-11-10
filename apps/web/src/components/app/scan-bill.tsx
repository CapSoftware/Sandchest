import type { BillGroup, BillView } from "@/lib/bill-view";
import { compactNumber, duration, money, plural } from "@/lib/format";

/**
 * A scan's usage bill: what it did, what each part used and came to, and what was charged, in US dollars as the
 * customer pays them (a bill's amounts are parts of a credit, so its lines run to four decimals). Shown for a scan
 * billed from its usage once its bill is written.
 */
export function ScanBill({ bill }: { bill: BillView }) {
  return (
    <section className="block" aria-labelledby="bill-title">
      <h2 id="bill-title" className="block-title">
        Bill
      </h2>
      <table className="bill">
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">What it did</span>
            </th>
            <th scope="col" className="bill-n">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {bill.groups.map((group) => (
            <tr key={group.label}>
              <th scope="row">
                <span className="bill-what">{group.label}</span>
                <span className="bill-detail">
                  {detail(group).map((part, i) => (
                    <span key={part}>
                      {i > 0 && " · "}
                      <span className="bill-part">{part}</span>
                    </span>
                  ))}
                </span>
              </th>
              <td className="bill-n">{line(group.credits)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="bill-sum">
            <th scope="row">Usage</th>
            <td className="bill-n">{line(bill.usage)}</td>
          </tr>
          {bill.carriedIn > 0 && (
            <tr>
              <th scope="row">Carried from earlier scans</th>
              <td className="bill-n">{line(bill.carriedIn)}</td>
            </tr>
          )}
          <tr className="bill-charged">
            <th scope="row">{bill.status === "open" ? "To be charged" : "Charged"}</th>
            <td className="bill-n">{money(bill.charged)}</td>
          </tr>
          {bill.carriedOut > 0 && (
            <tr>
              <th scope="row">Carried to the next scan</th>
              <td className="bill-n">{line(bill.carriedOut)}</td>
            </tr>
          )}
        </tfoot>
      </table>
      <p className="bill-meta">{[bill.fast && "Fast", bill.capped ? `Capped at the ${money(bill.held)} held.` : `${money(bill.held)} held`].filter(Boolean).join(" · ")}</p>
      {bill.note && !bill.capped && <p className="bill-note">{bill.note}</p>}
    </section>
  );
}

/** Hundredths of a credit, as a bill's lines show them: "$0.1512". */
function line(hundredths: number): string {
  return money(hundredths / 100, true);
}

/** "12 calls", "1.2M tokens in", "80K out", or a sandbox's time: each kept on one line. */
function detail(group: BillGroup): string[] {
  if (group.kind === "sandbox") return [duration(group.seconds * 1000)];
  return [plural(group.calls, "call"), `${compactNumber(group.inputTokens)} tokens in`, `${compactNumber(group.outputTokens)} out`];
}
