import { faqs } from "@/lib/data";
import { Section } from "./section";

export function Faq() {
  return (
    <Section id="faq" title="FAQ">
      <div className="-mt-1 flex flex-col">
        {faqs.map((item) => (
          <details
            key={item.q}
            className="group border-t border-line first:border-t-0"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-3.5 text-fg [&::-webkit-details-marker]:hidden">
              <span>{item.q}</span>
              <span
                aria-hidden
                className="shrink-0 text-muted transition-transform duration-200 group-open:rotate-45"
              >
                +
              </span>
            </summary>
            <p className="max-w-[44rem] pb-4 text-fg-soft">{item.a}</p>
          </details>
        ))}
      </div>
    </Section>
  );
}
