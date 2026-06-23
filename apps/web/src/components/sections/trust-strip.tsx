import { tools } from "@/lib/data";

export function TrustStrip() {
  const items = [...tools, ...tools];
  return (
    <section className="py-14 sm:py-16" aria-label="Works with your tools">
      <div className="container-page">
        <p className="text-center font-mono text-xs uppercase tracking-[0.18em] text-faint">
          Works with the tools you already use
        </p>
      </div>
      <div className="relative mt-7 overflow-hidden [mask-image:linear-gradient(to_right,transparent,#000_12%,#000_88%,transparent)]">
        <div className="marquee-track flex w-max items-center gap-3 pr-3">
          {items.map((tool, i) => (
            <span
              key={`${tool.name}-${i}`}
              className="inline-flex items-center gap-2 rounded-full border border-line px-4 py-2 text-sm text-fg-soft"
            >
              <span className="font-mono text-xs text-faint">{tool.glyph}</span>
              {tool.name}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
