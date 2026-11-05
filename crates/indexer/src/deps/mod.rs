//! What a repository installs, read from its manifests and lockfiles, and where its code imports each
//! package. Vulnerability lookup happens in the engine; this module only says what is installed and where
//! it is used.
//!
//! Every file format is one parser (see [`formats::parser_for`]) turning a file into [`Entry`]s. How an
//! ecosystem's packages appear in import statements is one rule each (see `imports.rs`).

mod formats;
mod imports;
mod npm;

use std::collections::BTreeMap;
use std::collections::btree_map::Entry as Slot;

use serde::Serialize;

use crate::files::Store;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dep {
    /// OSV ecosystem name.
    pub ecosystem: &'static str,
    pub name: String,
    pub version: String,
    pub manifest: String,
    /// Declared directly by the project rather than pulled in by another package.
    pub direct: bool,
    pub dev: bool,
    /// The version is the lowest a manifest's range allows, because no lockfile pins it: what is installed
    /// may be newer.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub approximate: bool,
    pub reachability: Reachability,
    /// Up to ten `file:line` sites that import it, hand-written source before tests and generated code.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub imported_at: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reachability {
    Imported,
    NotImported,
    Unknown,
}

/// A package declared without a version because one outside the repository sets it: a parent POM or an
/// imported BOM only Maven Central has. The engine reads the version there.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Managed {
    #[serde(flatten)]
    pub dep: Dep,
    /// `group:artifact:version` of the POMs that may set it, in Maven's order of precedence.
    pub by: Vec<String>,
    /// The project's own properties, which can override a BOM's versions.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub properties: BTreeMap<String, String>,
}

/// What the repository installs, and what only an outside POM can put a version on.
#[derive(Default)]
pub struct Inventory {
    pub dependencies: Vec<Dep>,
    pub managed: Vec<Managed>,
    /// JVM import paths in shipped code (package level), with the first site of each: what the engine traces
    /// packages it resolves from Maven Central to.
    pub jvm_imports: Vec<(String, String)>,
}

/// An import site, as collected by the extractor.
pub struct ImportSite<'a> {
    pub spec: &'a str,
    pub file: &'a str,
    pub line: u32,
}

/// The POMs that set a version outside the repository, and the project properties that may override it.
type SetBy = (Vec<String>, BTreeMap<String, String>);

/// A package version one file names.
struct Entry {
    pub ecosystem: &'static str,
    pub name: String,
    pub version: String,
    pub direct: bool,
    pub dev: bool,
    pub approximate: bool,
    /// For a version set outside the repository: what sets it.
    pub managed: Option<SetBy>,
}

impl Entry {
    /// A package the project declares itself, at an exact version.
    pub fn new(ecosystem: &'static str, name: impl Into<String>, version: impl Into<String>) -> Entry {
        Entry { ecosystem, name: name.into(), version: version.into(), direct: true, dev: false, approximate: false, managed: None }
    }

    /// A package whose version these POMs set (see [`Managed`]).
    pub fn managed(ecosystem: &'static str, name: impl Into<String>, by: Vec<String>, properties: BTreeMap<String, String>) -> Entry {
        Entry { managed: Some((by, properties)), ..Entry::new(ecosystem, name, "") }
    }

    pub fn direct(self, direct: bool) -> Entry {
        Entry { direct, ..self }
    }

    pub fn dev(self, dev: bool) -> Entry {
        Entry { dev, ..self }
    }

    /// The version is a range (`>=2.0`, `^1.4`, `[1.0,2.0)`); its floor is the best guess.
    pub fn range(self) -> Entry {
        Entry { approximate: true, ..self }
    }
}

/// What reading the files learns besides versions: how packages resolve, and where they are used.
struct Context<'a> {
    pub store: &'a Store,
    pub npm: npm::Resolution<'a>,
    /// Namespace prefixes each Composer package autoloads (`monolog\` ⇢ monolog/monolog).
    pub namespaces: Vec<(String, String)>,
    /// Import sites a manifest is itself: a Gemfile line Bundler requires, a workflow's `uses:` line.
    pub sites: Vec<(&'static str, String, String)>,
    /// Every `pom.xml` in the repository by `group:artifact`, read once, for resolving versions through parents.
    pub poms: std::cell::OnceCell<std::collections::HashMap<String, formats::Pom>>,
}

pub fn collect(store: &Store, imports: &[ImportSite]) -> Inventory {
    let mut cx = Context { store, npm: npm::Resolution::new(store), namespaces: Vec::new(), sites: Vec::new(), poms: Default::default() };
    let mut deps: BTreeMap<(&'static str, String, String), Dep> = BTreeMap::new();
    let mut managed: BTreeMap<(String, String), SetBy> = BTreeMap::new();
    for file in store.files.iter().filter(|file| !in_fixtures(&file.path)) {
        let Some(parse) = formats::parser_for(&file.path) else { continue };
        for entry in parse(&mut cx, file) {
            if let Some(set_by) = entry.managed {
                managed.entry((entry.name, file.path.clone())).or_insert(set_by);
                continue;
            }
            let version = clean_version(&entry.version);
            if entry.name.is_empty() || version.is_empty() {
                continue;
            }
            match deps.entry((entry.ecosystem, entry.name.clone(), version.clone())) {
                Slot::Vacant(slot) => {
                    slot.insert(Dep::new(entry.ecosystem, entry.name, version, &file.path, entry.direct, entry.dev, entry.approximate));
                }
                Slot::Occupied(mut slot) => {
                    let dep = slot.get_mut();
                    dep.direct |= entry.direct;
                    dep.dev &= entry.dev;
                    dep.approximate &= entry.approximate;
                }
            }
        }
    }
    // Versioned or not, every package's imports are found the same way.
    let resolved = deps.len();
    let mut all: Vec<Dep> = deps.into_values().collect();
    let sets: Vec<_> = managed
        .into_iter()
        .map(|((name, manifest), set_by)| (Dep::new("Maven", name, String::new(), &manifest, true, false, false), set_by))
        .collect();
    let (unversioned, set_by): (Vec<Dep>, Vec<_>) = sets.into_iter().unzip();
    all.extend(unversioned);
    cx.npm.mark_direct(&mut all);
    let jvm_imports = imports::mark(&cx, &mut all, imports);
    let unversioned = all.split_off(resolved);
    Inventory {
        jvm_imports,
        dependencies: all,
        managed: unversioned.into_iter().zip(set_by).map(|(dep, (by, properties))| Managed { dep, by, properties }).collect(),
    }
}

impl Dep {
    fn new(ecosystem: &'static str, name: String, version: String, manifest: &str, direct: bool, dev: bool, approximate: bool) -> Dep {
        Dep {
            ecosystem,
            name,
            version,
            manifest: manifest.to_owned(),
            direct,
            dev,
            approximate,
            reachability: Reachability::Unknown,
            imported_at: Vec::new(),
        }
    }
}

/// Test fixtures and examples declare packages the product never installs.
fn in_fixtures(path: &str) -> bool {
    path.split('/').any(|segment| matches!(segment, "test" | "tests" | "fixtures" | "testdata" | "examples"))
}

/// A version as OSV compares it: an exact version or commit as written, or a range's floor (`^4.17.1`,
/// `>=1.2 <2`, `[1.0,2.0)` ⇢ `4.17.1`, `1.2`, `1.0`). Empty when there is no number to read (`latest`, `*`).
fn clean_version(raw: &str) -> String {
    if raw.len() == 40 && raw.bytes().all(|b| b.is_ascii_hexdigit()) {
        return raw.to_owned();
    }
    let trimmed = raw.trim().trim_start_matches(['^', '~', '=', '>', '<', 'v', ' ', '[', '(']).trim_start_matches("npm:");
    if trimmed.starts_with(|c: char| c.is_ascii_digit()) {
        trimmed.split([' ', ',', '|', ')', ']']).next().unwrap_or("").to_owned()
    } else {
        String::new()
    }
}

fn parent(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(dir, _)| dir)
}

/// `dir` joined with a path relative to it.
fn join(dir: &str, relative: &str) -> String {
    let relative = relative.trim_matches('/');
    match (dir.is_empty(), relative.is_empty() || relative == ".") {
        (_, true) => dir.to_owned(),
        (true, false) => relative.to_owned(),
        (false, false) => format!("{dir}/{relative}"),
    }
}

/// Whether a file named `name` sits in `dir`.
fn sibling(store: &Store, dir: &str, names: &[&str]) -> bool {
    names.iter().any(|name| store.get(&join(dir, name)).is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        assert_eq!(clean_version("^4.17.1"), "4.17.1");
        assert_eq!(clean_version(">=1.2 <2"), "1.2");
        assert_eq!(clean_version("latest"), "");
        assert_eq!(clean_version("v1.9.0"), "1.9.0");
        assert_eq!(clean_version("[1.0,2.0)"), "1.0");
        assert_eq!(clean_version("0.1-9"), "0.1-9");
    }
}
