/**
 * Unified-diff patches as GitHub returns them per file. Review comments can
 * only be placed on lines that appear in a hunk, so this finds them.
 */

export interface FileDiff {
  path: string;
  /** New-file line numbers added by the change. */
  added: Set<number>;
  /** New-file line numbers shown in any hunk (added or context): where comments may go. */
  commentable: Set<number>;
  /** Hunk ranges in the new file, `[start, end]` inclusive. */
  hunks: Array<[number, number]>;
}

export function parsePatch(path: string, patch: string | undefined): FileDiff {
  const diff: FileDiff = { path, added: new Set(), commentable: new Set(), hunks: [] };
  if (!patch) return diff;
  let line = 0;
  let hunk: [number, number] | undefined;
  for (const text of patch.replace(/\n$/, "").split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (header) {
      line = Number(header[1]);
      const length = header[2] === undefined ? 1 : Number(header[2]);
      hunk = [line, line + Math.max(0, length - 1)];
      diff.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (text.startsWith("+")) {
      diff.added.add(line);
      diff.commentable.add(line);
      line++;
    } else if (text.startsWith(" ") || text === "") {
      diff.commentable.add(line);
      line++;
    }
    // "-" lines and "\ No newline" markers do not exist in the new file.
  }
  return diff;
}
