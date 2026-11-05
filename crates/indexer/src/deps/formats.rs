//! Every manifest and lockfile format, by file name, and a parser for each. Lockfiles are preferred: a
//! manifest is read only where nothing pins what it declares, and its ranges are marked as such.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;
use toml::Table;

use super::{Context, Entry, join, npm, parent, sibling};
use crate::files::File;

pub(super) type Parser = fn(&mut Context, &File) -> Vec<Entry>;

/// The parser for a file, by its name (and, for workflows, where it sits).
pub(super) fn parser_for(path: &str) -> Option<Parser> {
    let name = path.rsplit('/').next().unwrap_or(path);
    let extension = name.rsplit_once('.').map_or("", |(_, extension)| extension);
    Some(match name {
        "package.json" => npm::manifest,
        "package-lock.json" | "npm-shrinkwrap.json" => npm::package_lock,
        "yarn.lock" => npm::yarn_lock,
        "pnpm-lock.yaml" => npm::pnpm_lock,
        "bun.lock" => npm::bun_lock,
        "Pipfile.lock" => pipfile_lock,
        "poetry.lock" | "uv.lock" | "pdm.lock" => python_lock,
        "pyproject.toml" => pyproject,
        "go.mod" => go_mod,
        "pom.xml" => pom,
        "build.gradle" | "build.gradle.kts" => gradle_build,
        "gradle.lockfile" => gradle_lockfile,
        "libs.versions.toml" => version_catalog,
        "Cargo.lock" => cargo_lock,
        "composer.lock" => composer_lock,
        "Gemfile.lock" => gemfile_lock,
        "packages.lock.json" => nuget_lock,
        "packages.config" => nuget_packages_config,
        "Directory.Packages.props" => nuget_central,
        "pubspec.lock" => pubspec_lock,
        "mix.lock" => mix_lock,
        "rebar.lock" => rebar_lock,
        "Manifest.toml" => julia_manifest,
        "Package.resolved" => swift_resolved,
        "cabal.project.freeze" => cabal_freeze,
        "stack.yaml.lock" => stack_lock,
        "renv.lock" => renv_lock,
        "opam.locked" => opam_locked,
        ".gitmodules" => submodules,
        _ if name.ends_with(".opam.locked") => opam_locked,
        _ if name.starts_with("requirements") && extension == "txt" => requirements,
        _ if matches!(extension, "csproj" | "fsproj" | "vbproj") => nuget_project,
        _ if path.starts_with(".github/workflows/") && matches!(extension, "yml" | "yaml") => workflow,
        _ => return None,
    })
}

fn regex(pattern: &str) -> Regex {
    Regex::new(pattern).unwrap()
}

fn json(file: &File) -> Option<Value> {
    serde_json::from_str(&file.text).ok()
}

fn table(file: &File) -> Option<Table> {
    file.text.parse().ok()
}

fn xml(file: &File) -> Option<roxmltree::Document<'_>> {
    roxmltree::Document::parse(&file.text).ok()
}

/// An XML element's child text, by tag name.
fn child<'a>(node: roxmltree::Node<'a, '_>, tag: &str) -> Option<&'a str> {
    node.children().find(|n| n.tag_name().name() == tag).and_then(|n| n.text()).map(str::trim)
}

fn str_of(value: Option<&toml::Value>) -> &str {
    value.and_then(toml::Value::as_str).unwrap_or("")
}

/// 1-based line of a byte offset.
fn line_at(text: &str, offset: usize) -> usize {
    memchr::memchr_iter(b'\n', &text.as_bytes()[..offset]).count() + 1
}

// ---- Python ------------------------------------------------------------------

/// A PEP 508 requirement's name and version: `flask[async]==3.0.0 ; python_version>"3.8"`. Pins are exact;
/// a lower bound is a range's floor; anything else has no version to read.
fn requirement(spec: &str) -> Option<(String, String, bool)> {
    static PEP508: LazyLock<Regex> =
        LazyLock::new(|| regex(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*\(?\s*(===?|~=|>=|>)\s*([0-9][^,;\s)]*)"));
    let captures = PEP508.captures(spec)?;
    Some((captures[1].to_owned(), captures[3].to_owned(), !captures[2].starts_with("==")))
}

fn requirements(_: &mut Context, file: &File) -> Vec<Entry> {
    let name = file.path.rsplit('/').next().unwrap_or("");
    let dev = name.contains("dev") || name.contains("test");
    file.text
        .lines()
        .filter_map(requirement)
        .map(|(name, version, range)| {
            let entry = Entry::new("PyPI", name, version).dev(dev);
            if range { entry.range() } else { entry }
        })
        .collect()
}

fn pipfile_lock(_: &mut Context, file: &File) -> Vec<Entry> {
    let Some(json) = json(file) else { return Vec::new() };
    [("default", false), ("develop", true)]
        .into_iter()
        .flat_map(|(section, dev)| {
            json.get(section)
                .and_then(Value::as_object)
                .into_iter()
                .flatten()
                .map(move |(name, info)| Entry::new("PyPI", name, info.get("version").and_then(Value::as_str).unwrap_or("")).dev(dev))
        })
        .collect()
}

/// poetry.lock, uv.lock and pdm.lock: a `[[package]]` table per installed package.
fn python_lock(_: &mut Context, file: &File) -> Vec<Entry> {
    let Some(lock) = table(file) else { return Vec::new() };
    packages(&lock)
        .filter(|package| package.get("source").and_then(|s| s.get("editable").or_else(|| s.get("virtual"))).is_none())
        .map(|package| {
            Entry::new("PyPI", str_of(package.get("name")), str_of(package.get("version")))
                .direct(false)
                .dev(str_of(package.get("category")) == "dev")
        })
        .collect()
}

fn packages(lock: &Table) -> impl Iterator<Item = &Table> {
    lock.get("package").and_then(toml::Value::as_array).into_iter().flatten().filter_map(toml::Value::as_table)
}

/// pyproject.toml, read only when no lockfile beside it pins what it declares (PEP 621, PEP 735 and Poetry).
fn pyproject(cx: &mut Context, file: &File) -> Vec<Entry> {
    if sibling(cx.store, parent(&file.path), &["poetry.lock", "uv.lock", "pdm.lock", "Pipfile.lock"]) {
        return Vec::new();
    }
    let Some(project) = table(file) else { return Vec::new() };
    let mut specs: Vec<(String, bool)> = Vec::new();
    let strings = |value: Option<&toml::Value>| -> Vec<String> {
        value.and_then(toml::Value::as_array).into_iter().flatten().filter_map(|v| v.as_str().map(str::to_owned)).collect()
    };
    let pep621 = project.get("project");
    specs.extend(strings(pep621.and_then(|p| p.get("dependencies"))).into_iter().map(|s| (s, false)));
    for group in pep621.and_then(|p| p.get("optional-dependencies")).and_then(toml::Value::as_table).into_iter().flat_map(|t| t.values()) {
        specs.extend(strings(Some(group)).into_iter().map(|s| (s, false)));
    }
    for group in project.get("dependency-groups").and_then(toml::Value::as_table).into_iter().flat_map(|t| t.values()) {
        specs.extend(strings(Some(group)).into_iter().map(|s| (s, true)));
    }
    let poetry = project.get("tool").and_then(|t| t.get("poetry"));
    let mut poetry_tables: Vec<(&toml::Value, bool)> = Vec::new();
    poetry_tables.extend(poetry.and_then(|p| p.get("dependencies")).map(|t| (t, false)));
    poetry_tables.extend(poetry.and_then(|p| p.get("dev-dependencies")).map(|t| (t, true)));
    for group in poetry.and_then(|p| p.get("group")).and_then(toml::Value::as_table).into_iter().flat_map(|t| t.values()) {
        poetry_tables.extend(group.get("dependencies").map(|t| (t, true)));
    }
    let mut out: Vec<Entry> = specs
        .iter()
        .filter_map(|(spec, dev)| {
            let (name, version, range) = requirement(spec)?;
            let entry = Entry::new("PyPI", name, version).dev(*dev);
            Some(if range { entry.range() } else { entry })
        })
        .collect();
    // Poetry constraints: `"3.0.0"` and `"==3.0.0"` pin; `"^3.0"`, `"~3.0"` and `">=3.0"` are ranges.
    for (deps, dev) in poetry_tables {
        for (name, constraint) in deps.as_table().into_iter().flatten().filter(|(name, _)| *name != "python") {
            let version = constraint.as_str().or_else(|| constraint.get("version").and_then(toml::Value::as_str)).unwrap_or("");
            let entry = Entry::new("PyPI", name, version).dev(dev);
            out.push(if version.starts_with(|c: char| c.is_ascii_digit()) || version.starts_with("==") { entry } else { entry.range() });
        }
    }
    out
}

// ---- Go ----------------------------------------------------------------------

fn go_mod(_: &mut Context, file: &File) -> Vec<Entry> {
    static REQUIRE: LazyLock<Regex> = LazyLock::new(|| {
        regex(r"(?m)^(?:require\s+|\t)([a-zA-Z0-9.\-_~/]+\.[a-z]{2,}[a-zA-Z0-9.\-_~/]*)\s+(v[0-9][^\s]*)(\s*//\s*indirect)?")
    });
    REQUIRE.captures_iter(&file.text).map(|c| Entry::new("Go", &c[1], &c[2]).direct(c.get(3).is_none())).collect()
}

// ---- Java and other JVM languages ----------------------------------------------

/// One `pom.xml`: its coordinates, parent, properties, managed versions and dependencies.
pub(super) struct Pom {
    group: String,
    version: String,
    parent: Option<(String, String, String)>,
    properties: HashMap<String, String>,
    managed: HashMap<String, String>,
    /// BOMs `dependencyManagement` imports, as `group:artifact:version`.
    imports: Vec<String>,
    dependencies: Vec<(String, Option<String>, bool)>,
}

impl Pom {
    fn parse(text: &str) -> Option<(String, Pom)> {
        let doc = roxmltree::Document::parse(text).ok()?;
        let project = doc.root_element();
        let parent = project.children().find(|n| n.tag_name().name() == "parent").map(|p| {
            (
                child(p, "groupId").unwrap_or("").to_owned(),
                child(p, "artifactId").unwrap_or("").to_owned(),
                child(p, "version").unwrap_or("").to_owned(),
            )
        });
        let group = child(project, "groupId").map(str::to_owned).or_else(|| parent.as_ref().map(|p| p.0.clone()))?;
        let version = child(project, "version").map(str::to_owned).or_else(|| parent.as_ref().map(|p| p.2.clone())).unwrap_or_default();
        let artifact = child(project, "artifactId")?.to_owned();
        let properties = project
            .children()
            .find(|n| n.tag_name().name() == "properties")
            .map(|p| {
                p.children()
                    .filter(|n| n.is_element())
                    .map(|n| (n.tag_name().name().to_owned(), n.text().unwrap_or("").trim().to_owned()))
                    .collect()
            })
            .unwrap_or_default();
        let coordinates = |dep: roxmltree::Node| {
            Some((
                format!("{}:{}", child(dep, "groupId")?, child(dep, "artifactId")?),
                child(dep, "version").map(str::to_owned),
                child(dep, "scope").unwrap_or("compile").to_owned(),
            ))
        };
        let dependencies_in = |section: Option<roxmltree::Node>| -> Vec<(String, Option<String>, String)> {
            section
                .and_then(|s| s.children().find(|n| n.tag_name().name() == "dependencies"))
                .into_iter()
                .flat_map(|deps| deps.children().filter(|n| n.tag_name().name() == "dependency"))
                .filter_map(coordinates)
                .collect()
        };
        let management = project.children().find(|n| n.tag_name().name() == "dependencyManagement");
        let (imports, managed): (Vec<_>, Vec<_>) = dependencies_in(management)
            .into_iter()
            .filter_map(|(name, version, scope)| Some((name, version?, scope)))
            .partition(|(_, _, scope)| scope == "import");
        let imports = imports.into_iter().map(|(name, version, _)| format!("{name}:{version}")).collect();
        let managed = managed.into_iter().map(|(name, version, _)| (name, version)).collect();
        let dependencies =
            dependencies_in(Some(project)).into_iter().map(|(name, version, scope)| (name, version, scope == "test")).collect();
        Some((format!("{group}:{artifact}"), Pom { group, version, parent, properties, managed, imports, dependencies }))
    }
}

/// `pom.xml`, with versions from properties and `dependencyManagement` resolved through parents in the same
/// repository. A version only a parent or BOM outside it sets is left to the engine, which reads those POMs.
fn pom(cx: &mut Context, file: &File) -> Vec<Entry> {
    let store = cx.store;
    let poms =
        cx.poms.get_or_init(|| store.files.iter().filter(|f| f.path.ends_with("pom.xml")).filter_map(|f| Pom::parse(&f.text)).collect());
    let Some((_, pom)) = Pom::parse(&file.text) else { return Vec::new() };
    // The pom and its ancestors in this repository, nearest first.
    let mut chain = vec![&pom];
    while let Some((group, artifact, _)) = &chain.last().unwrap().parent {
        match poms.get(&format!("{group}:{artifact}")) {
            Some(parent) if chain.len() < 20 => chain.push(parent),
            _ => break,
        }
    }
    let property = |key: &str| -> Option<String> {
        match key {
            "project.version" | "version" | "pom.version" => Some(pom.version.clone()),
            "project.groupId" | "groupId" => Some(pom.group.clone()),
            "project.parent.version" => pom.parent.as_ref().map(|p| p.2.clone()),
            _ => chain.iter().find_map(|p| p.properties.get(key).cloned()),
        }
    };
    let interpolate = |value: &str| -> Option<String> {
        let mut out = value.to_owned();
        for _ in 0..5 {
            let Some(start) = out.find("${") else { return Some(out) };
            let end = out[start..].find('}')? + start;
            let resolved = property(&out[start + 2..end])?;
            out.replace_range(start..=end, &resolved);
        }
        None
    };
    // POMs outside the repository that may set the rest, in Maven's order: imported BOMs, nearest pom first,
    // then the outermost parent.
    let outer_parent = chain.last().and_then(|top| top.parent.as_ref()).filter(|(g, a, _)| !poms.contains_key(&format!("{g}:{a}")));
    let outside: Vec<String> = chain
        .iter()
        .flat_map(|p| p.imports.iter().cloned())
        .chain(outer_parent.map(|(g, a, v)| format!("{g}:{a}:{v}")))
        .filter_map(|gav| interpolate(&gav))
        .collect();
    let properties: BTreeMap<String, String> =
        chain.iter().rev().flat_map(|p| p.properties.iter()).map(|(k, v)| (k.clone(), v.clone())).collect();
    pom.dependencies
        .iter()
        .filter(|(name, _, _)| !poms.contains_key(name))
        .filter_map(|(name, version, test)| match version.clone().or_else(|| chain.iter().find_map(|p| p.managed.get(name).cloned())) {
            Some(version) => Some(Entry::new("Maven", name, interpolate(&version)?).dev(*test)),
            None if !outside.is_empty() => Some(Entry::managed("Maven", name, outside.clone(), properties.clone()).dev(*test)),
            None => None,
        })
        .collect()
}

/// Gradle plugins that import a BOM at their own version.
const PLUGIN_BOMS: &[(&str, &str)] = &[("org.springframework.boot", "org.springframework.boot:spring-boot-dependencies")];

/// A Gradle build file's `group:artifact:version` dependencies. Versionless ones are left to the BOMs the
/// file imports (`platform(…)`, `mavenBom …`, or a plugin that applies one), which the engine reads.
fn gradle_build(_: &mut Context, file: &File) -> Vec<Entry> {
    static DEP: LazyLock<Regex> = LazyLock::new(|| regex(r#"(\w+)\s*\(?\s*["']([\w.\-]+):([\w.\-]+)(?::([^"'@:\s]+))?["']"#));
    static BOM: LazyLock<Regex> =
        LazyLock::new(|| regex(r#"\b(?:platform|enforcedPlatform|mavenBom)\s*\(?\s*["']([\w.\-]+:[\w.\-]+:[^"'\s]+)["']"#));
    static PLUGIN: LazyLock<Regex> = LazyLock::new(|| regex(r#"\bid\s*\(?\s*["']([\w.\-]+)["']\s*\)?\s*version\s*["']([^"']+)["']"#));
    let applied = PLUGIN
        .captures_iter(&file.text)
        .filter_map(|c| PLUGIN_BOMS.iter().find(|(id, _)| *id == &c[1]).map(|(_, bom)| format!("{bom}:{}", &c[2])));
    let boms: Vec<String> = BOM.captures_iter(&file.text).map(|c| c[1].to_owned()).chain(applied).collect();
    DEP.captures_iter(&file.text)
        .filter(|c| !matches!(&c[1], "id" | "platform" | "enforcedPlatform" | "mavenBom" | "classpath"))
        .filter_map(|c| {
            let name = format!("{}:{}", &c[2], &c[3]);
            let dev = c[1].to_ascii_lowercase().contains("test");
            match c.get(4).map(|v| v.as_str()) {
                Some(version) if version.contains(['+', '[', '(']) => Some(Entry::new("Maven", name, version).dev(dev).range()),
                Some(version) => Some(Entry::new("Maven", name, version).dev(dev)),
                None if !boms.is_empty() => Some(Entry::managed("Maven", name, boms.clone(), BTreeMap::new()).dev(dev)),
                None => None,
            }
        })
        .collect()
}

/// `gradle.lockfile`: `group:artifact:version=configuration,…`, exactly what each configuration resolves.
fn gradle_lockfile(_: &mut Context, file: &File) -> Vec<Entry> {
    file.text
        .lines()
        .filter(|line| !line.starts_with('#') && !line.starts_with("empty="))
        .filter_map(|line| {
            let (coordinates, configurations) = line.split_once('=')?;
            let mut parts = coordinates.splitn(3, ':');
            let (group, artifact, version) = (parts.next()?, parts.next()?, parts.next()?);
            let dev = configurations.split(',').all(|c| c.to_ascii_lowercase().contains("test"));
            Some(Entry::new("Maven", format!("{group}:{artifact}"), version).direct(false).dev(dev))
        })
        .collect()
}

/// A Gradle version catalog: libraries by `module`, `group` and `name`, or a `group:name:version` string.
fn version_catalog(_: &mut Context, file: &File) -> Vec<Entry> {
    let Some(catalog) = table(file) else { return Vec::new() };
    let versions = catalog.get("versions").and_then(toml::Value::as_table);
    let version_of = |value: Option<&toml::Value>| -> Option<String> {
        match value? {
            toml::Value::String(version) => Some(version.clone()),
            toml::Value::Table(rich) => rich
                .get("ref")
                .and_then(|r| versions?.get(r.as_str()?))
                .and_then(|v| {
                    v.as_str().map(str::to_owned).or_else(|| v.get("strictly").or_else(|| v.get("require"))?.as_str().map(str::to_owned))
                })
                .or_else(|| ["strictly", "require", "prefer"].iter().find_map(|k| rich.get(*k)?.as_str().map(str::to_owned))),
            _ => None,
        }
    };
    catalog
        .get("libraries")
        .and_then(toml::Value::as_table)
        .into_iter()
        .flatten()
        .filter_map(|(_, library)| {
            if let Some(coordinates) = library.as_str() {
                let mut parts = coordinates.splitn(3, ':');
                let (group, name) = (parts.next()?, parts.next()?);
                return Some(Entry::new("Maven", format!("{group}:{name}"), parts.next()?));
            }
            let module = library
                .get("module")
                .and_then(toml::Value::as_str)
                .map(str::to_owned)
                .or_else(|| Some(format!("{}:{}", library.get("group")?.as_str()?, library.get("name")?.as_str()?)))?;
            Some(Entry::new("Maven", module, version_of(library.get("version"))?))
        })
        .collect()
}

// ---- Rust ----------------------------------------------------------------------

fn cargo_lock(cx: &mut Context, file: &File) -> Vec<Entry> {
    let Some(lock) = table(file) else { return Vec::new() };
    // What the workspace's own manifests declare, and which of that only for tests and benches.
    let (mut declared, mut runtime) = (HashSet::new(), HashSet::new());
    let prefix = format!("{}{}", parent(&file.path), if parent(&file.path).is_empty() { "" } else { "/" });
    for manifest in cx.store.files.iter().filter(|f| f.path.starts_with(&prefix) && f.path.ends_with("Cargo.toml")) {
        let Some(manifest) = table(manifest) else { continue };
        for (section, dev) in [("dependencies", false), ("build-dependencies", false), ("dev-dependencies", true)] {
            for (name, spec) in manifest.get(section).and_then(toml::Value::as_table).into_iter().flatten() {
                let name = spec.get("package").and_then(toml::Value::as_str).unwrap_or(name).to_owned();
                if !dev {
                    runtime.insert(name.clone());
                }
                declared.insert(name);
            }
        }
    }
    packages(&lock)
        .filter(|package| package.contains_key("source"))
        .map(|package| {
            let name = str_of(package.get("name"));
            Entry::new("crates.io", name, str_of(package.get("version")))
                .direct(declared.contains(name))
                .dev(declared.contains(name) && !runtime.contains(name))
        })
        .collect()
}

// ---- PHP -----------------------------------------------------------------------

/// composer.lock. Each package's autoload namespaces are what PHP code imports it by.
fn composer_lock(cx: &mut Context, file: &File) -> Vec<Entry> {
    let Some(json) = json(file) else { return Vec::new() };
    let mut out = Vec::new();
    for (section, dev) in [("packages", false), ("packages-dev", true)] {
        for package in json.get(section).and_then(Value::as_array).into_iter().flatten() {
            let name = package.get("name").and_then(Value::as_str).unwrap_or("");
            for scheme in ["psr-4", "psr-0"] {
                for namespace in
                    package.get("autoload").and_then(|a| a.get(scheme)).and_then(Value::as_object).into_iter().flat_map(|m| m.keys())
                {
                    cx.namespaces.push((namespace.trim_end_matches('\\').to_ascii_lowercase(), name.to_owned()));
                }
            }
            out.push(Entry::new("Packagist", name, package.get("version").and_then(Value::as_str).unwrap_or("")).direct(false).dev(dev));
        }
    }
    out
}

// ---- Ruby ----------------------------------------------------------------------

/// Gemfile.lock for versions, the Gemfile beside it for what the project declares and in which groups. When
/// the app calls `Bundler.require` (every Rails app), Bundler loads each declared gem itself: its Gemfile
/// line is where the code uses it.
fn gemfile_lock(cx: &mut Context, file: &File) -> Vec<Entry> {
    static SPEC: LazyLock<Regex> = LazyLock::new(|| regex(r"(?m)^    ([A-Za-z0-9_.\-]+) \(([0-9][^)\s]*)\)"));
    let gemfile_path = join(parent(&file.path), "Gemfile");
    let gems = cx.store.get(&gemfile_path).map(|gemfile| declared_gems(&gemfile.text)).unwrap_or_default();
    let bundled = cx.store.files.iter().any(|f| f.path.ends_with(".rb") && f.text.contains("Bundler.require"));
    for (name, (line, dev)) in &gems {
        if bundled && !dev {
            cx.sites.push(("RubyGems", name.clone(), format!("{gemfile_path}:{line}")));
        }
    }
    SPEC.captures_iter(&file.text)
        .map(|c| {
            let declared = gems.get(&c[1]);
            Entry::new("RubyGems", &c[1], &c[2]).direct(declared.is_some()).dev(declared.is_some_and(|(_, dev)| *dev))
        })
        .collect()
}

/// Gems a Gemfile declares: name ⇢ (line, only in development or test groups).
fn declared_gems(text: &str) -> HashMap<String, (usize, bool)> {
    static GEM: LazyLock<Regex> = LazyLock::new(|| regex(r#"^\s*gem\s+['"]([^'"]+)['"]"#));
    static GROUP: LazyLock<Regex> = LazyLock::new(|| regex(r"^\s*group\s+(.+?)\s+do\b"));
    let mut blocks: Vec<bool> = Vec::new();
    let mut gems = HashMap::new();
    for (i, line) in text.lines().enumerate() {
        let trimmed = line.trim();
        if let Some(groups) = GROUP.captures(line) {
            blocks.push(groups[1].split(',').all(|g| matches!(g.trim().trim_start_matches(':'), "development" | "test")));
        } else if trimmed.ends_with(" do")
            || trimmed.contains(" do |")
            || ["if ", "unless ", "case "].iter().any(|k| trimmed.starts_with(k))
        {
            blocks.push(false);
        } else if trimmed == "end" {
            blocks.pop();
        } else if let Some(gem) = GEM.captures(line) {
            let dev = blocks.iter().any(|dev| *dev) || line.contains("group: :development") || line.contains("group: :test");
            gems.insert(gem[1].to_owned(), (i + 1, dev));
        }
    }
    gems
}

// ---- .NET --------------------------------------------------------------------------

fn nuget_lock(_: &mut Context, file: &File) -> Vec<Entry> {
    let Some(json) = json(file) else { return Vec::new() };
    json.get("dependencies")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|frameworks| frameworks.values())
        .filter_map(Value::as_object)
        .flatten()
        .filter_map(|(name, info)| {
            let kind = info.get("type").and_then(Value::as_str).unwrap_or("");
            (kind != "Project")
                .then(|| Entry::new("NuGet", name, info.get("resolved").and_then(Value::as_str).unwrap_or("")).direct(kind == "Direct"))
        })
        .collect()
}

/// A project file's `PackageReference`s, unless a lockfile beside it pins them. Versions set centrally come
/// from Directory.Packages.props.
fn nuget_project(cx: &mut Context, file: &File) -> Vec<Entry> {
    if sibling(cx.store, parent(&file.path), &["packages.lock.json"]) {
        return Vec::new();
    }
    let Some(doc) = xml(file) else { return Vec::new() };
    doc.descendants()
        .filter(|n| n.tag_name().name() == "PackageReference")
        .filter_map(|n| {
            let version = n.attribute("Version").or_else(|| child(n, "Version"))?;
            let entry = Entry::new("NuGet", n.attribute("Include")?, version);
            Some(if version.contains(['*', '[', '(']) { entry.range() } else { entry })
        })
        .collect()
}

fn nuget_central(_: &mut Context, file: &File) -> Vec<Entry> {
    let Some(doc) = xml(file) else { return Vec::new() };
    doc.descendants()
        .filter(|n| n.tag_name().name() == "PackageVersion")
        .filter_map(|n| Some(Entry::new("NuGet", n.attribute("Include")?, n.attribute("Version")?)))
        .collect()
}

fn nuget_packages_config(_: &mut Context, file: &File) -> Vec<Entry> {
    let Some(doc) = xml(file) else { return Vec::new() };
    doc.descendants()
        .filter(|n| n.tag_name().name() == "package")
        .filter_map(|n| {
            Some(Entry::new("NuGet", n.attribute("id")?, n.attribute("version")?).dev(n.attribute("developmentDependency") == Some("true")))
        })
        .collect()
}

// ---- Dart and Flutter ----------------------------------------------------------------

fn pubspec_lock(_: &mut Context, file: &File) -> Vec<Entry> {
    let mut out = Vec::new();
    let (mut inside, mut name, mut kind, mut hosted) = (false, String::new(), String::new(), false);
    for line in file.text.lines().chain(std::iter::once("end:")) {
        let indent = line.len() - line.trim_start().len();
        let (key, value) = line.trim().split_once(':').map_or((line.trim(), ""), |(k, v)| (k, v.trim().trim_matches('"')));
        match indent {
            0 => inside = key == "packages",
            2 if inside => (name, kind, hosted) = (key.trim_matches('"').to_owned(), String::new(), false),
            4 if inside && key == "dependency" => kind = value.to_owned(),
            4 if inside && key == "source" => hosted = value == "hosted",
            4 if inside && key == "version" && hosted => {
                out.push(Entry::new("Pub", &name, value).direct(kind.starts_with("direct")).dev(kind == "direct dev"))
            }
            _ => {}
        }
    }
    out
}

// ---- Elixir and Erlang -----------------------------------------------------------------

fn mix_lock(cx: &mut Context, file: &File) -> Vec<Entry> {
    static HEX: LazyLock<Regex> = LazyLock::new(|| regex(r#""[\w-]+":\s*\{:hex,\s*:([\w-]+),\s*"([^"]+)""#));
    static DEP: LazyLock<Regex> = LazyLock::new(|| regex(r"\{\s*:(\w+)\s*,([^}]*)\}"));
    let mut declared = HashMap::new();
    if let Some(mix) = cx.store.get(&join(parent(&file.path), "mix.exs")) {
        for c in DEP.captures_iter(&mix.text) {
            let only = c[2].split("only:").nth(1).unwrap_or("");
            declared.insert(c[1].to_owned(), !only.is_empty() && !only.contains(":prod"));
        }
    }
    HEX.captures_iter(&file.text)
        .map(|c| Entry::new("Hex", &c[1], &c[2]).direct(declared.contains_key(&c[1])).dev(declared.get(&c[1]).copied().unwrap_or(false)))
        .collect()
}

fn rebar_lock(_: &mut Context, file: &File) -> Vec<Entry> {
    static PKG: LazyLock<Regex> = LazyLock::new(|| regex(r#"\{<<"[^"]+">>,\s*\{pkg,\s*<<"([^"]+)">>,\s*<<"([^"]+)">>\}[^}]*?,\s*(\d+)\}"#));
    PKG.captures_iter(&file.text).map(|c| Entry::new("Hex", &c[1], &c[2]).direct(&c[3] == "0")).collect()
}

// ---- Julia, Swift, Haskell, R and OCaml --------------------------------------------------

/// Julia's Manifest.toml: `[[deps.Name]]` (format 2) or `[[Name]]` (format 1). The Project.toml beside it
/// names the direct ones.
fn julia_manifest(cx: &mut Context, file: &File) -> Vec<Entry> {
    let Some(manifest) = table(file) else { return Vec::new() };
    let direct: HashSet<String> = cx
        .store
        .get(&join(parent(&file.path), "Project.toml"))
        .and_then(table)
        .and_then(|p| p.get("deps")?.as_table().map(|d| d.keys().cloned().collect()))
        .unwrap_or_default();
    let deps = manifest.get("deps").and_then(toml::Value::as_table).unwrap_or(&manifest);
    deps.iter()
        .flat_map(|(name, versions)| versions.as_array().into_iter().flatten().map(move |v| (name, v)))
        .filter_map(|(name, info)| Some(Entry::new("Julia", name, info.get("version")?.as_str()?).direct(direct.contains(name))))
        .collect()
}

/// SwiftPM's Package.resolved (formats 1 to 3). OSV names a Swift package by its repository, `github.com/apple/swift-nio`.
fn swift_resolved(_: &mut Context, file: &File) -> Vec<Entry> {
    let Some(json) = json(file) else { return Vec::new() };
    let pins = json.get("pins").or_else(|| json.get("object")?.get("pins")).and_then(Value::as_array);
    pins.into_iter()
        .flatten()
        .filter_map(|pin| {
            let url = pin.get("location").or_else(|| pin.get("repositoryURL"))?.as_str()?;
            let name = url
                .split("://")
                .last()?
                .trim_start_matches("git@")
                .replacen(':', "/", 1)
                .trim_end_matches('/')
                .trim_end_matches(".git")
                .to_owned();
            Some(Entry::new("SwiftURL", name, pin.get("state")?.get("version")?.as_str()?))
        })
        .collect()
}

fn cabal_freeze(_: &mut Context, file: &File) -> Vec<Entry> {
    static PIN: LazyLock<Regex> = LazyLock::new(|| regex(r"(?:any\.)?([A-Za-z][\w-]*)\s*==\s*([\d.]+)"));
    PIN.captures_iter(&file.text).map(|c| Entry::new("Hackage", &c[1], &c[2]).direct(false)).collect()
}

fn stack_lock(_: &mut Context, file: &File) -> Vec<Entry> {
    static HACKAGE: LazyLock<Regex> = LazyLock::new(|| regex(r"hackage:\s*([A-Za-z][\w-]*?)-(\d[\d.]*)(?:@|\s|$)"));
    HACKAGE.captures_iter(&file.text).map(|c| Entry::new("Hackage", &c[1], &c[2])).collect()
}

fn renv_lock(_: &mut Context, file: &File) -> Vec<Entry> {
    let Some(json) = json(file) else { return Vec::new() };
    json.get("Packages")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter(|(_, info)| matches!(info.get("Source").and_then(Value::as_str), Some("Repository" | "RSPM")))
        .filter_map(|(name, info)| Some(Entry::new("CRAN", name, info.get("Version")?.as_str()?).direct(false)))
        .collect()
}

fn opam_locked(_: &mut Context, file: &File) -> Vec<Entry> {
    static PIN: LazyLock<Regex> = LazyLock::new(|| regex(r#""([\w.-]+)"\s*\{\s*=\s*"([^"]+)""#));
    PIN.captures_iter(&file.text).map(|c| Entry::new("opam", &c[1], &c[2]).direct(false)).collect()
}

// ---- GitHub Actions -------------------------------------------------------------------------

/// Actions a workflow runs, at a release tag (`actions/checkout@v4.1.1`). A floating major tag (`@v4`) or a
/// commit doesn't name a release, so it can't be matched here. The `uses:` line is where it is used.
fn workflow(cx: &mut Context, file: &File) -> Vec<Entry> {
    static USES: LazyLock<Regex> =
        LazyLock::new(|| regex(r#"(?m)^[ \t-]*uses:[ \t]*['"]?([\w.-]+/[\w.-]+)(?:/[^@\s'"]*)?@v?(\d+\.\d+(?:\.\d+)?)(?:['"\s]|$)"#));
    USES.captures_iter(&file.text)
        .map(|c| {
            let line = line_at(&file.text, c.get(0).unwrap().start());
            cx.sites.push(("GitHub Actions", c[1].to_owned(), format!("{}:{line}", file.path)));
            Entry::new("GitHub Actions", &c[1], &c[2])
        })
        .collect()
}

/// Git submodules: each pinned to the commit the repository's tree records, which OSV matches against the
/// commit ranges of advisories for that repository (how C and C++ libraries are usually vendored). The
/// commits come from git itself; without a git checkout there are none.
fn submodules(cx: &mut Context, file: &File) -> Vec<Entry> {
    let (mut paths, mut urls) = (BTreeMap::new(), BTreeMap::new());
    let mut section = "";
    for line in file.text.lines().map(str::trim) {
        if let Some(name) = line.strip_prefix("[submodule \"").and_then(|rest| rest.strip_suffix("\"]")) {
            section = name;
        } else if let Some((key, value)) = line.split_once('=') {
            let target = match key.trim() {
                "path" => &mut paths,
                "url" => &mut urls,
                _ => continue,
            };
            target.insert(section, value.trim());
        }
    }
    let dir = parent(&file.path);
    let pinned: Vec<(String, &str)> = paths.iter().filter_map(|(name, path)| Some((join(dir, path), urls.get(name)?.to_owned()))).collect();
    if pinned.is_empty() {
        return Vec::new();
    }
    // The checkout may belong to another user than the indexer.
    let Ok(out) = std::process::Command::new("git")
        .args(["-c", "safe.directory=*", "-C"])
        .arg(&cx.store.root)
        .args(["ls-tree", "HEAD", "--"])
        .args(pinned.iter().map(|(path, _)| path))
        .output()
    else {
        return Vec::new();
    };
    // `160000 commit <sha>\t<path>`, one per gitlink.
    let commits: HashMap<&str, &str> = std::str::from_utf8(&out.stdout)
        .unwrap_or("")
        .lines()
        .filter_map(|line| {
            let (meta, path) = line.split_once('\t')?;
            let mut meta = meta.split(' ');
            (meta.next()? == "160000").then_some(())?;
            Some((path, meta.nth(1)?))
        })
        .collect();
    pinned.iter().filter_map(|(path, url)| Some(Entry::new("GIT", repository_url(url)?, *commits.get(path.as_str())?))).collect()
}

/// A submodule's URL as OSV names repositories: `https://host/owner/repo`. Relative URLs name nothing.
fn repository_url(url: &str) -> Option<String> {
    let url = url.trim_end_matches('/').trim_end_matches(".git");
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .or_else(|| url.strip_prefix("ssh://").map(|rest| rest.trim_start_matches("git@")))
        .or_else(|| url.strip_prefix("git://"))
        .map(str::to_owned)
        .or_else(|| url.strip_prefix("git@").map(|rest| rest.replacen(':', "/", 1)))?;
    Some(format!("https://{}", rest.rsplit_once('@').map_or(rest.as_str(), |(_, host)| host)))
}
