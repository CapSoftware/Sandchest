export { createMailer, type Email, type Mailer, type MailerConfig } from "./transport";
export {
  autoTopUpFailedEmail,
  autoTopUpSucceededEmail,
  creditsExhaustedEmail,
  creditsLowEmail,
  criticalFindingEmail,
  deepScanEmail,
  scanPausedEmail,
  teamInviteEmail,
  type CreditsInput,
  type FindingSummary,
  type RenderedEmail,
} from "./templates";
