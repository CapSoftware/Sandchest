/**
 * Forgejo and Gitea webhooks. Forgejo sends both its own headers and Gitea's
 * (`X-Forgejo-*`, `X-Gitea-*`); Gitea only its own. The signature is the
 * HMAC-SHA256 of the raw body in hex, with no prefix.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Checks the delivery's signature against the raw request body, in constant time. */
export function verifySignature(secret: string, body: string | Uint8Array, signature: string | null): boolean {
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(signature, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** The event, delivery id and signature of a delivery, whichever of the two header sets it carries. */
export function deliveryHeaders(headers: Headers): { event: string | null; delivery: string | null; signature: string | null } {
  const read = (name: string) => headers.get(`x-forgejo-${name}`) ?? headers.get(`x-gitea-${name}`);
  return { event: read("event"), delivery: read("delivery"), signature: read("signature") };
}

// The parts of each payload Sandchest reads.

export interface User {
  id: number;
  login: string;
}

export interface Repository {
  id: number;
  full_name: string;
  private: boolean;
  default_branch: string;
  fork?: boolean;
  owner: User;
}

export interface PullRequestEvent {
  /** opened, reopened, synchronized, edited, closed, … */
  action: string;
  number: number;
  repository: Repository;
  sender: User;
  pull_request: {
    number: number;
    draft?: boolean;
    title: string;
    user: User;
    head: { sha: string; ref: string; repo_id: number; repo: { id: number; full_name: string } | null };
    base: { sha: string; ref: string; repo_id: number };
  };
}

export interface PushEvent {
  ref: string;
  before: string;
  after: string;
  repository: Repository;
}

export interface IssueCommentEvent {
  action: "created" | "edited" | "deleted";
  is_pull?: boolean;
  repository: Repository;
  issue: { number: number; pull_request?: object | null };
  comment: { body: string; user: User };
  sender: User;
}

export interface RepositoryEvent {
  action: "created" | "deleted";
  repository: Repository;
  organization?: User | null;
}
