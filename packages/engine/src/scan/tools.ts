/**
 * The read-only tools agents use to explore the checkout. Each call goes to
 * the indexer daemon and comes back as compact text for the model, wrapped as
 * untrusted repository data.
 */
import { z } from "zod";
import type { IndexerClient } from "../indexer/client";
import type { Signals } from "./leads";
import { defineTool, type Tool } from "../llm";
import type { Lead } from "./schema";
import { findDefinitions, librarySource } from "./library";

export interface AgentTool<Args = unknown> {
  tool: Tool<Args>;
  /** Returns the text sent back to the model. A thrown error is reported to the model as the result. */
  run(args: Args, signal?: AbortSignal): Promise<string>;
}

export function agentTool<Args>(tool: Tool<Args>, run: (args: Args, signal?: AbortSignal) => Promise<string>): AgentTool {
  return { tool, run } as AgentTool;
}

/** Wraps repository-derived text so the model treats it as data. The tag carries a per-scan nonce that content cannot guess. */
export type Wrap = (text: string) => string;

export function createWrap(tag: string): Wrap {
  // Repository content cannot know the tag, but model-written summaries can echo it from earlier tool results.
  return (text) => `<${tag}>\n${text.replaceAll(`<${tag}>`, "<repo-data>").replaceAll(`</${tag}>`, "</repo-data>")}\n</${tag}>`;
}

export interface RepoToolContext {
  indexer: IndexerClient;
  wrap: Wrap;
  /** Read at call time: vulnerable dependencies arrive after the tools are created. */
  signals: Signals;
  /** Called with each file an agent reads, to track coverage. */
  onRead?: (path: string) => void;
}

const SINK_KINDS = ["sql", "nosql", "command", "code_eval", "path", "ssrf", "deserialization", "xxe", "xss", "template", "redirect", "weak_crypto", "jwt"] as const;

const search = defineTool({
  name: "search",
  description:
    "Regex search across the repository (Rust regex syntax, multi-line mode). Returns file:line and the matching line. Tests are excluded unless includeTests is set or a glob is given.",
  args: z.object({
    pattern: z.string().min(1),
    literal: z.boolean().optional().describe("Treat pattern as plain text"),
    ignoreCase: z.boolean().optional(),
    glob: z.string().optional().describe("Only files matching this glob, e.g. 'routes/**' or '*.py'"),
    includeTests: z.boolean().optional(),
    maxResults: z.number().int().min(1).max(200).optional(),
  }),
});

const readFile = defineTool({
  name: "read_file",
  description: "Read a file with line numbers. Up to 300 lines per call; pass startLine/endLine for large files.",
  args: z.object({
    path: z.string().min(1),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
  }),
});

const listDir = defineTool({
  name: "list_dir",
  description: "List a directory. Omit path for the repository root.",
  args: z.object({ path: z.string().optional() }),
});

const symbols = defineTool({
  name: "symbols",
  description: "Find function, method and class definitions by name (exact, prefix, then substring).",
  args: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(100).optional() }),
});

const callers = defineTool({
  name: "callers",
  description: "Call sites that may invoke a function or method (matched by name). Accepts 'name' or 'Class.name'.",
  args: z.object({ symbol: z.string().min(1), limit: z.number().int().min(1).max(200).optional() }),
});

const callees = defineTool({
  name: "callees",
  description: "Calls made inside a function or method, with where each callee is defined.",
  args: z.object({ symbol: z.string().min(1) }),
});

const routes = defineTool({
  name: "routes",
  description:
    "Entry-point inventory: HTTP routes, server actions and request-handling scripts, with their middleware chain and resolved handler locations. Filter by any text in method, path, file or handler.",
  args: z.object({ filter: z.string().optional(), limit: z.number().int().min(1).max(1000).optional() }),
});

const sinks = defineTool({
  name: "sinks",
  description:
    "Dangerous sinks (queries, commands, file access, outbound requests, markup, deserialisation, weak crypto, JWT handling) found by the index. 'built' input means the argument is assembled at runtime (concatenation, interpolation): the classic injection shape.",
  args: z.object({
    kind: z.enum(SINK_KINDS).optional(),
    path: z.string().optional().describe("Only sinks under this path prefix"),
    minInput: z.enum(["variable", "built"]).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
});

const trace = defineTool({
  name: "trace",
  description:
    "Candidate call paths from an entry point to dangerous sinks. 'from' is a route ('POST /api/login' or '/api/login') or a function name; 'to' is a sink kind or a function name (omit for any sink). Edges are resolved by name, so confirm each hop by reading the code.",
  args: z.object({ from: z.string().min(1), to: z.string().optional(), maxDepth: z.number().int().min(1).max(12).optional() }),
});

const deps = defineTool({
  name: "deps",
  description: "Dependencies with versions, whether the code imports them, and known vulnerabilities.",
  args: z.object({ vulnerableOnly: z.boolean().optional() }),
});

const leads = defineTool({
  name: "leads",
  description: "Deterministic leads from the signal sweep: committed secrets, vulnerable dependencies, text addressed to reviewers, and the riskiest sinks.",
  args: z.object({ kind: z.enum(["secret", "vulnerable_dependency", "injection_marker", "sink"]).optional() }),
});

const library = defineTool({
  name: "library_source",
  description:
    "Read a third-party dependency's real source at the exact version this repository installs, and return where a function, method or class is defined. Use it whenever an attack depends on how a library behaves — what it returns, its defaults, whether it validates, verifies or escapes — instead of relying on memory: APIs change between versions.",
  args: z.object({
    package: z.string().min(1).describe("Package name as in the lockfile, e.g. 'jsonwebtoken', 'totp-rs', 'golang.org/x/crypto', 'com.auth0:java-jwt'"),
    symbol: z.string().min(1).describe("Function, method or class to find, optionally qualified: 'verify', 'Totp.check_current', 'JWT::decode'"),
  }),
});

/** The exploration tools every agent gets. *//** The exploration tools every agent gets. */
export function repoTools(ctx: RepoToolContext): AgentTool[] {
  const call = <T>(tool: string, args: object, signal?: AbortSignal) => ctx.indexer.call<T>(tool, stripUndefined(args), signal);

  return [
    agentTool(search, async (args, signal) => {
      const result = await call<SearchResult>("search", args, signal);
      if (result.matches.length === 0) return "No matches.";
      const lines = result.matches.map((m) => `${m.file}:${m.line}: ${m.text}`);
      const more = result.truncated ? `\n(more matches exist; narrow the pattern or add a glob)` : "";
      return ctx.wrap(`${result.matches.length} matches in ${result.filesWithMatches} files${more}\n${lines.join("\n")}`);
    }),
    agentTool(readFile, async (args, signal) => {
      const result = await call<ReadResult>("read_file", args, signal);
      ctx.onRead?.(result.path);
      const numbered = numberLines(result.content, result.startLine);
      const more = result.truncated || result.endLine < result.totalLines ? `, more from line ${result.endLine + 1}` : "";
      return ctx.wrap(`${result.path} (lines ${result.startLine}-${result.endLine} of ${result.totalLines}${more})\n${numbered}`);
    }),
    agentTool(listDir, async (args, signal) => {
      const result = await call<ListResult>("list_dir", args, signal);
      const entries = result.entries.map((e) => (e.type === "dir" ? `${e.name}/` : e.lines === undefined ? e.name : `${e.name} (${e.lines} lines)`));
      return ctx.wrap(`${result.path || "."}\n${entries.join("\n")}`);
    }),
    agentTool(symbols, async (args, signal) => {
      const result = await call<{ symbols: SymbolInfo[] }>("symbols", args, signal);
      if (result.symbols.length === 0) return "No matching definitions.";
      return ctx.wrap(result.symbols.map((s) => `${s.kind} ${s.name} — ${s.file}:${s.line}-${s.endLine}`).join("\n"));
    }),
    agentTool(callers, async (args, signal) => {
      const result = await call<CallersResult>("callers", args, signal);
      if (result.callers.length === 0) return `No call sites found for ${args.symbol}.`;
      const lines = result.callers.map((c) => `${c.at} in ${c.caller}: ${c.call}(…)`);
      return ctx.wrap(`${result.total} call sites${result.total > lines.length ? ` (showing ${lines.length})` : ""}\n${lines.join("\n")}`);
    }),
    agentTool(callees, async (args, signal) => {
      const result = await call<CalleesResult>("callees", args, signal);
      if (result.definitions.length === 0) return `No definition found for ${args.symbol}.`;
      const blocks = result.definitions.map((d) => {
        const calls = d.calls.map((c) => `  line ${c.line}: ${c.call}${c.definedAt.length ? ` → ${c.definedAt.join(", ")}` : ""}`);
        return `${d.definition.name} (${d.definition.file}:${d.definition.line})\n${calls.join("\n") || "  (no calls)"}`;
      });
      return ctx.wrap(blocks.join("\n\n"));
    }),
    agentTool(routes, async (args, signal) => {
      const result = await call<RoutesResult>("routes", args, signal);
      if (result.routes.length === 0) return "No matching routes.";
      const lines = result.routes.map((r) => {
        const chain = r.chain.length ? ` [${r.chain.join(" → ")}]` : "";
        const handlers = r.handlers.length ? `\n    defined: ${r.handlers.join("; ")}` : "";
        return `${r.method} ${r.path} — ${r.at}${chain}${handlers}`;
      });
      return ctx.wrap(`${result.total} routes${result.total > lines.length ? ` (showing ${lines.length})` : ""}\n${lines.join("\n")}`);
    }),
    agentTool(sinks, async (args, signal) => {
      const result = await call<SinksResult>("sinks", args, signal);
      if (result.sinks.length === 0) return "No matching sinks.";
      const lines = result.sinks.map(formatSink);
      return ctx.wrap(`${result.total} sinks${result.total > lines.length ? ` (showing ${lines.length})` : ""}\n${lines.join("\n")}`);
    }),
    agentTool(trace, async (args, signal) => {
      const result = await call<TraceResult>("trace", args, signal);
      if (result.paths.length === 0) return `No call path found from ${args.from}${args.to ? ` to ${args.to}` : ""}. The link may be dynamic; read the handler.`;
      const paths = result.paths.map((path, i) => {
        const hops = path.hops.map((h) => `  ${h.symbol} (${h.definedAt})${h.callsNextAt ? ` → calls next at ${h.callsNextAt}` : ""}`);
        const sinkLines = path.sinks.map((s) => `  sink: ${formatSink(s)}`);
        return `Path ${i + 1}\n${hops.join("\n")}\n${sinkLines.join("\n")}`;
      });
      return ctx.wrap(`${paths.join("\n\n")}\n\n${result.note}`);
    }),
    agentTool(deps, async (args, signal) => {
      const result = await call<{ dependencies: Dependency[] }>("deps", {}, signal);
      const vulns = new Map(ctx.signals.vulns.map((v) => [`${v.ecosystem}:${v.name}@${v.version}`, v]));
      const rows = result.dependencies
        .map((dep) => ({ dep, vuln: vulns.get(`${dep.ecosystem}:${dep.name}@${dep.version}`) }))
        .filter(({ vuln }) => !args.vulnerableOnly || vuln)
        .sort((a, b) => Number(!!b.vuln) - Number(!!a.vuln))
        .slice(0, 300)
        .map(({ dep, vuln }) => {
          const use = dep.reachability === "imported" ? `imported at ${dep.importedAt?.join(", ")}` : dep.reachability.replace("_", " ");
          const flags = [dep.direct ? "direct" : "transitive", dep.dev ? "dev" : null, use].filter(Boolean).join(", ");
          const known = vuln ? `\n    ${vuln.advisories.map((a) => `${a.id} (${a.severity}${a.fixed ? `, fixed in ${a.fixed}` : ""}): ${a.summary}`).join("\n    ")}` : "";
          return `${dep.ecosystem} ${dep.name}@${dep.version} (${flags})${known}`;
        });
      if (rows.length === 0) return args.vulnerableOnly ? "No dependencies with known vulnerabilities." : "No dependencies found.";
      return ctx.wrap(rows.join("\n"));
    }),
    agentTool(library, async (args, signal) => {
      const { dependencies } = await call<{ dependencies: Dependency[] }>("deps", {}, signal);
      const wanted = args.package.trim().toLowerCase();
      const matches = dependencies.filter((dep) => dep.name.toLowerCase() === wanted && dep.version);
      if (matches.length === 0) return `${args.package} is not a dependency in this repository's lockfiles, so its installed version is unknown.`;
      // Prefer what the code actually imports, then direct dependencies.
      const dep = matches.sort((a, b) => Number(b.reachability === "imported") - Number(a.reachability === "imported") || Number(b.direct) - Number(a.direct))[0]!;
      const version = dep.version.replace(/^[=^~v]+(?=\d)/, "");
      let files;
      try {
        files = await librarySource({ ecosystem: dep.ecosystem, name: dep.name, version: dep.ecosystem === "Go" ? dep.version : version });
      } catch (error) {
        return `Could not fetch ${dep.name}@${dep.version} from its registry: ${(error as Error).message}. Judge from the repository's own code.`;
      }
      if (files.length === 0) return `No readable source published for ${dep.ecosystem} ${dep.name}@${dep.version}.`;
      const found = findDefinitions(files, args.symbol);
      if (found.length === 0) return `${args.symbol} is not defined in ${dep.name}@${dep.version} (${files.length} source files searched). Try the unqualified name or the module that exports it.`;
      return ctx.wrap(`${dep.ecosystem} ${dep.name}@${dep.version} — where ${args.symbol} is defined:\n\n${found.join("\n\n")}`);
    }),
    agentTool(leads, async (args) => {
      const all = ctx.signals.leads.filter((lead) => !args.kind || lead.kind === args.kind);
      if (all.length === 0) return "No leads.";
      return ctx.wrap(all.map(formatLead).join("\n"));
    }),
  ];
}

export function formatLead(lead: Lead): string {
  const severity = lead.severity ? ` [${lead.severity}]` : "";
  return `${lead.id} ${lead.kind}${severity}: ${lead.title}${lead.at ? ` at ${lead.at}` : ""} — ${lead.detail}`;
}

function formatSink(sink: SinkInfo): string {
  const reach = sink.reachable ? "" : ", no route reaches it";
  return `${sink.kind} (${sink.input} input${reach}) at ${sink.at} in ${sink.in}: ${sink.code}`;
}

export function numberLines(content: string, start: number): string {
  const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
  const width = String(start + lines.length - 1).length;
  return lines.map((line, i) => `${String(start + i).padStart(width)}| ${line}`).join("\n");
}

function stripUndefined(args: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
}

// Indexer response shapes.

interface SearchResult {
  matches: Array<{ file: string; line: number; text: string }>;
  truncated: boolean;
  filesWithMatches: number;
}

export interface ReadResult {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  content: string;
}

interface ListResult {
  path: string;
  entries: Array<{ name: string; type: "dir" | "file"; lines?: number }>;
}

interface SymbolInfo {
  name: string;
  kind: string;
  file: string;
  line: number;
  endLine: number;
}

interface CallersResult {
  callers: Array<{ caller: string; call: string; at: string }>;
  total: number;
}

interface CalleesResult {
  definitions: Array<{ definition: SymbolInfo; calls: Array<{ call: string; line: number; definedAt: string[] }> }>;
}

export interface RouteInfo {
  method: string;
  path: string;
  at: string;
  chain: string[];
  handlers: string[];
  framework: string;
}

interface RoutesResult {
  routes: RouteInfo[];
  total: number;
}

export interface SinkInfo {
  kind: string;
  at: string;
  in: string;
  call: string;
  input: "literal" | "variable" | "built";
  /** A route handler reaches it through the call graph. */
  reachable: boolean;
  code: string;
}

interface SinksResult {
  sinks: SinkInfo[];
  total: number;
}

interface TraceResult {
  paths: Array<{ hops: Array<{ symbol: string; definedAt: string; callsNextAt?: string }>; sinks: SinkInfo[] }>;
  note: string;
}

export interface Dependency {
  ecosystem: string;
  name: string;
  version: string;
  manifest: string;
  direct: boolean;
  dev: boolean;
  reachability: "imported" | "not_imported" | "unknown";
  importedAt?: string[];
}
