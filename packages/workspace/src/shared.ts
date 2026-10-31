import { posix } from "node:path";
import { WorkspaceError, type CloneOptions, type RepoRef } from "./index";

export const DEFAULT_CLONE_TIMEOUT_MS = 10 * 60_000;

/** Applied to every command: no prompts, no host or user git config, no LFS downloads. */
export const BASE_ENV: Readonly<Record<string, string>> = {
  LANG: "C.UTF-8",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_LFS_SKIP_SMUDGE: "1",
};

// Uses a named remote because partial clone (`--filter`) requires one.
// Arguments are passed positionally, never interpolated into the script.
const CLONE_SCRIPT = `set -e
git init --quiet "$1"
cd "$1"
git remote add origin "$2"
shift 2
git fetch "$@"
git checkout --quiet --detach FETCH_HEAD`;

const SAFE_REF = /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/;

/**
 * Builds a single command that shallow-fetches `repo` at `ref` into `dir`.
 * One process keeps remote workspaces to one round trip.
 */
export function cloneCommand(dir: string, repo: RepoRef, options: CloneOptions): { cmd: string[]; env: Record<string, string> } {
  const url = parseCloneUrl(repo.url);
  const ref = repo.ref ?? "HEAD";
  if (!SAFE_REF.test(ref) || ref.includes("..")) throw new WorkspaceError(`Invalid ref: ${ref}`);
  if (!Number.isInteger(options.depth) || options.depth < 1) throw new WorkspaceError(`Invalid depth: ${options.depth}`);

  const fetchArgs = ["--quiet", "--no-tags", `--depth=${options.depth}`];
  if (options.filter) fetchArgs.push(`--filter=${options.filter}`);
  fetchArgs.push("origin", ref);

  return {
    cmd: ["sh", "-c", CLONE_SCRIPT, "clone", dir, url.href, ...fetchArgs],
    env: options.token ? authEnv(url, options.token) : {},
  };
}

function parseCloneUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WorkspaceError("Clone URL is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "file:") {
    throw new WorkspaceError(`Unsupported clone URL protocol: ${url.protocol}`);
  }
  if (url.username || url.password) throw new WorkspaceError("Clone URL must not contain credentials");
  return url;
}

/**
 * Supplies the token as an HTTP header scoped to the repo's origin, via
 * environment-provided git config: it never appears in argv, `.git/config`
 * or requests to other hosts.
 */
function authEnv(url: URL, token: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${url.origin}/.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${btoa(`x-access-token:${token}`)}`,
  };
}

/** Joins a checkout-relative path onto `root`, refusing anything that escapes it. */
export function resolveInside(root: string, path: string): string {
  const full = posix.join(root, path);
  if (!isInside(root, full)) throw new WorkspaceError(`Path escapes the checkout: ${path}`);
  return full;
}

export function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}
