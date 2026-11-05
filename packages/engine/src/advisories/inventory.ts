/**
 * A repository's dependency inventory: what the indexer read from its
 * manifests and lockfiles, with how close each package is to shipped code.
 * Stored between scans so a new advisory can be matched without the code.
 */
import { isNonProductAt } from "../scan/paths";
import type { Dependency } from "../scan/tools";
import { packageKey } from "./record";

/**
 * How the code uses a package. `product`: imported by shipped code.
 * `tooling`: imported only by tests, config or scripts in dot-directories.
 * `none`: installed but imported by none of the code (pulled in by another
 * package, or declared and unused). `unknown`: the ecosystem's imports aren't
 * traced (Rust, PHP, Ruby).
 */
export type Usage = "product" | "tooling" | "none" | "unknown";

export interface InventoryEntry {
  ecosystem: string;
  name: string;
  /** `name` as compared with advisories (see `packageKey`). */
  key: string;
  version: string;
  /** The lockfile (or manifest) the version was read from. */
  manifest: string;
  direct: boolean;
  dev: boolean;
  usage: Usage;
  /**
   * The version is the lowest a manifest's range allows, because no lockfile
   * was read: what is installed may well be newer.
   */
  approximate: boolean;
  /** Up to ten `file:line` import sites, shipped code first. */
  importedAt: string[];
}

const MAX_SITES = 10;

export function toInventory(dependencies: Dependency[]): InventoryEntry[] {
  // A version read from a lockfile beats a range's floor for the same package.
  const locked = new Set(dependencies.filter((d) => d.version && !fromRange(d)).map((d) => `${d.ecosystem}\0${packageKey(d.ecosystem, d.name)}`));
  const seen = new Set<string>();
  const out: InventoryEntry[] = [];
  for (const dep of dependencies) {
    if (!dep.version) continue;
    const key = packageKey(dep.ecosystem, dep.name);
    const approximate = fromRange(dep);
    if (approximate && locked.has(`${dep.ecosystem}\0${key}`)) continue;
    const identity = `${dep.ecosystem}\0${key}\0${dep.version}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const sites = dep.importedAt ?? [];
    const product = sites.filter((s) => !isNonProductAt(s));
    out.push({
      ecosystem: dep.ecosystem,
      name: dep.name,
      key,
      version: dep.version,
      manifest: dep.manifest,
      direct: dep.direct,
      dev: dep.dev,
      usage: dep.reachability === "unknown" ? "unknown" : dep.reachability === "not_imported" ? "none" : product.length > 0 ? "product" : "tooling",
      approximate,
      importedAt: [...product, ...sites.filter((s) => isNonProductAt(s))].slice(0, MAX_SITES),
    });
  }
  return out;
}

/** npm versions read from `package.json` are a range's floor, not what is installed. */
function fromRange(dep: Dependency): boolean {
  return dep.ecosystem === "npm" && (dep.manifest === "package.json" || dep.manifest.endsWith("/package.json"));
}
