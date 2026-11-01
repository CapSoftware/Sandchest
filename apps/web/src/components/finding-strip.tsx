/**
 * An example Sandchest pull request review comment.
 *
 * Illustrative only: never paste real scan output here (see AGENTS.md).
 */

import { brandAsset } from "@/lib/site";

function Redacted({ chars }: { chars: number }) {
  return (
    <span className="redacted" style={{ width: `${chars}ch` }}>
      <span className="sr-only">redacted</span>
    </span>
  );
}

const DIFF: { n: number; code: string; added?: boolean }[] = [
  { n: 11, code: "export async function GET(req: Request, { params }: Ctx) {" },
  { n: 12, code: "  const session = await requireSession(req);" },
  { n: 13, code: "  const { id } = await params;" },
  { n: 14, code: "  const invoice = await getInvoice(id);", added: true },
  { n: 15, code: "  return Response.json(invoice);", added: true },
  { n: 16, code: "}" },
];

const PATH: { at: string; text: string; excerpt?: string }[] = [
  {
    at: "app/api/invoices/[id]/route.ts:13",
    text: "The invoice ID comes straight from the URL.",
  },
  {
    at: "lib/billing/invoices.ts:31",
    text: "getInvoice looks it up by ID alone. Nothing checks who is asking.",
    excerpt: ".where(eq(invoices.id, id))",
  },
  {
    at: "app/api/invoices/[id]/route.ts:15",
    text: "The whole invoice is returned, billing email and line items included.",
  },
];

const FIX_PROMPT = `Fix a broken access control bug in app/api/invoices/[id]/route.ts:14.

Attack path: GET /api/invoices/:id passes the ID from the URL to
getInvoice (lib/billing/invoices.ts:31), which looks it up by ID only.
Any signed-in user can read any customer's invoice.

The fix must guarantee: an invoice is only returned to members of the
organisation that owns it. Everyone else gets a 404.

Must not break: invoice downloads for the owning organisation.

Add a regression test that signs in as a member of another
organisation, requests an invoice it doesn't own and expects a 404.`;

export function FindingStrip() {
  return (
    <figure className="strip">
      <div className="strip-pr">
        <Redacted chars={9} />
        <span className="text-dust">/</span>
        <Redacted chars={6} />
        <span className="text-dust">#418 · Add invoice download</span>
      </div>

      <div className="strip-body">
        <div className="strip-file">app/api/invoices/[id]/route.ts</div>
        <pre className="strip-diff" aria-label="Changed lines">
          {DIFF.map((line) => (
            <span key={line.n} className={line.added ? "diff-line diff-added" : "diff-line"}>
              <span className="diff-n">{line.n}</span>
              <span className="diff-sign">{line.added ? "+" : " "}</span>
              {line.code}
            </span>
          ))}
        </pre>

        <div className="comment">
          <img
            className="comment-avatar"
            src={brandAsset("/sandchest-icon-small.svg")}
            alt=""
            width={30}
            height={28}
          />
          <div className="comment-main">
            <p className="comment-meta">
              <strong>sandchest</strong>
              <span className="bot-badge">bot</span>
              <span className="text-dust">commented on lines 14–15</span>
            </p>

            <p className="finding-rating">
              <span className="severity">High</span>
              <span>High confidence</span>
              <span>CWE-639</span>
            </p>

            <h2 className="finding-title">
              Any signed-in user can read every customer&rsquo;s invoices.
            </h2>

            <h3 className="finding-label">Attack path</h3>
            <ol className="attack-path">
              {PATH.map((step) => (
                <li key={step.at}>
                  <code className="file-ref">{step.at}</code>
                  <span>{step.text}</span>
                  {step.excerpt ? <code className="excerpt">{step.excerpt}</code> : null}
                </li>
              ))}
            </ol>

            <h3 className="finding-label">Preconditions</h3>
            <p>Signed in as any user, in any organisation.</p>

            <h3 className="finding-label">Proof of concept</h3>
            <pre className="poc">
              {"curl https://"}
              <Redacted chars={12} />
              {"/api/invoices/inv_000001 \\\n  -H 'cookie: session="}
              <Redacted chars={16} />
              {"'\n"}
              <span className="text-dust">{"# 200 OK, another customer's invoice"}</span>
            </pre>

            <details className="fix-prompt">
              <summary>Fix prompt for your coding agent</summary>
              <pre>{FIX_PROMPT}</pre>
            </details>
          </div>
        </div>
      </div>

      <div className="strip-check">
        <span className="check-mark" aria-hidden="true">
          ✕
        </span>
        <span>
          <strong>Sandchest</strong> <span className="text-dust">found 1 high-severity issue</span>
        </span>
        <span className="check-cost">Reviewed · 2 credits</span>
      </div>
    </figure>
  );
}
