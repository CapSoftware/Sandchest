/**
 * Forgejo lists a pull request's files without their patches, so Sandchest
 * reads the whole diff (`/pulls/{index}.diff`, as `git diff` prints it) and
 * splits it into files shaped like GitHub's, which the rest of Sandchest
 * already reads.
 */
import type { PullFile } from "@sandchest/github";

export function splitDiff(text: string): PullFile[] {
  const files: PullFile[] = [];
  const sections = text.split(/^(?=diff --git )/m).filter((section) => section.startsWith("diff --git "));
  for (const section of sections) {
    const lines = section.replace(/\n$/, "").split("\n");
    const header = lines[0]!;
    let oldPath: string | undefined;
    let newPath: string | undefined;
    let renameFrom: string | undefined;
    let renameTo: string | undefined;
    let status: PullFile["status"] = "modified";
    let hunkStart = -1;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.startsWith("@@")) {
        hunkStart = i;
        break;
      }
      if (line.startsWith("new file mode")) status = "added";
      else if (line.startsWith("deleted file mode")) status = "removed";
      else if (line.startsWith("rename from ")) renameFrom = unquote(line.slice(12));
      else if (line.startsWith("rename to ")) renameTo = unquote(line.slice(10));
      else if (line.startsWith("copy from ")) {
        renameFrom = unquote(line.slice(10));
        status = "copied";
      } else if (line.startsWith("copy to ")) renameTo = unquote(line.slice(8));
      else if (line.startsWith("--- ")) oldPath = side(line.slice(4), "a/");
      else if (line.startsWith("+++ ")) newPath = side(line.slice(4), "b/");
    }
    if (renameTo && status === "modified") status = "renamed";
    const filename = newPath ?? renameTo ?? (status === "removed" ? oldPath : undefined) ?? headerPath(header);
    if (!filename) continue;
    const file: PullFile = { filename, status, additions: 0, deletions: 0 };
    const previous = renameFrom ?? (oldPath && oldPath !== filename ? oldPath : undefined);
    if (previous && (status === "renamed" || status === "copied")) file.previous_filename = previous;
    if (hunkStart >= 0) {
      const hunks = lines.slice(hunkStart);
      for (const line of hunks) {
        if (line.startsWith("+")) file.additions++;
        else if (line.startsWith("-")) file.deletions++;
      }
      file.patch = hunks.join("\n");
    }
    files.push(file);
  }
  return files;
}

/** The path on one side of `---`/`+++`, without its `a/` or `b/`; undefined for /dev/null. */
function side(raw: string, prefix: string): string | undefined {
  // git appends a tab when the name has a space in it.
  const path = unquote(raw.replace(/\t$/, ""));
  if (path === "/dev/null") return undefined;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** `diff --git a/x b/x`: the new name, for a file with no hunks and no ---/+++ (a mode change, a binary file). */
function headerPath(header: string): string | undefined {
  const rest = header.slice("diff --git ".length);
  const quoted = /^"(?:[^"\\]|\\.)*" "b\/((?:[^"\\]|\\.)*)"$/.exec(rest) ?? /^a\/.* "b\/((?:[^"\\]|\\.)*)"$/.exec(rest);
  if (quoted) return unquote(`"${quoted[1]}"`);
  // Unquoted, both sides are the same length when the name did not change.
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest.startsWith("a/") && rest.slice(half + 1).startsWith("b/")) return rest.slice(half + 3);
  return /^a\/.* b\/(.*)$/.exec(rest)?.[1];
}

/** git quotes names with unusual characters C-style, with UTF-8 bytes as octal escapes. */
function unquote(value: string): string {
  if (!(value.startsWith('"') && value.endsWith('"'))) return value;
  const bytes: number[] = [];
  const body = value.slice(1, -1);
  const escapes: Record<string, number> = { n: 10, t: 9, r: 13, b: 8, f: 12, v: 11, a: 7, '"': 34, "\\": 92 };
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!;
    if (char !== "\\") {
      bytes.push(...Buffer.from(char));
      continue;
    }
    const next = body[i + 1] ?? "";
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      i += 3;
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}
