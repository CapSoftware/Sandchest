//! Dependencies from manifests and lockfiles, and whether the code imports them.
//! Vulnerability lookup happens in the engine; this module only says what is
//! installed and where it is used.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;
use serde_json::Value;

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
    pub reachability: Reachability,
    /// Up to three `file:line` sites that import it.
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
        let sibling = |name: &str| store.get(&if dir.is_empty() { name.to_owned() } else { format!("{dir}/{name}") });
        let text = file.text.as_str();
        match path.rsplit('/').next().unwrap_or(path) {
            "package.json" => {
                let Ok(json) = serde_json::from_str::<Value>(text) else { continue };
                let has_lock =
                    ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json"].iter().any(|n| sibling(n).is_some());
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
                let direct = direct_npm(sibling("package.json").map(|f| f.text.as_str()));
                if let Some(packages) = json.get("packages").and_then(Value::as_object) {
                    for (key, info) in packages {
                        let Some(name) = key.rsplit("node_modules/").next().filter(|_| key.contains("node_modules/")) else { continue };
                        let version = info.get("version").and_then(Value::as_str).unwrap_or("");
                        let dev = info.get("dev").and_then(Value::as_bool).unwrap_or(false);
                        add("npm", name, version, path, direct.contains(name), dev);
                    }
                } else if let Some(dependencies) = json.get("dependencies") {
                    walk_lock_v1(dependencies, &mut |name, version, dev| add("npm", name, version, path, direct.contains(name), dev));
                }
            }
            "yarn.lock" => {
                let direct = direct_npm(sibling("package.json").map(|f| f.text.as_str()));
                for (name, version) in parse_yarn_lock(text) {
                    add("npm", &name, &version, path, direct.contains(name.as_str()), false);
                }
            }
            "pnpm-lock.yaml" => {
                let direct = direct_npm(sibling("package.json").map(|f| f.text.as_str()));
                for captures in PNPM_PACKAGE.captures_iter(text) {
                    add("npm", &captures[1], &captures[2], path, direct.contains(&captures[1]), false);
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
    mark_reachability(&mut deps, imports);
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

fn direct_npm(package_json: Option<&str>) -> HashSet<String> {
    let Some(json) = package_json.and_then(|text| serde_json::from_str::<Value>(text).ok()) else { return HashSet::new() };
    ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
        .iter()
        .filter_map(|section| json.get(section).and_then(Value::as_object))
        .flat_map(|deps| deps.keys().cloned())
        .collect()
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
fn parse_yarn_lock(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut current: Option<String> = None;
    for line in text.lines() {
        if !line.starts_with(' ') && line.ends_with(':') && !line.starts_with('#') {
            let first = line.trim_end_matches(':').split(", ").next().unwrap_or("").trim_matches('"');
            let at = first.char_indices().skip(1).find(|&(_, c)| c == '@').map(|(i, _)| i);
            current = at.map(|i| first[..i].to_owned());
        } else if let Some(name) = &current {
            let trimmed = line.trim_start();
            if let Some(version) = trimmed.strip_prefix("version ").or_else(|| trimmed.strip_prefix("version: ")) {
                out.push((name.clone(), version.trim_matches('"').to_owned()));
                current = None;
            }
        }
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

fn mark_reachability(deps: &mut [Dep], imports: &[ImportSite]) {
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
            "npm" => npm.get(dep.name.as_str()).cloned().unwrap_or_default(),
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
        dep.imported_at = sites.iter().take(3).map(|site| format!("{}:{}", site.file, site.line)).collect();
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
        assert_eq!(parse_yarn_lock(text), vec![("@babel/core".into(), "7.2.0".into()), ("lodash".into(), "4.17.21".into())]);
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
