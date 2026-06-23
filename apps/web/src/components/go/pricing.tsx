import { chestPlan } from "@/lib/data";
import { Section } from "./section";
import { PricingCta } from "./pricing-cta";

export function Pricing() {
  return (
    <Section id="pricing" title="Get your Sandchest key">
      <p className="max-w-[44rem] text-fg-soft">
        One plan, ${chestPlan.price} a month. Every model we host, used as hard as
        you code, with no per-token math and no surprise invoice. All you can eat
        within fair-use limits.
      </p>

      <div className="mt-7">
        <PricingCta sublabel={`$${chestPlan.price}/mo`} />
      </div>

      <ul className="mt-8 flex max-w-[42rem] flex-col gap-2.5 text-fg-soft">
        {chestPlan.includes.map((item) => (
          <li key={item} className="flex gap-3">
            <span aria-hidden className="select-none font-mono text-accent">
              +
            </span>
            <span>{item}</span>
          </li>
        ))}
      </ul>

      <p className="mt-6 max-w-[42rem] text-sm text-faint">
        All you can eat means no token meters and no usage bills. Fair-use limits
        keep capacity fast for everyone, and in normal day-to-day coding you
        won&rsquo;t come close. Cancel anytime.
      </p>
    </Section>
  );
}
