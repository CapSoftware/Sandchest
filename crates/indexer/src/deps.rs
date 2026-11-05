//! Dependencies from manifests and lockfiles, and whether the code imports them.
//! Vulnerability lookup happens in the engine; this module only says what is
//! installed and where it is used.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;
use serde_json::Value;

use crate::files::{Class, Store};

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

/// An import site, as collected by the extractor.
pub struct ImportSite<'a> {
    pub spec: &'a str,
    pub file: &'a str,
    pub line: u32,
}

pub fn collect(store: &Store, imports: &[ImportSite]) -> Vec<Dep> {
    let mut deps: BTreeMap<(&'static str, String, String), Dep> = BTreeMap::new();
    let mut resolution = NpmResolution::default();
    let mut add = |ecosystem: &'static str, name: &str, version: &str, manifest: &str, direct: bool, dev: bool| {
        let version = clean_version(version);
        if name.is_empty() || version.is_empty() {
            return;
        }
        let key = (ecosystem, name.to_owned(), version.clone());
        let entry = deps.entry(key).or_insert_with(|| Dep {
            ecosystem,
            name: name.to_owned(),
            version,
            manifest: manifest.to_owned(),
            direct,
            dev,
            reachability: Reachability::Unknown,
            imported_at: Vec::new(),
        });
        entry.direct |= direct;
        entry.dev &= dev;
    };

    for file in &store.files {
        if file.path.split('/').any(|segment| matches!(segment, "test" | "tests" | "fixtures" | "testdata" | "examples")) {
            continue;
        }
        let path = file.path.as_str();
        let dir = path.rsplit_once('/').map_or("", |(dir, _)| dir);
        let text = file.text.as_str();
        match path.rsplit('/').next().unwrap_or(path) {
            "package.json" => {
                let Ok(json) = serde_json::from_str::<Value>(text) else { continue };
                // A workspace package's versions live in the lockfile at the workspace root, above it.
                let has_lock = npm_lock_above(store, dir);
                for (section, dev) in [("dependencies", false), ("devDependencies", true), ("optionalDependencies", false)] {
                    for (name, range) in json.get(section).and_then(Value::as_object).into_iter().flatten() {
                        // Without a lockfile, the lowest version a range allows is the best guess.
                        let version = if has_lock { "" } else { range.as_str().unwrap_or("") };
                        add("npm", name, version, path, true, dev);
                    }
                }
            }
            "package-lock.json" | "npm-shrinkwrap.json" => {
                let Ok(json) = serde_json::from_str::<Value>(text) else { continue };
                let (direct, _) = declared_npm(store, dir);
                if let Some(packages) = json.get("packages").and_then(Value::as_object) {
                    resolution.lock_dirs.insert(dir.to_owned());
                    for (key, info) in packages {
                        let Some(at) = key.rfind("node_modules/") else { continue };
                        let name = &key[at + "node_modules/".len()..];
                        let version = info.get("version").and_then(Value::as_str).unwrap_or("");
                        let dev = info.get("dev").and_then(Value::as_bool).unwrap_or(false);
                        add("npm", name, version, path, direct.contains(name), dev);
                        // `node_modules/x` is what every workspace gets; `apps/web/node_modules/x` only that workspace.
                        let owner = key[..at].trim_end_matches('/');
                        if owner.is_empty() {
                            resolution.hoisted.insert((dir.to_owned(), name.to_owned()), clean_version(version));
                        } else if !owner.contains("node_modules") {
                            resolution.workspace.insert((join(dir, owner), name.to_owned()), clean_version(version));
                        }
                    }
                } else if let Some(dependencies) = json.get("dependencies") {
                    walk_lock_v1(dependencies, &mut |name, version, dev| add("npm", name, version, path, direct.contains(name), dev));
                }
            }
            "yarn.lock" => {
                let (direct, dev_only) = declared_npm(store, dir);
                let (entries, specs) = parse_yarn_lock(text);
                for (name, version) in entries {
                    add("npm", &name, &version, path, direct.contains(name.as_str()), dev_only.contains(name.as_str()));
                }
                // Each workspace gets the entry its own manifest's range names.
                resolution.lock_dirs.insert(dir.to_owned());
                for (workspace, name, range) in npm_manifests(store, dir) {
                    let found = specs.get(&format!("{name}@{range}")).or_else(|| specs.get(&format!("{name}@npm:{range}")));
                    if let Some(version) = found {
                        resolution.workspace.insert((workspace, name), clean_version(version));
                    }
                }
            }
            "pnpm-lock.yaml" => {
                let (direct, dev_only) = declared_npm(store, dir);
                for captures in PNPM_PACKAGE.captures_iter(text) {
                    add("npm", &captures[1], &captures[2], path, direct.contains(&captures[1]), dev_only.contains(&captures[1]));
                }
                resolution.lock_dirs.insert(dir.to_owned());
                for (importer, name, version) in parse_pnpm_importers(text) {
                    resolution.workspace.insert((join(dir, &importer), name), clean_version(&version));
                }
            }
            "bun.lock" => {
                let (direct, dev_only) = declared_npm(store, dir);
                let lock = parse_bun_lock(text);
                resolution.lock_dirs.insert(dir.to_owned());
                for (key, name, version) in &lock.packages {
                    add("npm", name, version, path, direct.contains(name.as_str()), dev_only.contains(name.as_str()));
                    // `zod` is what every workspace gets; `@acme/web/zod` only the workspace named @acme/web.
                    if key == name {
                        resolution.hoisted.insert((dir.to_owned(), name.clone()), clean_version(version));
                    } else if let Some(workspace) = key.strip_suffix(&format!("/{name}")).and_then(|owner| lock.workspaces.get(owner)) {
                        resolution.workspace.insert((join(dir, workspace), name.clone()), clean_version(version));
                    }
                }
            }
            name if name.starts_with("requirements") && name.ends_with(".txt") => {
                let dev = name.contains("dev") || name.contains("test");
                for captures in REQUIREMENT.captures_iter(text) {
                    add("PyPI", &captures[1], &captures[2], path, true, dev);
                }
            }
            "Pipfile.lock" => {
                let Ok(json) = serde_json::from_str::<Value>(text) else { continue };
                for (section, dev) in [("default", false), ("develop", true)] {
                    for (name, info) in json.get(section).and_then(Value::as_object).into_iter().flatten() {
                        add("PyPI", name, info.get("version").and_then(Value::as_str).unwrap_or(""), path, true, dev);
                    }
                }
            }
            "poetry.lock" | "uv.lock" | "Cargo.lock" => {
                let ecosystem = if path.ends_with("Cargo.lock") { "crates.io" } else { "PyPI" };
                for captures in TOML_PACKAGE.captures_iter(text) {
                    add(ecosystem, &captures[1], &captures[2], path, false, false);
                }
            }
            "go.mod" => {
                for captures in GO_REQUIRE.captures_iter(text) {
                    add("Go", &captures[1], &captures[2], path, captures.get(3).is_none(), false);
                }
            }
            "pom.xml" => {
                for (name, version) in parse_pom(text) {
                    add("Maven", &name, &version, path, true, false);
                }
            }
            "build.gradle" | "build.gradle.kts" => {
                for captures in GRADLE_DEP.captures_iter(text) {
                    add("Maven", &format!("{}:{}", &captures[1], &captures[2]), &captures[3], path, true, false);
                }
            }
            "composer.lock" => {
                let Ok(json) = serde_json::from_str::<Value>(text) else { continue };
                for (section, dev) in [("packages", false), ("packages-dev", true)] {
                    for package in json.get(section).and_then(Value::as_array).into_iter().flatten() {
                        let name = package.get("name").and_then(Value::as_str).unwrap_or("");
                        add("Packagist", name, package.get("version").and_then(Value::as_str).unwrap_or(""), path, false, dev);
                    }
                }
            }
            "Gemfile.lock" => {
                for captures in GEM_SPEC.captures_iter(text) {
                    add("RubyGems", &captures[1], &captures[2], path, false, false);
                }
            }
            _ => {}
        }
    }

    let mut deps: Vec<Dep> = deps.into_values().collect();
    resolution.mark_direct(&mut deps);
    mark_reachability(store, &mut deps, imports, &resolution);
    deps
}

static PNPM_PACKAGE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?m)^  ['"]?/?((?:@[^/@\s]+/)?[^/@\s:'"]+)[@/](\d[^:('"\s]*)"#).unwrap());
static REQUIREMENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*===?\s*([0-9][^\s;#,]*)").unwrap());
static TOML_PACKAGE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?m)^\[\[package\]\]\s*\nname\s*=\s*"([^"]+)"\s*\nversion\s*=\s*"([^"]+)""#).unwrap());
static GO_REQUIRE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^(?:require\s+|\t)([a-zA-Z0-9.\-_~/]+\.[a-z]{2,}[a-zA-Z0-9.\-_~/]*)\s+(v[0-9][^\s]*)(\s*//\s*indirect)?").unwrap()
});
static GRADLE_DEP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"["']([\w.\-]+):([\w.\-]+):(\d[\w.\-]*)["']"#).unwrap());
static GEM_SPEC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^    ([A-Za-z0-9_.\-]+) \(([0-9][^)\s]*)\)").unwrap());
static POM_DEPENDENCY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<dependency>(.*?)</dependency>").unwrap());
static POM_PROPERTY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<properties>(.*?)</properties>").unwrap());
static XML_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<([\w.\-]+)>\s*([^<]*?)\s*</[\w.\-]+>").unwrap());

fn clean_version(raw: &str) -> String {
    let trimmed = raw.trim().trim_start_matches(['^', '~', '=', '>', '<', 'v', ' ']).trim_start_matches("npm:");
    if trimmed.starts_with(|c: char| c.is_ascii_digit()) {
        trimmed.split([' ', ',', '|']).next().unwrap_or("").to_owned()
    } else {
        String::new()
    }
}

/// npm lockfiles, including Bun's binary one (whose versions can't be read, but whose presence means a
/// manifest's ranges are not what is installed).
const NPM_LOCKFILES: &[&str] = &["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"];

/// Whether an npm lockfile sits in `dir` or a directory above it. Listed files count too, so a lockfile
/// too large to load still marks the manifest's ranges as not what is installed.
fn npm_lock_above(store: &Store, dir: &str) -> bool {
    let mut current = Some(dir);
    while let Some(at) = current {
        let listed = store.list_dir(at);
        if listed.iter().any(|(name, is_dir)| !is_dir && NPM_LOCKFILES.contains(&name.as_str())) {
            return true;
        }
        current = if at.is_empty() { None } else { Some(at.rsplit_once('/').map_or("", |(parent, _)| parent)) };
    }
    false
}

/// What the `package.json` files a lockfile covers declare: every package named in any of them, and those
/// named only as dev dependencies. A lockfile covers its own directory and every workspace below it.
fn declared_npm(store: &Store, dir: &str) -> (HashSet<String>, HashSet<String>) {
    let prefix = if dir.is_empty() { String::new() } else { format!("{dir}/") };
    let mut direct = HashSet::new();
    let mut shipped = HashSet::new();
    let mut dev = HashSet::new();
    for file in store.files.iter().filter(|file| file.path.starts_with(&prefix) && file.path.ends_with("package.json")) {
        if file.path.rsplit('/').next() != Some("package.json") || file.path.split('/').any(|segment| segment == "node_modules") {
            continue;
        }
        let Ok(json) = serde_json::from_str::<Value>(&file.text) else { continue };
        for (section, is_dev) in
            [("dependencies", false), ("devDependencies", true), ("optionalDependencies", false), ("peerDependencies", false)]
        {
            for name in json.get(section).and_then(Value::as_object).into_iter().flat_map(|deps| deps.keys()) {
                direct.insert(name.clone());
                if is_dev {
                    dev.insert(name.clone())
                } else {
                    shipped.insert(name.clone())
                };
            }
        }
    }
    let dev_only = dev.difference(&shipped).cloned().collect();
    (direct, dev_only)
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

/// Classic and Berry `yarn.lock`: an unindented header naming `pkg@range`
/// entries, followed by an indented `version` line.
/// Also returns every `name@range` the entries were resolved for, mapped to the version installed.
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
    /// Workspace package name → its directory, relative to the lockfile.
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
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        let trimmed = line.trim();
        if indent == 0 {
            inside = trimmed == "importers:";
            continue;
        }
        if !inside {
            continue;
        }
        let unquote = |text: &str| text.trim().trim_matches(|c| c == '\'' || c == '"').to_owned();
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

/// `name: value` → (`name`, Some(`value`)); handles quoted names holding `@` and `/`.
fn split_yaml_key(line: &str) -> (&str, Option<&str>) {
    let quoted = line.starts_with('\'') || line.starts_with('"');
    let search_from = if quoted { line[1..].find(['\'', '"']).map_or(0, |i| i + 2) } else { 0 };
    match line[search_from..].find(':') {
        Some(i) => (&line[..search_from + i], Some(line[search_from + i + 1..].trim())),
        None => (line, None),
    }
}

/// `15.5.3(react@19.0.0)` (pnpm 6+) and `15.5.3_react@19.0.0` (pnpm 5) → `15.5.3`.
fn pnpm_version(raw: &str) -> String {
    raw.split(['(', '_']).next().unwrap_or("").to_owned()
}

/// Every dependency declared by a `package.json` at or below `dir`: `(its directory, name, range)`.
fn npm_manifests(store: &Store, dir: &str) -> Vec<(String, String, String)> {
    let prefix = if dir.is_empty() { String::new() } else { format!("{dir}/") };
    let mut out = Vec::new();
    for file in store.files.iter().filter(|file| file.path.starts_with(&prefix) && file.path.ends_with("package.json")) {
        if file.path.rsplit('/').next() != Some("package.json") || file.path.split('/').any(|segment| segment == "node_modules") {
            continue;
        }
        let Ok(json) = serde_json::from_str::<Value>(&file.text) else { continue };
        let owner = file.path.rsplit_once('/').map_or("", |(owner, _)| owner);
        for section in ["dependencies", "devDependencies", "optionalDependencies"] {
            for (name, range) in json.get(section).and_then(Value::as_object).into_iter().flatten() {
                if let Some(range) = range.as_str() {
                    out.push((owner.to_owned(), name.clone(), range.to_owned()));
                }
            }
        }
    }
    out
}

/// Which version of an npm package each workspace gets, from the lockfiles that say so. A lockfile often
/// holds several versions of one package; only the one a file's own workspace resolves is the one it imports.
#[derive(Default)]
struct NpmResolution {
    /// (workspace directory, package) → version.
    workspace: HashMap<(String, String), String>,
    /// (lockfile directory, package) → the version at the top of that lockfile's tree.
    hoisted: HashMap<(String, String), String>,
    /// Directories holding an npm lockfile that was read.
    lock_dirs: HashSet<String>,
}

impl NpmResolution {
    /// The version `name` resolves to from `file`, the way Node looks it up: the file's workspace, then each
    /// directory above it up to the lockfile, then the lockfile's top level. None when no lockfile says.
    fn resolve(&self, manifests: &HashSet<&str>, file: &str, name: &str) -> Option<&str> {
        let mut dir = parent(file);
        while !manifests.contains(dir) {
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
    fn mark_direct(&self, deps: &mut [Dep]) {
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

/// Removes commas that close a JSON object or array (`[1, 2,]`), outside strings.
fn strip_trailing_commas(text: &str) -> String {
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

fn parse_pom(text: &str) -> Vec<(String, String)> {
    let properties: HashMap<String, String> = POM_PROPERTY
        .captures(text)
        .map(|c| XML_TAG.captures_iter(c.get(1).unwrap().as_str()).map(|t| (t[1].to_owned(), t[2].to_owned())).collect())
        .unwrap_or_default();
    POM_DEPENDENCY
        .captures_iter(text)
        .filter_map(|block| {
            let tags: HashMap<String, String> = XML_TAG.captures_iter(&block[1]).map(|t| (t[1].to_owned(), t[2].to_owned())).collect();
            let mut version = tags.get("version")?.clone();
            if let Some(key) = version.strip_prefix("${").and_then(|v| v.strip_suffix('}')) {
                version = properties.get(key)?.clone();
            }
            Some((format!("{}:{}", tags.get("groupId")?, tags.get("artifactId")?), version))
        })
        .collect()
}

/// Import names that differ from the package name on PyPI.
const PYTHON_ALIASES: &[(&str, &str)] = &[
    ("pyyaml", "yaml"),
    ("pillow", "PIL"),
    ("beautifulsoup4", "bs4"),
    ("python_jose", "jose"),
    ("pyjwt", "jwt"),
    ("scikit_learn", "sklearn"),
    ("opencv_python", "cv2"),
    ("python_dateutil", "dateutil"),
    ("djangorestframework", "rest_framework"),
    ("protobuf", "google"),
    ("pycryptodome", "Crypto"),
    ("pycryptodomex", "Cryptodome"),
    ("attrs", "attr"),
    ("python_multipart", "multipart"),
    ("psycopg2_binary", "psycopg2"),
    ("python_dotenv", "dotenv"),
    ("pymongo", "pymongo"),
    ("lxml", "lxml"),
    ("itsdangerous", "itsdangerous"),
];

fn mark_reachability(store: &Store, deps: &mut [Dep], imports: &[ImportSite], resolution: &NpmResolution) {
    let manifests: HashSet<&str> = store
        .files
        .iter()
        .filter(|file| file.path.rsplit('/').next() == Some("package.json") && !file.path.contains("node_modules/"))
        .map(|file| parent(&file.path))
        .collect();
    let mut npm_versions: HashMap<String, HashSet<String>> = HashMap::new();
    for dep in deps.iter().filter(|dep| dep.ecosystem == "npm") {
        npm_versions.entry(dep.name.clone()).or_default().insert(dep.version.clone());
    }
    let classes: HashMap<&str, Class> =
        imports.iter().filter_map(|site| store.get(site.file).map(|file| (site.file, file.class))).collect();
    // package/module name → import sites
    let mut npm: HashMap<&str, Vec<&ImportSite>> = HashMap::new();
    let mut python: HashMap<String, Vec<&ImportSite>> = HashMap::new();
    let mut paths: Vec<&ImportSite> = Vec::new();

    for site in imports {
        let spec = site.spec;
        if spec.starts_with('.') || spec.starts_with('/') || spec.starts_with("node:") {
            continue;
        }
        if let Some(package) = npm_package(spec) {
            npm.entry(package).or_default().push(site);
        }
        let top = spec.split('.').next().unwrap_or(spec);
        python.entry(top.to_ascii_lowercase().replace('-', "_")).or_default().push(site);
        if spec.contains('/') || spec.contains('.') {
            paths.push(site);
        }
    }

    for dep in deps {
        let sites: Vec<&ImportSite> = match dep.ecosystem {
            "npm" => {
                let versions = npm_versions.get(&dep.name);
                let sites = npm.get(dep.name.as_str()).cloned().unwrap_or_default();
                // A site counts for the version its workspace resolves; one no lockfile explains counts for every version.
                sites
                    .into_iter()
                    .filter(|site| match resolution.resolve(&manifests, site.file, &dep.name) {
                        Some(version) if versions.is_some_and(|known| known.contains(version)) => version == dep.version,
                        _ => true,
                    })
                    .collect()
            }
            "PyPI" => {
                let normalized = dep.name.to_ascii_lowercase().replace(['-', '.'], "_");
                let module = PYTHON_ALIASES
                    .iter()
                    .find(|(name, _)| *name == normalized)
                    .map_or(normalized.clone(), |(_, module)| module.to_ascii_lowercase());
                python.get(&module).cloned().unwrap_or_default()
            }
            "Go" => {
                paths.iter().copied().filter(|site| site.spec == dep.name || site.spec.starts_with(&format!("{}/", dep.name))).collect()
            }
            "Maven" => {
                let group = dep.name.split(':').next().unwrap_or("");
                paths.iter().copied().filter(|site| site.spec.starts_with(group)).collect()
            }
            _ => continue,
        };
        dep.reachability = if sites.is_empty() { Reachability::NotImported } else { Reachability::Imported };
        let mut sites = sites;
        // Shipped code first: a package a test imports a hundred times is still in the product if one handler imports it.
        sites.sort_by_key(|site| !matches!(classes.get(site.file), Some(Class::Source)));
        dep.imported_at = sites.iter().take(10).map(|site| format!("{}:{}", site.file, site.line)).collect();
    }
}

/// `lodash/fp` → `lodash`, `@scope/pkg/sub` → `@scope/pkg`.
fn npm_package(spec: &str) -> Option<&str> {
    let mut parts = spec.splitn(3, '/');
    let first = parts.next()?;
    if first.starts_with('@') {
        let second = parts.next()?;
        Some(&spec[..first.len() + 1 + second.len()])
    } else {
        Some(first)
    }
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
    }

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
                ("zod".into(), "3.24.2".into()),
            ]
        );
    }

    #[test]
    fn trailing_commas_inside_strings_are_kept() {
        assert_eq!(strip_trailing_commas(r#"{"a": "x,}", "b": [1, 2,],}"#), r#"{"a": "x,}", "b": [1, 2]}"#);
    }

    #[test]
    fn npm_packages() {
        assert_eq!(npm_package("lodash/fp"), Some("lodash"));
        assert_eq!(npm_package("@scope/pkg/sub"), Some("@scope/pkg"));
    }

    #[test]
    fn pom_properties() {
        let pom = "<properties><jackson.version>2.9.0</jackson.version></properties><dependency><groupId>com.fasterxml</groupId><artifactId>jackson</artifactId><version>${jackson.version}</version></dependency>";
        assert_eq!(parse_pom(pom), vec![("com.fasterxml:jackson".into(), "2.9.0".into())]);
    }
}
