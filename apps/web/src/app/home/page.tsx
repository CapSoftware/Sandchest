import type { Metadata } from "next";
import { LandingPage } from "@/components/landing-page";

/**
 * The landing page for people who are signed in. Served at `/` when the
 * session cookie is present (see `homeRewrites`); asked for by name, /home
 * redirects to `/`, so it is never a page of its own.
 */
export const metadata: Metadata = { alternates: { canonical: "/" }, robots: { index: false } };

export default function SignedInHome() {
  return <LandingPage visitor="signed-in" />;
}
