/**
 * A finding that covers other places: the section on its page, the marker
 * beside its location in a list, and how a scan's finding becomes a stored
 * row and back.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FindingView, type FindingRow } from "@/app/dashboard/findings/[id]/finding-view";
import { FindingsView } from "@/app/dashboard/findings/findings-view";
import { MorePlaces } from "@/components/app/more-places";
import { sampleFinding, sampleFindings } from "@/lib/samples";
import { toEngineFinding, toFindingInput } from "@/server/scans";

/** One sample for every render: its dates are taken from the clock. */
const row = sampleFinding();

function page(change: Partial<FindingRow["finding"]> = {}): string {
  return renderToStaticMarkup(<FindingView row={{ ...row, finding: { ...row.finding, ...change } }} />);
}

/** The markup of the section a heading id labels; empty when the page has no such section. */
function section(html: string, id: string): string {
  const start = html.indexOf(`aria-labelledby="${id}"`);
  return start === -1 ? "" : html.slice(start, html.indexOf("</section>", start));
}

describe("finding page", () => {
  const places = [
    { title: "Any signed-in user can cancel another account's invoice", category: "broken_access_control", at: "src/routes/invoices.ts:67", entry: "src/routes/invoices.ts:66", variant: true },
    { title: "Any signed-in user can read another account's credit notes", category: "broken_access_control", at: "src/routes/credit-notes.ts:23", entry: "src/routes/credit-notes.ts:22", variant: true },
    { title: "Any signed-in user can read another account's receipts", category: "broken_access_control", at: "src/routes/receipts.ts:9", entry: "src/routes/receipts.ts:8", variant: true },
  ];
  /** The same code reported a second time and merged in: one fix closes both, so it is not another place. */
  const repeat = { title: "Invoice lookup has no owner check", category: "broken_access_control", at: "src/db/invoices.ts:17", entry: "src/routes/invoices.ts:41" };

  test("lists every other place under the attack path, each linked like the path's own locations", () => {
    const html = page({ alsoReported: places });
    const also = section(html, "places-title");
    expect(also).toContain('Also affects <span class="block-count">3</span>');
    expect(also).toContain("The same flaw is at 3 other places. The fix is needed at each one.");
    for (const place of places) {
      const [file, line] = place.at.split(":");
      expect(also).toContain(`<a href="https://github.com/acme/api/blob/main/${file}#L${line}" target="_blank" rel="noreferrer">${place.at}</a>`);
      expect(also).toContain(place.title.replaceAll("'", "&#x27;"));
    }
    expect(also.match(/<li /g)).toHaveLength(3);
    // After the attack path, before the proof of concept.
    expect(html.indexOf('aria-labelledby="path-title"')).toBeLessThan(html.indexOf('aria-labelledby="places-title"'));
    expect(html.indexOf('aria-labelledby="places-title"')).toBeLessThan(html.indexOf('aria-labelledby="poc-title"'));
    // The same kind of link the path uses for a location.
    expect(html).toContain('<a href="https://github.com/acme/api/blob/main/src/routes/invoices.ts#L41" target="_blank" rel="noreferrer">src/routes/invoices.ts:41</a>');
  });

  test("says one place as one", () => {
    const also = section(page({ alsoReported: places.slice(0, 1) }), "places-title");
    expect(also).toContain('Also affects <span class="block-count">1</span>');
    expect(also).toContain("The same flaw is at one other place. The fix is needed at each one.");
  });

  test("shows nothing for a finding that covers no other place, or one stored before places were", () => {
    const none = page({ alsoReported: null });
    expect(none).not.toContain("Also affects");
    expect(page({ alsoReported: [] })).toBe(none);
    // Whatever the column holds that is not a list of places is no places.
    expect(page({ alsoReported: { title: "x" } as never })).toBe(none);
    expect(page({ alsoReported: [{ title: "No location" }] as never })).toBe(none);
    // A repeat report of the finding's own code is not a place: the page and its prompt are as they were.
    expect(page({ alsoReported: [repeat] })).toBe(none);
    expect(page({ alsoReported: [repeat], fixPrompt: "" })).toBe(page({ alsoReported: null, fixPrompt: "" }));
    const mixed = section(page({ alsoReported: [repeat, places[0]!] }), "places-title");
    expect(mixed).toContain('Also affects <span class="block-count">1</span>');
    expect(mixed).not.toContain("src/db/invoices.ts:17");
  });

  test("a place stored without a line is shown as written, not linked", () => {
    const also = section(page({ alsoReported: [{ ...places[0]!, at: "src/routes/invoices.ts" }] }), "places-title");
    expect(also).toContain('<span class="place-at">src/routes/invoices.ts</span>');
    expect(also).not.toContain("<a ");
  });

  test("the prompt rebuilt for a finding stored without one names every place", () => {
    const html = page({ alsoReported: places, fixPrompt: "" });
    expect(html).toContain("## Also affects\nThe same flaw is at 3 other places. The fix is needed at each one, and the regression test should cover every one:\n- `src/routes/invoices.ts:67`: Any signed-in user can cancel another account&#x27;s invoice");
    expect(page({ alsoReported: null, fixPrompt: "" })).not.toContain("## Also affects");
  });

  test("a resolved finding keeps its places: they quote no code", () => {
    const html = page({ alsoReported: places, status: "fixed", fixedAt: row.finding.lastSeenAt });
    expect(section(html, "places-title")).toContain("src/routes/credit-notes.ts:23");
  });

  test("the loading state draws the same view from a sample that has other places", () => {
    expect(sampleFinding().finding.alsoReported?.length).toBeGreaterThan(0);
    expect(section(page(), "places-title")).toContain("Also affects");
  });
});

describe("storing a finding", () => {
  // Another place it affects, and a repeat report of its own code: both are kept, so a later scan recognises either.
  const places = [
    { title: "The same flaw in the export", category: "broken_access_control" as const, at: "src/routes/export.ts:12", entry: "src/routes/export.ts:9", variant: true },
    { title: "Invoice lookup has no owner check", category: "broken_access_control" as const, at: "src/db/invoices.ts:17", entry: "src/routes/invoices.ts:41" },
  ];
  const engine = (stored: unknown) => toEngineFinding({ ...row.finding, alsoReported: stored as never });

  test("the places a scan reports go into the row, and null when it reports none", () => {
    const finding = engine(null);
    expect(toFindingInput({ ...finding, alsoReportedAs: places }).alsoReported).toEqual(places);
    expect(toFindingInput(finding).alsoReported).toBeNull();
    expect(toFindingInput({ ...finding, alsoReportedAs: [] }).alsoReported).toBeNull();
  });

  test("a stored row is the engine's finding again, with its places, or without the field when it has none", () => {
    expect(engine(places).alsoReportedAs).toEqual(places);
    for (const none of [null, [], "text", [{ title: "No location" }]]) expect("alsoReportedAs" in engine(none)).toBe(false);
    expect(toFindingInput(engine(places)).alsoReported).toEqual(places);
  });
});

describe("findings list", () => {
  const view = (list: ReturnType<typeof sampleFindings>) =>
    renderToStaticMarkup(<FindingsView current={{ status: "open", severities: [], repo: undefined, low: false }} list={list} counts={{ open: list.length, fixed: 0, dismissed: 0 }} repos={[]} />);
  const row = (html: string, title: string) => html.slice(html.lastIndexOf("<li", html.indexOf(title)), html.indexOf("</li>", html.indexOf(title)));

  test("marks a finding that covers other places beside its location, and no other", () => {
    const [first, second, third] = sampleFindings(3);
    const html = view([{ ...first!, morePlaces: 3 }, { ...second!, morePlaces: 1 }, { ...third!, morePlaces: 0 }]);
    expect(row(html, first!.title)).toContain(`<code>${first!.sink!.file}:${first!.sink!.line}</code><span class="flag">+3 more places</span>`);
    expect(row(html, second!.title)).toContain('<span class="flag">+1 more place</span>');
    expect(row(html, third!.title)).not.toContain("more place");
    expect(html.match(/more places?</g)).toHaveLength(2);
  });

  test("the marker is nothing at all for a finding with one place", () => {
    expect(renderToStaticMarkup(<MorePlaces count={0} />)).toBe("");
    expect(renderToStaticMarkup(<MorePlaces count={2} />)).toBe('<span class="flag">+2 more places</span>');
  });

  test("the loading state's sample list has one finding with other places", () => {
    expect(sampleFindings().filter((finding) => finding.morePlaces > 0)).toHaveLength(1);
  });
});
