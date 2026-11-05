import { createHmac, timingSafeEqual } from "node:crypto";

/** Checks `X-Hub-Signature-256` against the raw request body, in constant time. */
export function verifySignature(secret: string, body: string | Uint8Array, header: string | null): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// The parts of each payload Sandchest reads.

export interface Account {
  id: number;
  login: string;
  type: "User" | "Organization" | "Bot";
}

export interface RepositoryRef {
  id: number;
  full_name: string;
  private: boolean;
  default_branch?: string;
  fork?: boolean;
}

export interface InstallationEvent {
  action: "created" | "deleted" | "suspend" | "unsuspend" | "new_permissions_accepted";
  installation: { id: number; account: Account };
  repositories?: Array<{ id: number; full_name: string; private: boolean }>;
}

export interface InstallationRepositoriesEvent {
  action: "added" | "removed";
  installation: { id: number; account: Account };
  repositories_added: Array<{ id: number; full_name: string; private: boolean }>;
  repositories_removed: Array<{ id: number; full_name: string; private: boolean }>;
}

export interface PullRequestEvent {
  action: string;
  number: number;
  installation?: { id: number };
  repository: RepositoryRef & { default_branch: string };
  sender: { login: string };
  pull_request: {
    number: number;
    draft?: boolean;
    head: { sha: string; ref: string; repo: { id: number; full_name: string; fork?: boolean } | null };
    base: { sha: string; ref: string; repo: { id: number } };
    user: { login: string };
    author_association: string;
  };
}

export interface PushEvent {
  ref: string;
  before: string;
  after: string;
  deleted?: boolean;
  forced?: boolean;
  /** Up to 20 commits (GitHub's cap), each with the paths it touched. */
  commits?: Array<{ added?: string[]; removed?: string[]; modified?: string[] }>;
  installation?: { id: number };
  repository: RepositoryRef & { default_branch: string };
}

export interface IssueCommentEvent {
  action: "created" | "edited" | "deleted";
  installation?: { id: number };
  repository: RepositoryRef & { default_branch: string };
  issue: { number: number; pull_request?: { url: string } };
  comment: { body: string; user: { login: string; type: string } };
  sender: { login: string; type: string };
}
