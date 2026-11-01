import { LegalPage, legalMetadata } from "@/components/docs/legal-page";

export function generateMetadata() {
  return legalMetadata("acceptable-use");
}

export default function AcceptableUsePage() {
  return <LegalPage slug="acceptable-use" />;
}
