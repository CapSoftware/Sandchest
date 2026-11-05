/**
 * What a JVM project without a lockfile installs, resolved the way Maven does: versions set by a parent or
 * BOM on Maven Central, and every artifact the declared ones pull in (nearest declaration wins, the root's
 * dependencyManagement pins versions throughout). Published POMs never change, so each is kept once read.
 * Only coordinates are sent; never code.
 */
import { XMLParser } from "fast-xml-parser";
import type { Dependency } from "../scan/tools";

const CENTRAL = "https://repo1.maven.org/maven2";
/** Artifacts resolved per project, and how deep: enough for the largest Spring applications. */
const MAX_ARTIFACTS = 2_000;
const MAX_DEPTH = 16;
const FETCH_CONCURRENCY = 16;
/** POMs kept in memory, oldest dropped first: a few kilobytes each. */
const MAX_CACHED = 20_000;

/** A package the indexer found declared without a version, and the POMs that may set it. */
export interface Managed extends Dependency {
  by: string[];
  properties?: Record<string, string>;
}

/** A JVM import path in shipped code, by package, with its first site. */
export interface JvmImport {
  package: string;
  at: string;
}

interface Declared {
  key: string;
  version?: string;
  scope: string;
  optional: boolean;
  type: string;
}

/** A POM with its parents applied: what it manages and declares, and the properties its versions use. */
interface Model {
  properties: Record<string, string>;
  /** `group:artifact` ⇢ version, uninterpolated. */
  managed: Map<string, string>;
  dependencies: Declared[];
}

export interface MavenRepository {
  /** The effective model of `group:artifact:version`, or undefined when Maven Central has no such POM. */
  model(gav: string, signal?: AbortSignal): Promise<Model | undefined>;
}

const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, isArray: (name) => name === "dependency" });

export function createMavenRepository(options: { fetch?: typeof fetch; timeoutMs?: number } = {}): MavenRepository {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const poms = new Map<string, Promise<Model | undefined>>();

  async function pom(gav: string, signal?: AbortSignal): Promise<Record<string, any> | undefined> {
    const [group, artifact, version] = gav.split(":");
    if (!group || !artifact || !version || version.includes("$")) return undefined;
    const url = `${CENTRAL}/${group.replaceAll(".", "/")}/${artifact}/${version}/${artifact}-${version}.pom`;
    const response = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Maven Central returned ${response.status} for ${gav}`);
    return parser.parse(await response.text())?.project;
  }

  async function build(gav: string, signal: AbortSignal | undefined, depth: number): Promise<Model | undefined> {
    const project = await pom(gav, signal);
    if (!project) return undefined;
    const [group, artifact, version] = gav.split(":") as [string, string, string];
    const parentGav = project.parent ? `${text(project.parent.groupId)}:${text(project.parent.artifactId)}:${text(project.parent.version)}` : undefined;
    const parent = parentGav && depth < MAX_DEPTH ? await model(parentGav, signal, depth + 1) : undefined;
    const properties: Record<string, string> = {
      ...parent?.properties,
      ...Object.fromEntries(Object.entries(project.properties ?? {}).map(([key, value]) => [key, text(value)])),
      "project.groupId": group,
      "project.artifactId": artifact,
      "project.version": version,
      version,
      ...(project.parent && { "project.parent.version": text(project.parent.version), "project.parent.groupId": text(project.parent.groupId) }),
    };
    const managed = new Map(parent?.managed);
    const imports: string[] = [];
    for (const dep of declared(project.dependencyManagement?.dependencies?.dependency)) {
      if (dep.scope === "import") imports.push(`${dep.key}:${interpolate(dep.version ?? "", properties)}`);
      else if (dep.version) managed.set(dep.key, dep.version);
    }
    // An imported BOM is resolved on its own, and only fills what this POM and its parents leave unset.
    for (const bom of imports) {
      const imported = depth < MAX_DEPTH ? await model(bom, signal, depth + 1) : undefined;
      for (const [key, raw] of imported?.managed ?? []) if (!managed.has(key)) managed.set(key, interpolate(raw, imported!.properties));
    }
    const own = declared(project.dependencies?.dependency);
    const dependencies = [...(parent?.dependencies ?? []).filter((d) => !own.some((o) => o.key === d.key)), ...own];
    return { properties, managed, dependencies };
  }

  function model(gav: string, signal?: AbortSignal, depth = 0): Promise<Model | undefined> {
    let pending = poms.get(gav);
    if (!pending) {
      pending = build(gav, signal, depth).catch((error: unknown) => {
        poms.delete(gav);
        throw error;
      });
      poms.set(gav, pending);
      if (poms.size > MAX_CACHED) poms.delete(poms.keys().next().value!);
    }
    return pending;
  }

  return { model: (gav, signal) => model(gav, signal) };
}

/**
 * The Maven artifacts a project installs beyond the versioned ones the indexer read: the versionless ones
 * a parent or BOM sets, and everything the declared ones pull in. An artifact the code's imports name is
 * traced to the import; one nothing names is `unknown` (Java packages rarely match coordinates, so no match
 * proves nothing). Throws when Maven Central can't be read: a partial answer would read as upgrades.
 */
export async function resolveMaven(
  repository: MavenRepository,
  input: { dependencies: Dependency[]; managed: Managed[]; imports: JvmImport[] },
  signal?: AbortSignal,
): Promise<Dependency[]> {
  const out: Dependency[] = [];
  const byManifest = new Map<string, { direct: Dependency[]; managed: Managed[] }>();
  for (const dep of input.dependencies.filter((d) => d.ecosystem === "Maven")) group(byManifest, dep.manifest).direct.push(dep);
  for (const dep of input.managed) group(byManifest, dep.manifest).managed.push(dep);

  for (const [manifest, { direct, managed }] of byManifest) {
    // A lockfile already lists everything installed.
    if (manifest.endsWith(".lockfile")) continue;
    // The root's management, from the POMs outside the repository that set it, in Maven's order.
    const root = new Map<string, string>();
    const sources = [...new Set(managed.flatMap((d) => d.by))];
    const models = await mapLimit(sources, FETCH_CONCURRENCY, (gav) => repository.model(gav, signal));
    const overrides = managed.find((d) => d.properties)?.properties ?? {};
    for (const model of models) {
      for (const [key, raw] of model?.managed ?? []) if (!root.has(key)) root.set(key, interpolate(raw, { ...model!.properties, ...overrides }));
    }
    const declared: Dependency[] = [
      ...direct,
      ...managed.flatMap(({ by: _, properties: __, ...dep }) => (root.get(dep.name) ? [{ ...dep, version: root.get(dep.name)! }] : [])),
    ];
    out.push(...declared.filter((d) => !direct.includes(d)));

    // Breadth first, so the nearest declaration of an artifact is the one kept.
    const seen = new Map<string, { version: string; dev: boolean }>(declared.map((d) => [d.name, { version: d.version, dev: d.dev }]));
    let level = declared.filter((d) => !/\$\{/.test(d.version)).map((d) => ({ key: d.name, version: d.version, dev: d.dev }));
    for (let depth = 0; level.length > 0 && depth < MAX_DEPTH && seen.size < MAX_ARTIFACTS; depth++) {
      const models = await mapLimit(level, FETCH_CONCURRENCY, (node) => repository.model(`${node.key}:${node.version}`, signal));
      const next: typeof level = [];
      level.forEach((node, i) => {
        const model = models[i];
        for (const dep of model?.dependencies ?? []) {
          if (dep.optional || !["compile", "runtime"].includes(dep.scope) || dep.type !== "jar" || seen.has(dep.key) || seen.size >= MAX_ARTIFACTS) continue;
          const raw = root.get(dep.key) ?? (dep.version ? interpolate(dep.version, model!.properties) : model!.managed.get(dep.key) && interpolate(model!.managed.get(dep.key)!, model!.properties));
          const version = raw ? soft(raw) : undefined;
          if (!version || version.includes("$")) continue;
          seen.set(dep.key, { version, dev: node.dev });
          next.push({ key: dep.key, version, dev: node.dev });
          const at = traced(dep.key, input.imports);
          out.push({ ecosystem: "Maven", name: dep.key, version, manifest, direct: false, dev: node.dev, reachability: at ? "imported" : "unknown", importedAt: at ? [at] : [] });
        }
      });
      level = next;
    }
  }
  return out;
}

/** The site of the first import within the artifact's group, or whose segments spell its artifact id. */
function traced(key: string, imports: JvmImport[]): string | undefined {
  const [group, artifact = ""] = key.split(":");
  const want = squash(artifact);
  return imports.find(({ package: path }) => {
    if (path === group || path.startsWith(`${group}.`)) return true;
    const segments = path.split(".").map(squash);
    return segments.some((_, i) => segments.slice(i).join("").startsWith(want) && spellsAt(segments.slice(i), want));
  })?.at;
}

function spellsAt(segments: string[], want: string): boolean {
  let have = "";
  for (const segment of segments) {
    have += segment;
    if (have.length >= want.length) return have === want;
  }
  return false;
}

function squash(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function group(map: Map<string, { direct: Dependency[]; managed: Managed[] }>, manifest: string) {
  let entry = map.get(manifest);
  if (!entry) map.set(manifest, (entry = { direct: [], managed: [] }));
  return entry;
}

function declared(list: unknown): Declared[] {
  return (Array.isArray(list) ? list : [])
    .map((dep: Record<string, unknown>) => ({
      key: `${text(dep.groupId)}:${text(dep.artifactId)}`,
      version: dep.version === undefined ? undefined : text(dep.version),
      scope: text(dep.scope) || "compile",
      optional: text(dep.optional) === "true",
      type: text(dep.type) || "jar",
    }))
    .filter((dep) => !dep.key.startsWith(":") && !dep.key.endsWith(":"));
}

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}

/** `${name}` replaced from the properties, nested up to five deep. */
export function interpolate(value: string, properties: Record<string, string>): string {
  let out = value;
  for (let i = 0; i < 5 && out.includes("${"); i++) out = out.replace(/\$\{([^}]+)\}/g, (whole, key: string) => properties[key] ?? whole);
  return out;
}

/** A version range's preferred version: Maven picks the highest it allows, which is unknowable here, so the floor. */
function soft(version: string): string {
  const range = /^[[(]\s*([^,\])]*)/.exec(version);
  return range ? range[1]!.trim() : version;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!);
      }
    }),
  );
  return results;
}
