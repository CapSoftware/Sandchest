import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { tools } from "@/lib/data";

export function SupportedTools() {
  return (
    <section className="container-page py-20 sm:py-24">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:items-center">
        <SectionHeading
          eyebrow="Supported tools"
          title="If it speaks OpenAI or Anthropic, it speaks Sandchest."
          description="Sandchest is just an API key and a base URL. If your coding tool supports custom model endpoints, you can probably use Sandchest."
        />

        <Reveal delay={0.1}>
          <div className="bento grid-cols-2 sm:grid-cols-3">
            {tools.map((tool) => (
              <div key={tool.name} className="group flex flex-col gap-3 p-4">
                <span className="font-mono text-sm text-faint transition-colors group-hover:text-accent">
                  {tool.glyph}
                </span>
                <div>
                  <p className="text-sm text-fg">{tool.name}</p>
                  <p className="mt-0.5 text-xs text-faint">{tool.blurb}</p>
                </div>
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}
