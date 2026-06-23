"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Plus } from "lucide-react";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { faqs } from "@/lib/data";
import { cn } from "@/lib/utils";

function FaqRow({
  q,
  a,
  open,
  onToggle,
}: {
  q: string;
  a: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="panel overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="focusable flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
      >
        <span className="text-[0.95rem] text-fg">{q}</span>
        <Plus
          className={cn(
            "h-4 w-4 shrink-0 text-muted transition-transform duration-300",
            open && "rotate-45 text-accent",
          )}
        />
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <p className="px-5 pb-5 text-sm leading-relaxed text-muted">{a}</p>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export function Faq() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <section id="faq" className="container-page scroll-mt-20 py-20 sm:py-24">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-14">
        <SectionHeading
          eyebrow="FAQ"
          title="Questions, answered plainly."
          description="No hidden catch. No surprise API bill. Here is exactly how Sandchest works."
        />

        <div className="flex flex-col gap-2.5">
          {faqs.map((item, i) => (
            <Reveal key={item.q} delay={Math.min(i * 0.04, 0.2)}>
              <FaqRow
                q={item.q}
                a={item.a}
                open={openIndex === i}
                onToggle={() => setOpenIndex(openIndex === i ? null : i)}
              />
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
