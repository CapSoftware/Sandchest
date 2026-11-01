import { LandingPage } from "@/components/landing-page";

/** The landing page for visitors. People with a session get `/home` instead, from the same URL (see `homeRewrites`). */
export default function Home() {
  return <LandingPage visitor="signed-out" />;
}
