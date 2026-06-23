import { ChestButton } from "./chest-button";

// The pricing key — opens the shared waitlist dialog (mounted once at the root).
export function PricingCta({ sublabel }: { sublabel?: string }) {
  return <ChestButton sublabel={sublabel} />;
}
