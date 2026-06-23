import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { ChestLine } from "@/components/doodles";

export function DoodleSection() {
  return (
    <section className="container-page py-20 sm:py-24">
      <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)] lg:gap-14">
        <SectionHeading
          eyebrow="The idea"
          title="A safe little box for powerful coding agents."
          description="One key, predictable usage, and fast access to frontier open coding models — without juggling five provider accounts. That is the whole point of Sandchest."
        />

        <Reveal delay={0.1} y={24}>
          <div className="panel grid place-items-center px-6 py-14">
            <ChestLine className="h-28 w-28 text-fg-soft" />
            <p className="mt-6 max-w-xs text-center text-sm leading-relaxed text-muted">
              One chest. One key. Every open coding model you reach for, kept
              tidy and predictable.
            </p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
