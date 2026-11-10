/**
 * Hunt: one cheap call per packet and pass. The packet's code comes first (shared guards and helpers, then the
 * entry points) so it is a cached prefix across passes and the scoring call; the task comes last. Each pass
 * returns one compact pipe-delimited line per finding.
 */
import type { Message } from "../../llm/types";
import type { Bundle, Packet, Span } from "./bundle";

/** File lines by path; a file that could not be read has none. */
export type LinesOf = (file: string) => string[];

/** Reads every file a bundle shows, once, into a `LinesOf`. */
export async function loadLines(bundle: Bundle, read: (file: string) => Promise<string | undefined>): Promise<LinesOf> {
  const files = new Set<string>();
  for (const p of bundle.packets) {
    for (const k of p.shared) if (bundle.spans[k]) files.add(bundle.spans[k].file);
    for (const e of p.entries) files.add(e.handler.file);
  }
  const cache = new Map<string, string[]>();
  for (const f of files) {
    const text = await read(f).catch(() => undefined);
    cache.set(f, text === undefined ? [] : text.split("\n"));
  }
  return (f) => cache.get(f) ?? [];
}

/** Line-numbered code of `file` lines a..b. */
export const renderCode = (lines: LinesOf, file: string, a: number, b: number) =>
  `<f ${file}:${a}-${b}>\n${lines(file)
    .slice(a - 1, b)
    .map((t, i) => `${a + i} ${t}`)
    .join("\n")}\n</f>`;

/** The packet's code: shared spans, then each entry point. Identical for every call on the packet. */
export function packetPrefix(packet: Packet, spans: Record<string, Span>, lines: LinesOf): string {
  const shared = packet.shared
    .map((k) => {
      const s = spans[k]!;
      return renderCode(lines, s.file, s.start, s.end);
    })
    .join("\n");
  const entries = packet.entries.map((e) => `[${e.id}] ${e.method} ${e.path}\n${renderCode(lines, e.handler.file, e.handler.start, e.handler.end)}`).join("\n");
  return `Shared code (guards and helpers the entry points call):\n${shared || "(none)"}\n\nEntry points:\n${entries}`;
}

export const HUNT_TASK = `Security review of our own code. For each entry point E<n> above, decide whether an attacker (unauthenticated, an ordinary signed-in user, or a member acting beyond their role) can deliberately get something they should not: other users' or organizations' data or actions, access beyond their role, account takeover, code execution, or money, credits or paid work at our cost.
Use the shared code: a check shown there or in the handler that blocks the attack means no finding. Skip harm only to the attacker, trivial disclosures, and theoretical issues.
Output only lines, no prose, one per finding:
E<n>|<kind>|<u|a|m>|<file:line of the vulnerable line or missing check>|<who is harmed>|<why, max 12 words>
If there are none, output NONE.`;

/** Each lens pass looks for one family of bug, so three passes cover different ground on the same cached prefix. */
export const HUNT_LENSES = [
  "This pass looks only at ACCESS CONTROL: who may call this and on whose objects. Missing or wrong ownership, role or tenant checks; a check on the wrong object or the wrong permission compared with sibling handlers; ids or roles taken from the request without scoping to the caller; a lower role granting or changing a higher one.",
  "This pass looks only at DANGEROUS INPUT: caller-controlled values reaching a sensitive sink. SQL or query injection (including sort, order, filter and column names), command or template injection, path traversal, server-side URL fetches that can leave their intended host or carry credentials with them, unsafe deserialization, script injection in rendered output, and type confusion (a string where a boolean or number is expected) that slips past a check.",
  "This pass looks only at LOGIC AND ABUSE: trusting facts the client supplies (durations, sizes, prices, plans, flags, counts), paid or expensive work anyone can trigger or multiply (batch and fan-out), and flaws in sign-in, one-time code, reset, invite and share-password flows (no attempt limit on a short secret, codes not invalidated or invalidated by the wrong party, steps that can be skipped or replayed).",
] as const;

export const lensTask = (pass: number) => `Security review of our own code. For each entry point E<n> above, decide whether an attacker can deliberately get something they should not: other users' or organizations' data or actions, access beyond their role, account takeover, code execution, or money, credits or paid work at our cost.
${HUNT_LENSES[pass % HUNT_LENSES.length]} Ignore other kinds of issue in this pass.
Use the code above: a check shown there that blocks the attack means no finding. Skip harm only to the attacker, trivial disclosures, and theoretical issues.
Output only lines, no prose, one per finding:
E<n>|<kind>|<u|a|m>|<file:line of the vulnerable line or missing check>|<who is harmed>|<why, max 12 words>
The third field is the least-privileged attacker: u = not signed in, a = any signed-in user, m = a member or other low role acting beyond it.
If there are none, output NONE.`;

/** Review of one change: each entry is a changed file (or the part around the change), its header lists the changed ranges. */
export const CHANGE_TASK = `Security review of a code change in our own code. Each entry above is a file touched by the change; its header lists the changed line ranges. Decide whether the CHANGED code lets an attacker deliberately get something they should not: other users' or organizations' data or actions, access beyond their role, account takeover, code execution, or money, credits or paid work at our cost.
Report only weaknesses that are in the changed lines, or that the change newly exposes in the code around them. Ignore older problems the change does not touch. Use the code above: a check shown there that blocks the attack means no finding. Skip harm only to the attacker, trivial disclosures, and theoretical issues.
Output only lines, no prose, one per finding:
E<n>|<kind>|<u|a|m>|<file:line of the vulnerable line or missing check>|<who is harmed>|<why, max 12 words>
The third field is the least-privileged attacker: u = not signed in, a = any signed-in user, m = a member or other low role acting beyond it.
If there are none, output NONE.`;

export type HuntMode = "generic" | "lens" | "change";

export const huntTask = (mode: HuntMode, pass: number) => (mode === "change" ? CHANGE_TASK : mode === "lens" ? lensTask(pass) : HUNT_TASK);

/** The hunt call for one packet and pass: one user message, code first, task last. */
export function huntMessages(packet: Packet, spans: Record<string, Span>, lines: LinesOf, mode: HuntMode, pass: number): Message[] {
  return [{ role: "user", content: `${packetPrefix(packet, spans, lines)}\n\n${huntTask(mode, pass)}` }];
}

/** One reported finding, anchored at its entry point. Field names match the stored hunt rows. */
export interface HuntRow {
  packet: string;
  pass: number;
  entry_id: string;
  kind: string;
  /** As written: `u`, `a`, `m`, or whatever the model wrote. */
  attacker: string;
  role: string;
  /** The entry point's file and line. */
  file: string;
  line: number;
  /** The cited vulnerable line, or the entry handler's start when none was cited. */
  sink_file: string;
  sink_line: number;
  victim: string;
  why: string;
  title: string;
}

/** The final answer: the content, or (when the model left it empty) the last ```json block of its reasoning. */
export function answerText(content: string, reasoning = ""): string {
  if (content.trim()) return content;
  const at = reasoning.lastIndexOf("```json");
  return at >= 0 ? reasoning.slice(at) : "";
}

/** Splits one output line into trimmed fields, dropping leading list marks and fences. */
export const lineFields = (raw: string) =>
  raw
    .trim()
    .replace(/^[-*`\s]+/, "")
    .split("|")
    .map((x) => x.trim());

/** Rows from a hunt reply. Lines that are not `E<n>|...` with at least five fields, or name an unknown entry, are skipped. */
export function parseHuntReply(text: string, packet: Packet, pass: number): HuntRow[] {
  const byId = new Map(packet.entries.map((e) => [e.id, e]));
  const rows: HuntRow[] = [];
  for (const raw of text.split("\n")) {
    const f = lineFields(raw);
    if (f.length < 5 || !/^E\d+$/.test(f[0]!)) continue;
    const e = byId.get(f[0]!);
    if (!e) continue;
    const m = (f[3] ?? "").match(/([\w./\-\[\]@()]+):(\d+)/);
    const i = e.at.lastIndexOf(":");
    rows.push({
      packet: packet.name,
      pass,
      entry_id: e.id,
      kind: f[1]!,
      attacker: f[2]!,
      role: f[2]!,
      file: e.at.slice(0, i),
      line: Number(e.at.slice(i + 1)),
      sink_file: m?.[1] ?? e.handler.file,
      sink_line: m ? Number(m[2]) : e.handler.start,
      victim: f[4]!,
      why: f[5] ?? "",
      title: `${f[1]} in ${e.method} ${e.path}`.slice(0, 120),
    });
  }
  return rows;
}
