import { howItWorks } from "@/lib/data";
import { Section } from "./section";

export function How() {
  return (
    <Section id="how" title="Connect in three steps">
      <p className="max-w-[44rem] text-fg-soft">
        Grab one key, point any compatible agent at a single base URL, and code.
        No SDK to install, no migration. Your agent keeps working exactly as it
        does today, now with a growing lineup of open coding models.
      </p>

      <ol className="mt-7 flex flex-col gap-5">
        {howItWorks.map((item, i) => (
          <li key={item.step} className="flex gap-4">
            <span className="select-none pt-0.5 font-mono text-sm font-semibold text-accent">
              [{i + 1}]
            </span>
            <div className="max-w-[42rem]">
              <p className="font-medium text-fg">{item.title}</p>
              <p className="mt-0.5 text-fg-soft">{item.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </Section>
  );
}
