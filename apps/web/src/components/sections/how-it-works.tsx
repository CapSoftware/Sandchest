import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { howItWorks } from "@/lib/data";

export function HowItWorks() {
  return (
    <section className="container-page py-20 sm:py-24">
      <SectionHeading
        eyebrow="How it works"
        title="From signup to first edit in minutes."
        description="No new SDK. No provider juggling. Just a plan, a key, and one base URL."
      />

      <Reveal delay={0.1} className="mt-10">
        <div className="bento grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
          {howItWorks.map((item) => (
            <div key={item.step} className="p-6">
              <span className="font-mono text-sm text-accent">{item.step}</span>
              <h3 className="mt-6 text-[1.05rem] text-fg">{item.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                {item.body}
              </p>
            </div>
          ))}
        </div>
      </Reveal>
    </section>
  );
}
