import { LegalPage, legalMetadata } from "@/components/docs/legal-page";

export function generateMetadata() {
  return legalMetadata("terms");
}

export default function TermsPage() {
  return <LegalPage slug="terms" />;
}
