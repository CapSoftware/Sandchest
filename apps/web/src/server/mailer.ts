/**
 * The mailer, on its own like `db`, so billing code that pages import can
 * send email without loading the scan services.
 */
import { createMailer, type Mailer } from "@sandchest/email";
import { config } from "./config";

let instance: Mailer | undefined;

export function mailer(): Mailer {
  return (instance ??= createMailer(config()));
}

/** For tests. */
export function setMailer(value: Mailer | undefined): void {
  instance = value;
}
