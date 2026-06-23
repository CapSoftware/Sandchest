import Link from "next/link";
import { ArrowRight } from "lucide-react";

export function AnnouncementBar() {
  return (
    <div className="relative z-50 border-b border-line bg-ink-2">
      <div className="container-page flex items-center justify-center gap-x-3 gap-y-1 py-2 text-center text-[0.8rem]">
        <p className="text-muted">
          <span className="mr-1.5 rounded-full border border-line px-1.5 py-0.5 font-mono text-[0.62rem] uppercase tracking-wide text-fg-soft">
            New
          </span>
          GLM-5.2 access for coding agents is opening in batches.
        </p>
        <Link
          href="#pricing"
          className="link-accent focusable group inline-flex shrink-0 items-center gap-1 rounded"
        >
          Join the beta
          <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>
    </div>
  );
}
