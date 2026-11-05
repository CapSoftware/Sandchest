/**
 * The change under review in a PR: which files matter for security, how
 * much of it to review, and whether a finding touches it.
 */
import { z } from "zod";
import { defineTool } from "../llm";
import type { Located } from "./gate";
import { agentTool, type AgentTool, type Wrap } from "./tools";

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  /** New-file line ranges of each hunk, inclusive. */
  hunks: Array<[number, number]>;
  /** The unified patch, when GitHub returned one. */
  patch?: string;
}

const LOCKFILES = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|uv\.lock)$/;
const VENDORED = /(^|\/)(node_modules|vendor|third_party|dist|build|out|\.next|coverage|__generated__|generated)\//;
const GENERATED = /\.(min\.(js|css)|map|pb\.go|snap)$|_pb2\.py$|\.generated\./;
const DOCS = /\.(md|mdx|rst|txt|adoc)$|(^|\/)(docs?|documentation)\/|(^|\/)(LICENSE|CHANGELOG|AUTHORS)/i;
const ASSETS = /\.(png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|mp4|mov|pdf|zip)$/i;
const TESTS = /(^|\/)(tests?|__tests__|__mocks__|spec|e2e|cypress|fixtures|testdata)\/|\.(test|spec)\.[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/;

/** Whether a changed file can carry a vulnerability: not a lockfile, generated, vendored, docs, assets or tests. */
export function isSecurityRelevant(path: string): boolean {
  return ![LOCKFILES, VENDORED, GENERATED, DOCS, ASSETS, TESTS].some((pattern) => pattern.test(path));
}

/** Security-relevant files that still exist after the change. */
export function relevantChanges(files: ChangedFile[]): ChangedFile[] {
  return files.filter((file) => file.status !== "removed" && isSecurityRelevant(file.path));
}

export function changedLines(files: ChangedFile[]): number {
  return files.reduce((sum, file) => sum + file.additions + file.deletions, 0);
}

/**
 * Keeps files until `cap` changed lines, riskiest first. `risk` scores a path
 * (sinks and entry points in it); ties go to the larger change. A file too big
 * for the cap on its own never crowds out the ones that fit, and is reviewed
 * alone only when nothing else fits.
 */
export function capChanges(files: ChangedFile[], cap: number, risk: (path: string) => number): { kept: ChangedFile[]; dropped: ChangedFile[] } {
  const ranked = [...files].sort((a, b) => risk(b.path) - risk(a.path) || b.additions + b.deletions - (a.additions + a.deletions));
  const kept: ChangedFile[] = [];
  const dropped: ChangedFile[] = [];
  let lines = 0;
  for (const file of ranked) {
    const size = file.additions + file.deletions;
    if (lines + size > cap) dropped.push(file);
    else {
      kept.push(file);
      lines += size;
    }
  }
  if (kept.length === 0 && dropped.length > 0) kept.push(dropped.shift()!);
  return { kept, dropped };
}

/** Lines of slack around a hunk when deciding whether a citation touches it. */
const TOUCH_SLACK = 3;

/** Whether any cited location falls in (or right next to) a changed hunk. */
export function touchesChange(files: ChangedFile[], cited: Array<Pick<Located, "file" | "line">>): boolean {
  const byPath = new Map(files.map((file) => [file.path, file.hunks]));
  return cited.some(({ file, line }) => byPath.get(file)?.some(([start, end]) => line >= start - TOUCH_SLACK && line <= end + TOUCH_SLACK) ?? false);
}

const diffTool = defineTool({
  name: "diff",
  description: "The change under review. Without a path, lists the changed files. With a path, returns that file's diff (unified format; new-file line numbers in the @@ headers).",
  args: z.object({ path: z.string().optional() }),
});

/** Gives agents the PR's diff. */
export function changeTool(files: ChangedFile[], wrap: Wrap): AgentTool {
  return agentTool(diffTool, async ({ path }: { path?: string }) => {
    if (!path) return wrap(files.map((file) => `${file.path} (${file.status}, +${file.additions} −${file.deletions})`).join("\n"));
    const file = files.find((f) => f.path === path);
    if (!file) return `Not part of this change. Changed files: ${files.map((f) => f.path).join(", ")}`;
    return wrap(`${file.path}\n${file.patch ?? "(no textual diff: binary or too large; read the file instead)"}`);
  });
}
