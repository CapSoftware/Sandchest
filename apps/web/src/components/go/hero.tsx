import { ChestButton } from "./chest-button";
import { brandLogos, BrandMark } from "./logos";

export function Hero() {
  return (
    <section className="gutter py-20 md:py-28">
      <h1 className="max-w-[20ch] text-balance text-[1.875rem] font-semibold leading-[1.1] tracking-[-0.02em] text-fg md:text-3xl">
        Open coding models for every agent, one flat price.
      </h1>

      <p className="mt-5 max-w-[46rem] text-lg leading-relaxed text-fg-soft md:text-xl">
        Sandchest is open source. It gives Claude Code, Cursor, OpenCode and any
        compatible client one key and one base URL for a growing lineup of open
        coding models, with a flat monthly price instead of a per-token meter.
      </p>

      {/* the treasure: the one loud element on the page — opens the waitlist */}
      <div className="mt-14">
        <ChestButton
          size="lg"
          sublabel="$149/mo"
          label={
            <>
              <span className="sm:hidden">Get your key</span>
              <span className="hidden sm:inline">Get your Sandchest key</span>
            </>
          }
          className="w-full justify-center sm:w-auto sm:justify-start"
        />
      </div>

      {/* the platforms it works with, right under the key */}
      <div className="mt-12">
        <p className="text-sm text-muted">Drops into the agent you already use</p>
        <div className="mt-4 flex flex-wrap items-center gap-2.5">
          {brandLogos.map(({ name, src }) => (
            <span
              key={name}
              className="inline-flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-fg-soft transition-colors hover:border-line-strong hover:text-fg"
            >
              <BrandMark
                src={src}
                className="h-[18px] w-auto shrink-0 opacity-90"
              />
              <span className="text-sm font-medium">{name}</span>
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
