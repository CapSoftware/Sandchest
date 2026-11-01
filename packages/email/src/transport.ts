/**
 * Sends email through Resend (cloud) or SMTP (self-hosted). With neither
 * configured, nothing is sent. Addresses and contents are never logged.
 */
import type { Transporter } from "nodemailer";

export interface Email {
  to: string[];
  subject: string;
  html: string;
  text: string;
}

export interface Mailer {
  readonly enabled: boolean;
  send(email: Email): Promise<void>;
}

export interface MailerConfig {
  RESEND_API_KEY?: string;
  SMTP_URL?: string;
  EMAIL_FROM?: string;
}

const noop: Mailer = { enabled: false, send: async () => {} };

export function createMailer(config: MailerConfig, fetchImpl: typeof fetch = fetch): Mailer {
  const from = config.EMAIL_FROM ?? "Sandchest <notifications@sandchest.local>";
  if (config.RESEND_API_KEY) {
    const key = config.RESEND_API_KEY;
    return {
      enabled: true,
      async send(email) {
        // One request per recipient: nobody sees who else was told.
        await Promise.all(
          email.to.map(async (to) => {
            const response = await fetchImpl("https://api.resend.com/emails", {
              method: "POST",
              headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
              body: JSON.stringify({ from, to: [to], subject: email.subject, html: email.html, text: email.text }),
              signal: AbortSignal.timeout(15_000),
            });
            if (!response.ok) throw new Error(`Resend answered ${response.status}`);
          }),
        );
      },
    };
  }
  if (config.SMTP_URL) {
    const url = config.SMTP_URL;
    let transporter: Promise<Transporter> | undefined;
    return {
      enabled: true,
      async send(email) {
        transporter ??= import("nodemailer").then((nodemailer) => nodemailer.createTransport(url));
        const smtp = await transporter;
        await Promise.all(email.to.map((to) => smtp.sendMail({ from, to, subject: email.subject, html: email.html, text: email.text })));
      },
    };
  }
  return noop;
}
