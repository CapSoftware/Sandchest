//! npm: `package.json` and the npm, Yarn, pnpm and Bun lockfiles, and which version of a package each
//! workspace resolves. A lockfile often holds several versions of one package; only the one a file's own
//! workspace resolves is the one it imports.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use super::{Context, Dep, Entry, clean_version, join, parent};
use crate::files::{File, Store};

/// Lockfiles whose text says what is installed.
const LOCKFILES: &[&str] = &["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock"];

/// `package.json`: declared ranges. Their floors are only a guess, used when no lockfile above it can be read
/// (none committed, or Bun's binary `bun.lockb`).
pub fn manifest(cx: &mut Context, file: &File) -> Vec<Entry> {
    if cx.npm.lock_above(parent(&file.path)).is_some() {
        return Vec::new();
    }
    declared(&file.text).into_iter().map(|(name, range, dev)| Entry::new("npm", name, range).dev(dev).range()).collect()
}

pub fn package_lock(cx: &mut Context, file: &File) -> Vec<Entry> {
    let Ok(json) = serde_json::from_str::<Value>(&file.text) else { return Vec::new() };
    let dir = parent(&file.path);
    let (direct, _) = declared_below(cx.store, dir);
    let mut out = Vec::new();
    if let Some(packages) = json.get("packages").and_then(Value::as_object) {
        for (key, info) in packages {
            let Some(at) = key.rfind("node_modules/") else { continue };
            let name = &key[at + "node_modules/".len()..];
            let version = info.get("version").and_then(Value::as_str).unwrap_or("");
            let dev = info.get("dev").and_then(Value::as_bool).unwrap_or(false);
            out.push(Entry::new("npm", name, version).direct(direct.contains(name)).dev(dev));
            // `node_modules/x` is what every workspace gets; `apps/web/node_modules/x` only that workspace.
            let owner = key[..at].trim_end_matches('/');
            if owner.is_empty() {
                cx.npm.hoisted.insert((dir.to_owned(), name.to_owned()), clean_version(version));
            } else if !owner.contains("node_modules") {
                cx.npm.workspace.insert((join(dir, owner), name.to_owned()), clean_version(version));
            }
        }
    } else if let Some(dependencies) = json.get("dependencies") {
        walk_lock_v1(dependencies, &mut |name, version, dev| {
            out.push(Entry::new("npm", name, version).direct(direct.contains(name)).dev(dev))
        });
    }
    out
}

pub fn yarn_lock(cx: &mut Context, file: &File) -> Vec<Entry> {
    let dir = parent(&file.path);
    let (direct, dev_only) = declared_below(cx.store, dir);
    let (entries, specs) = parse_yarn_lock(&file.text);
    // Each workspace gets the entry its own manifest's range names. A nested project with a lockfile of its
    // own resolves its own.
    for (workspace, name, range) in manifests_below(cx.store, dir) {
        if cx.npm.lock_above(&workspace) != Some(dir) {
            continue;
        }
        if let Some(version) = specs.get(&format!("{name}@{range}")).or_else(|| specs.get(&format!("{name}@npm:{range}"))) {
            cx.npm.workspace.insert((workspace, name), clean_version(version));
        }
    }
    entries
        .into_iter()
        .map(|(name, version)| Entry::new("npm", &name, version).direct(direct.contains(&name)).dev(dev_only.contains(&name)))
        .collect()
}

pub fn pnpm_lock(cx: &mut Context, file: &File) -> Vec<Entry> {
    static PACKAGE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"(?m)^  ['"]?/?((?:@[^/@\s]+/)?[^/@\s:'"]+)[@/](\d[^:('"\s]*)"#).unwrap());
    let dir = parent(&file.path);
    let (direct, dev_only) = declared_below(cx.store, dir);
    for (importer, name, version) in parse_pnpm_importers(&file.text) {
        cx.npm.workspace.insert((join(dir, &importer), name), clean_version(&version));
    }
    PACKAGE
        .captures_iter(&file.text)
        .map(|c| Entry::new("npm", &c[1], &c[2]).direct(direct.contains(&c[1])).dev(dev_only.contains(&c[1])))
        .collect()
}

pub fn bun_lock(cx: &mut Context, file: &File) -> Vec<Entry> {
    let dir = parent(&file.path);
    let (direct, dev_only) = declared_below(cx.store, dir);
    let lock = parse_bun_lock(&file.text);
    for (key, name, version) in &lock.packages {
        // `zod` is what every workspace gets; `@acme/web/zod` only the workspace named @acme/web.
        if key == name {
            cx.npm.hoisted.insert((dir.to_owned(), name.clone()), clean_version(version));
        } else if let Some(workspace) = key.strip_suffix(&format!("/{name}")).and_then(|owner| lock.workspaces.get(owner)) {
            cx.npm.workspace.insert((join(dir, workspace), name.clone()), clean_version(version));
        }
    }
    lock.packages
        .into_iter()
        .map(|(_, name, version)| Entry::new("npm", &name, version).direct(direct.contains(&name)).dev(dev_only.contains(&name)))
        .collect()
}

/// Which version of an npm package each workspace gets, from the lockfiles that say so.
pub struct Resolution<'a> {
    /// (workspace directory, package) ⇢ version.
    workspace: HashMap<(String, String), String>,
    /// (lockfile directory, package) ⇢ the version at the top of that lockfile's tree.
    hoisted: HashMap<(String, String), String>,
    /// Directories holding a readable npm lockfile.
    lock_dirs: HashSet<&'a str>,
    /// Directories holding a `package.json`: the workspaces imports resolve from.
    manifests: HashSet<&'a str>,
}

impl<'a> Resolution<'a> {
    pub fn new(store: &'a Store) -> Resolution<'a> {
        let named = |names: &[&str]| -> HashSet<&'a str> {
            store
                .files
                .iter()
                .filter(|file| names.contains(&file.path.rsplit('/').next().unwrap_or(&file.path)) && !file.path.contains("node_modules/"))
                .map(|file| parent(&file.path))
                .collect()
        };
        Resolution { workspace: HashMap::new(), hoisted: HashMap::new(), lock_dirs: named(LOCKFILES), manifests: named(&["package.json"]) }
    }

    /// The nearest directory at or above `dir` holding a readable lockfile.
    fn lock_above<'d>(&self, dir: &'d str) -> Option<&'d str> {
        let mut at = dir;
        loop {
            if self.lock_dirs.contains(at) {
                return Some(at);
            }
            if at.is_empty() {
                return None;
            }
            at = parent(at);
        }
    }

    /// The version `name` resolves to from `file`, the way Node looks it up: the file's workspace, then each
    /// directory above it up to the lockfile, then the lockfile's top level. None when no lockfile says.
    pub fn resolve(&self, file: &str, name: &str) -> Option<&str> {
        let mut dir = parent(file);
        while !self.manifests.contains(dir) {
            if dir.is_empty() {
                return None;
            }
            dir = parent(dir);
        }
        loop {
            if let Some(version) = self.workspace.get(&(dir.to_owned(), name.to_owned())) {
                return Some(version);
            }
            if self.lock_dirs.contains(dir) {
                return self.hoisted.get(&(dir.to_owned(), name.to_owned())).map(String::as_str);
            }
            if dir.is_empty() {
                return None;
            }
            dir = parent(dir);
        }
    }

    /// Of several versions of one package, only those a workspace or the top level resolves are declared by the
    /// project; the rest were pulled in by other packages.
    pub fn mark_direct(&self, deps: &mut [Dep]) {
        let mut chosen: HashMap<&str, HashSet<&str>> = HashMap::new();
        for ((_, name), version) in self.workspace.iter().chain(self.hoisted.iter()) {
            chosen.entry(name.as_str()).or_default().insert(version.as_str());
        }
        let mut count: HashMap<&str, usize> = HashMap::new();
        for dep in deps.iter().filter(|dep| dep.ecosystem == "npm") {
            *count.entry(dep.name.as_str()).or_default() += 1;
        }
        let several: HashSet<String> = count.into_iter().filter(|(_, n)| *n > 1).map(|(name, _)| name.to_owned()).collect();
        for dep in deps.iter_mut().filter(|dep| dep.ecosystem == "npm" && several.contains(&dep.name)) {
            if let Some(versions) = chosen.get(dep.name.as_str()) {
                dep.direct &= versions.contains(dep.version.as_str());
            }
        }
    }
}

/// `lodash/fp` ⇢ `lodash`, `@scope/pkg/sub` ⇢ `@scope/pkg`.
pub fn package_of(spec: &str) -> Option<&str> {
    let mut parts = spec.splitn(3, '/');
    let first = parts.next()?;
    if first.starts_with('@') {
        let second = parts.next()?;
        Some(&spec[..first.len() + 1 + second.len()])
    } else {
        Some(first)
    }
}

/// `(name, range, dev)` for everything one `package.json` declares.
fn declared(text: &str) -> Vec<(String, String, bool)> {
    let Ok(json) = serde_json::from_str::<Value>(text) else { return Vec::new() };
    [("dependencies", false), ("devDependencies", true), ("optionalDependencies", false)]
        .into_iter()
        .flat_map(|(section, dev)| {
            json.get(section)
                .and_then(Value::as_object)
                .into_iter()
                .flatten()
                .filter_map(move |(name, range)| Some((name.clone(), range.as_str()?.to_owned(), dev)))
        })
        .collect()
}

/// Every `package.json` at or below `dir` (outside node_modules): `(its directory, name, range)`.
fn manifests_below(store: &Store, dir: &str) -> Vec<(String, String, String)> {
    let prefix = if dir.is_empty() { String::new() } else { format!("{dir}/") };
    store
        .files
        .iter()
        .filter(|file| {
            file.path.starts_with(&prefix) && file.path.rsplit('/').next() == Some("package.json") && !file.path.contains("node_modules/")
        })
        .flat_map(|file| declared(&file.text).into_iter().map(|(name, range, _)| (parent(&file.path).to_owned(), name, range)))
        .collect()
}

/// What the manifests a lockfile covers declare: every package named in any of them, and those named only
/// as dev dependencies.
fn declared_below(store: &Store, dir: &str) -> (HashSet<String>, HashSet<String>) {
    let prefix = if dir.is_empty() { String::new() } else { format!("{dir}/") };
    let (mut shipped, mut dev) = (HashSet::new(), HashSet::new());
    for file in store.files.iter().filter(|file| {
        file.path.starts_with(&prefix) && file.path.rsplit('/').next() == Some("package.json") && !file.path.contains("node_modules/")
    }) {
        let Ok(json) = serde_json::from_str::<Value>(&file.text) else { continue };
        for (section, is_dev) in
            [("dependencies", false), ("devDependencies", true), ("optionalDependencies", false), ("peerDependencies", false)]
        {
            for name in json.get(section).and_then(Value::as_object).into_iter().flat_map(|deps| deps.keys()) {
                (if is_dev { &mut dev } else { &mut shipped }).insert(name.clone());
            }
        }
    }
    let dev_only = dev.difference(&shipped).cloned().collect();
    (shipped.union(&dev).cloned().collect(), dev_only)
}

fn walk_lock_v1(dependencies: &Value, add: &mut dyn FnMut(&str, &str, bool)) {
    for (name, info) in dependencies.as_object().into_iter().flatten() {
        let version = info.get("version").and_then(Value::as_str).unwrap_or("");
        add(name, version, info.get("dev").and_then(Value::as_bool).unwrap_or(false));
        if let Some(nested) = info.get("dependencies") {
            walk_lock_v1(nested, add);
        }
    }
}

/// Classic and Berry `yarn.lock`: an unindented header naming `pkg@range` entries, followed by an indented
/// `version` line. Also returns every `name@range` the entries were resolved for, mapped to the version.
fn parse_yarn_lock(text: &str) -> (Vec<(String, String)>, HashMap<String, String>) {
    let mut out = Vec::new();
    let mut specs = HashMap::new();
    let mut current: Option<(String, Vec<String>)> = None;
    for line in text.lines() {
        if !line.starts_with(' ') && line.ends_with(':') && !line.starts_with('#') {
            let all: Vec<String> = line.trim_end_matches(':').split(", ").map(|spec| spec.trim_matches('"').to_owned()).collect();
            let first = all.first().map_or("", String::as_str);
            let at = first.char_indices().skip(1).find(|&(_, c)| c == '@').map(|(i, _)| i);
            current = at.map(|i| (first[..i].to_owned(), all.clone()));
        } else if let Some((name, all)) = &current {
            let trimmed = line.trim_start();
            if let Some(version) = trimmed.strip_prefix("version ").or_else(|| trimmed.strip_prefix("version: ")) {
                let version = version.trim_matches('"').to_owned();
                for spec in all {
                    specs.insert(spec.clone(), version.clone());
                }
                out.push((name.clone(), version));
                current = None;
            }
        }
    }
    (out, specs)
}

/// Bun's text lockfile (`bun.lock`, Bun 1.2+), JSON with trailing commas.
struct BunLock {
    /// `(key, name, version)` for each package with a registry version. Each entry under `packages` is an
    /// array whose first item is `name@version`; workspace, link and git entries carry no registry version.
    packages: Vec<(String, String, String)>,
    /// Workspace package name ⇢ its directory, relative to the lockfile.
    workspaces: HashMap<String, String>,
}

fn parse_bun_lock(text: &str) -> BunLock {
    let mut lock = BunLock { packages: Vec::new(), workspaces: HashMap::new() };
    let Ok(json) = serde_json::from_str::<Value>(&strip_trailing_commas(text)) else { return lock };
    for (dir, workspace) in json.get("workspaces").and_then(Value::as_object).into_iter().flatten() {
        if let Some(name) = workspace.get("name").and_then(Value::as_str) {
            lock.workspaces.insert(name.to_owned(), dir.clone());
        }
    }
    for (key, entry) in json.get("packages").and_then(Value::as_object).into_iter().flatten() {
        let Some(spec) = entry.get(0).and_then(Value::as_str) else { continue };
        let Some(at) = spec.char_indices().skip(1).find(|&(_, c)| c == '@').map(|(i, _)| i) else { continue };
        let (name, version) = (&spec[..at], &spec[at + 1..]);
        if version.starts_with(|c: char| c.is_ascii_digit()) {
            lock.packages.push((key.clone(), name.to_owned(), version.to_owned()));
        }
    }
    lock
}

/// `importers` of a pnpm lockfile: `(workspace directory relative to the lockfile, package, version)`.
/// Version 6+ puts the version on its own `version:` line; 5.x writes `name: version` inline.
fn parse_pnpm_importers(text: &str) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    let (mut inside, mut importer, mut section, mut package) = (false, String::new(), false, None::<String>);
    let unquote = |text: &str| text.trim().trim_matches(|c| c == '\'' || c == '"').to_owned();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let indent = line.len() - line.trim_start().len();
        let trimmed = line.trim();
        if indent == 0 {
            inside = trimmed == "importers:";
            continue;
        }
        if !inside {
            continue;
        }
        match indent {
            2 => {
                importer = unquote(trimmed.trim_end_matches(':'));
                if importer == "." {
                    importer.clear();
                }
                section = false;
            }
            4 => section = matches!(trimmed, "dependencies:" | "devDependencies:" | "optionalDependencies:"),
            6 if section => {
                let (name, inline) = split_yaml_key(trimmed);
                package = Some(unquote(name));
                if let Some(version) = inline.filter(|v| !v.is_empty()) {
                    out.push((importer.clone(), unquote(name), pnpm_version(&unquote(version))));
                    package = None;
                }
            }
            8 if section => {
                if let (Some(name), Some(version)) = (&package, trimmed.strip_prefix("version:")) {
                    out.push((importer.clone(), name.clone(), pnpm_version(&unquote(version))));
                }
            }
            _ => {}
        }
    }
    out
}

/// `name: value` ⇢ (`name`, Some(`value`)); handles quoted names holding `@` and `/`.
fn split_yaml_key(line: &str) -> (&str, Option<&str>) {
    let quoted = line.starts_with('\'') || line.starts_with('"');
    let search_from = if quoted { line[1..].find(['\'', '"']).map_or(0, |i| i + 2) } else { 0 };
    match line[search_from..].find(':') {
        Some(i) => (&line[..search_from + i], Some(line[search_from + i + 1..].trim())),
        None => (line, None),
    }
}

/// `15.5.3(react@19.0.0)` (pnpm 6+) and `15.5.3_react@19.0.0` (pnpm 5) ⇢ `15.5.3`.
fn pnpm_version(raw: &str) -> String {
    raw.split(['(', '_']).next().unwrap_or("").to_owned()
}

/// Removes commas that close a JSON object or array (`[1, 2,]`), outside strings.
pub(super) fn strip_trailing_commas(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let (mut in_string, mut escaped) = (false, false);
    for (i, c) in text.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
        } else if c == '"' {
            in_string = true;
        } else if c == ',' {
            let next = bytes[i + 1..].iter().find(|b| !b.is_ascii_whitespace());
            if matches!(next, Some(b'}') | Some(b']')) {
                continue;
            }
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn yarn_lock() {
        let text = "\"@babel/core@^7.0.0\", \"@babel/core@^7.1.0\":\n  version \"7.2.0\"\n\nlodash@^4.17.0:\n  version \"4.17.21\"\n";
        let (entries, specs) = parse_yarn_lock(text);
        assert_eq!(entries, vec![("@babel/core".into(), "7.2.0".into()), ("lodash".into(), "4.17.21".into())]);
        assert_eq!(specs.get("@babel/core@^7.1.0").map(String::as_str), Some("7.2.0"));
    }

    #[test]
    fn bun_lock() {
        let text = r#"{
  "lockfileVersion": 1,
  "workspaces": { "": { "name": "app", "dependencies": { "next": "^15.0.0", }, }, },
  "packages": {
    "next": ["next@15.5.3", "", { "dependencies": { "react": "19.0.0" } }, "sha512-x"],
    "@babel/core": ["@babel/core@7.2.0", "", {}, "sha512-y",],
    "app/zod": ["zod@3.24.2", "", {}, "sha512-z"],
    "@acme/db": ["@acme/db@workspace:packages/db"],
    "left-pad": ["left-pad@github:acme/left-pad#abc", {}],
    "quote, \"comma,]\"": ["odd@1.0.0"],
  },
}"#;
        let mut parsed: Vec<(String, String)> =
            parse_bun_lock(text).packages.into_iter().map(|(_, name, version)| (name, version)).collect();
        parsed.sort();
        assert_eq!(
            parsed,
            vec![
                ("@babel/core".into(), "7.2.0".into()),
                ("next".into(), "15.5.3".into()),
                ("odd".into(), "1.0.0".into()),
                ("zod".into(), "3.24.2".into())
            ]
        );
    }

    #[test]
    fn trailing_commas_inside_strings_are_kept() {
        assert_eq!(strip_trailing_commas(r#"{"a": "x,}", "b": [1, 2,],}"#), r#"{"a": "x,}", "b": [1, 2]}"#);
    }

    #[test]
    fn packages_of_specs() {
        assert_eq!(package_of("lodash/fp"), Some("lodash"));
        assert_eq!(package_of("@scope/pkg/sub"), Some("@scope/pkg"));
    }
}
