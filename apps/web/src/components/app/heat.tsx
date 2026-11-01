import { SEVERITY_LABEL, type Severity } from "@/lib/format";

const LIT: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1 };

/** Severity as a four-pixel heat meter: more lit pixels, hotter colour. */
export function Heat({ severity, label = false }: { severity: Severity; label?: boolean }) {
  return (
    <span className="heat" data-severity={severity}>
      <span className="heat-meter" aria-hidden="true">
        {[1, 2, 3, 4].map((n) => (
          <i key={n} data-lit={n <= LIT[severity] ? "" : undefined} />
        ))}
      </span>
      {label ? <span className="heat-label">{SEVERITY_LABEL[severity]}</span> : <span className="sr-only">{SEVERITY_LABEL[severity]}</span>}
    </span>
  );
}
