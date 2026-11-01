import { LegalPage, legalMetadata } from "@/components/docs/legal-page";

export function generateMetadata() {
  return legalMetadata("privacy");
}

export default function PrivacyPage() {
  return <LegalPage slug="privacy" />;
}
