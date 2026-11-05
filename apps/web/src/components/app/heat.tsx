import { SEVERITY_LABEL, type Severity } from "@/lib/format";

const LIT: Record<Severity | "unknown", number> = { critical: 4, high: 3, medium: 2, low: 1, unknown: 0 };

/** Severity as a four-pixel heat meter: more lit pixels, hotter colour. An advisory nobody rated shows none lit. */
export function Heat({ severity, label = false }: { severity: Severity | "unknown"; label?: boolean }) {
  const name = severity === "unknown" ? "Unrated" : SEVERITY_LABEL[severity];
  return (
    <span className="heat" data-severity={severity}>
      <span className="heat-meter" aria-hidden="true">
        {[1, 2, 3, 4].map((n) => (
          <i key={n} data-lit={n <= LIT[severity] ? "" : undefined} />
        ))}
      </span>
      {label ? <span className="heat-label">{name}</span> : <span className="sr-only">{name}</span>}
    </span>
  );
}
