import { Link } from "@/components/app/hover-link";
import type { AdminRange } from "@sandchest/db";
import { ADMIN_RANGES, lastDays } from "@/lib/admin-metrics";
import { dayLabel } from "@/lib/admin-format";

const PAGES = [
  { href: "/admin", label: "Quality" },
  { href: "/admin/cost", label: "Cost" },
  { href: "/admin/funnel", label: "Funnel" },
] as const;

type Page = (typeof PAGES)[number]["href"];

/** Title, the three dashboards and the time range. Every number below follows the range. */
export function AdminHead({ page, range, scope }: { page: Page; range: AdminRange; scope: string }) {
  const title = PAGES.find((p) => p.href === page)!.label;
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{title}</h1>
          <p className="page-sub">
            {scope} since {dayLabel(lastDays(range)[0]!)} (UTC). Internal: operators only.
          </p>
        </div>
      </div>
      <div className="filters">
        <nav className="tabs" aria-label="Dashboards">
          {PAGES.map((p) => (
            <Link key={p.href} prefetch={false} className="tab" href={`${p.href}?range=${range}`} aria-current={p.href === page ? "page" : undefined}>
              {p.label}
            </Link>
          ))}
        </nav>
        <nav className="chips" aria-label="Time range">
          {ADMIN_RANGES.map((days) => (
            <Link key={days} prefetch={false} className="chip" href={`${page}?range=${days}`} aria-current={days === range ? "true" : undefined}>
              {days} days
            </Link>
          ))}
        </nav>
      </div>
    </>
  );
}
