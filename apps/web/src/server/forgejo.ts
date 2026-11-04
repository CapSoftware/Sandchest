/**
 * The Forgejo bot client, on its own like `githubApp`. Only deployments with
 * FORGEJO_URL set ever create it.
 */
import { Forgejo } from "@sandchest/forgejo";
import { config } from "./config";

let instance: Forgejo | undefined;

/** The Forgejo client, or undefined when this deployment does not use Forgejo. */
export function forgejoClient(): Forgejo | undefined {
  if (instance) return instance;
  const settings = config().forgejo;
  return settings ? (instance = new Forgejo(settings)) : undefined;
}

/** For tests. */
export function setForgejoClient(value: Forgejo | undefined): void {
  instance = value;
}
