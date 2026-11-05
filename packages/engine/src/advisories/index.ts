export { createOsvCatalog, stampMs, type Change, type OsvCatalog, type PackageVersion } from "./catalog";
export { cvss3Score, scoreSeverity } from "./cvss";
export { toInventory, type InventoryEntry, type Usage } from "./inventory";
export { fixedVersion, packageKey, toAdvisoryRecord, type AdvisoryRecord, type AdvisorySeverity, type AffectedPackage, type AffectedRange, type OsvRecord } from "./record";

/** The ecosystems the indexer reads, by their OSV names. */
export const ECOSYSTEMS = ["npm", "PyPI", "Go", "Maven", "crates.io", "Packagist", "RubyGems"] as const;
