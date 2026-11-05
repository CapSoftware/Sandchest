//! Where the code imports each package. One rule per ecosystem says which source files can import its
//! packages and how an import names one; most need nothing more than the package's name. Where an import
//! names something other than the package (a Java package isn't its Maven coordinates), finding no import
//! proves nothing, so the package stays `Unknown` rather than `NotImported`. Ecosystems whose imports can't
//! be told from package names at all (Swift, Haskell, OCaml) are never guessed at.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;

use super::{Context, Dep, ImportSite, Reachability, npm};
use crate::files::{Class, Store};

/// How an import names a package.
#[derive(Clone, Copy, PartialEq)]
enum By {
    /// The package an npm specifier names, counted for the version the importing file's workspace resolves.
    Npm,
    /// A Python module's top level (through the few packages installed under another name).
    Python,
    /// A Go import path within the module.
    GoModule,
    /// A JVM import within the artifact's group, or spelling its artifact id (`com.fasterxml.jackson.databind`
    /// for `jackson-databind`).
    Artifact,
    /// A namespace a Composer package autoloads.
    Namespace,
    /// The package's name, spelling the import path's leading segments.
    Name,
}

/// How one ecosystem's packages are found in code.
struct Rule {
    ecosystem: &'static str,
    /// Extensions of the files that import its packages.
    sources: &'static [&'static str],
    by: By,
    /// Every import of a package names it this way, so finding none means it isn't imported.
    proves_absence: bool,
}

const RULES: &[Rule] = &[
    Rule { ecosystem: "npm", sources: &["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"], by: By::Npm, proves_absence: true },
    Rule { ecosystem: "PyPI", sources: &["py", "pyi"], by: By::Python, proves_absence: true },
    Rule { ecosystem: "Go", sources: &["go"], by: By::GoModule, proves_absence: true },
    Rule { ecosystem: "Maven", sources: &["java", "kt", "kts", "scala", "groovy"], by: By::Artifact, proves_absence: false },
    Rule { ecosystem: "Packagist", sources: &["php"], by: By::Namespace, proves_absence: true },
    Rule { ecosystem: "crates.io", sources: &["rs"], by: By::Name, proves_absence: true },
    Rule { ecosystem: "RubyGems", sources: &["rb"], by: By::Name, proves_absence: true },
    Rule { ecosystem: "NuGet", sources: &["cs", "fs", "vb"], by: By::Name, proves_absence: false },
    Rule { ecosystem: "Pub", sources: &["dart"], by: By::Name, proves_absence: true },
    Rule { ecosystem: "Hex", sources: &["ex", "exs", "erl", "hrl"], by: By::Name, proves_absence: true },
    Rule { ecosystem: "Julia", sources: &["jl"], by: By::Name, proves_absence: true },
    Rule { ecosystem: "CRAN", sources: &["r", "R", "Rmd"], by: By::Name, proves_absence: true },
];

/// Import statements the extractor doesn't parse: languages without a grammar here, and Rust paths used
/// without a `use` (`tokio::spawn`). Each pattern captures the imported name.
const STATEMENTS: &[(&[&str], &str)] = &[
    (&["rs"], r"\b([a-z_][a-z0-9_]*)::"),
    (&["cs"], r"(?m)^[ \t]*(?:global[ \t]+)?using[ \t]+(?:static[ \t]+)?([A-Za-z_][\w.]*)[ \t]*;"),
    (&["fs"], r"(?m)^[ \t]*open[ \t]+([A-Za-z_][\w.]*)"),
    (&["vb"], r"(?m)^[ \t]*Imports[ \t]+([A-Za-z_][\w.]*)"),
    (&["kt", "kts", "scala", "groovy"], r"(?m)^[ \t]*import[ \t]+([\w.]+)"),
    (&["dart"], r#"(?m)^[ \t]*(?:import|export)[ \t]+['"]package:(\w+)/"#),
    (&["ex", "exs"], r"\b(?:use|alias|import|require)[ \t]+([A-Z][\w.]*)|\b([A-Z]\w*(?:\.[A-Z]\w*)*)\.[a-z_]\w*[!?]?\("),
    (&["erl", "hrl"], r#"-include_lib\("(\w+)/"#),
    (&["jl"], r"(?m)^[ \t]*(?:using|import)[ \t]+([A-Za-z_][\w.]*)"),
    (&["r", "R", "Rmd"], r#"\b(?:library|require|requireNamespace)\([ \t]*["']?([\w.]+)|\b([A-Za-z][\w.]*)::"#),
];

/// PyPI packages installed under another module name.
const PYTHON_MODULES: &[(&str, &str)] = &[
    ("pyyaml", "yaml"),
    ("pillow", "pil"),
    ("beautifulsoup4", "bs4"),
    ("python_jose", "jose"),
    ("pyjwt", "jwt"),
    ("scikit_learn", "sklearn"),
    ("opencv_python", "cv2"),
    ("python_dateutil", "dateutil"),
    ("djangorestframework", "rest_framework"),
    ("protobuf", "google"),
    ("pycryptodome", "crypto"),
    ("pycryptodomex", "cryptodome"),
    ("attrs", "attr"),
    ("python_multipart", "multipart"),
    ("psycopg2_binary", "psycopg2"),
    ("python_dotenv", "dotenv"),
];

/// One import: what it names, and where.
struct Site<'a> {
    spec: String,
    file: &'a str,
    line: u32,
    extension: &'a str,
}

/// Sets each dependency's reachability and import sites. Returns the JVM import paths, by package, with the
/// first shipped-code site of each.
pub(super) fn mark(cx: &Context, deps: &mut [Dep], parsed: &[ImportSite]) -> Vec<(String, String)> {
    let sites: Vec<Site> = parsed
        .iter()
        .map(|site| Site { spec: site.spec.to_owned(), file: site.file, line: site.line, extension: extension(site.file) })
        .chain(statements(cx.store))
        .filter(|site| !site.spec.starts_with(['.', '/']) && !site.spec.starts_with("node:"))
        .collect();
    let index = Index::new(&sites);
    let from_manifests: HashMap<(&str, &str), Vec<&str>> = cx.sites.iter().fold(HashMap::new(), |mut map, (ecosystem, name, site)| {
        map.entry((*ecosystem, name.as_str())).or_default().push(site.as_str());
        map
    });
    let npm_versions: HashMap<&str, HashSet<&str>> = deps.iter().filter(|d| d.ecosystem == "npm").fold(HashMap::new(), |mut map, d| {
        map.entry(d.name.as_str()).or_default().insert(d.version.as_str());
        map
    });
    let mut found: Vec<(Reachability, Vec<String>)> = Vec::with_capacity(deps.len());
    for dep in deps.iter() {
        let rule = RULES.iter().find(|rule| rule.ecosystem == dep.ecosystem);
        let mut at: Vec<&Site> = rule.map(|rule| index.matching(dep, rule.by, rule.sources, cx, &npm_versions)).unwrap_or_default();
        // Shipped code first: a package a test imports a hundred times is still in the product if one handler imports it.
        at.sort_by_key(|site| (!matches!(cx.store.get(site.file).map(|f| f.class), Some(Class::Source)), site.file, site.line));
        let mut sites: Vec<String> =
            from_manifests.get(&(dep.ecosystem, dep.name.as_str())).into_iter().flatten().map(|s| (*s).to_owned()).collect();
        sites.extend(at.iter().map(|site| format!("{}:{}", site.file, site.line)));
        sites.dedup();
        let reachability = match (sites.is_empty(), rule) {
            (false, _) => Reachability::Imported,
            (true, Some(rule)) if rule.proves_absence => Reachability::NotImported,
            _ => Reachability::Unknown,
        };
        found.push((reachability, sites));
    }
    for (dep, (reachability, sites)) in deps.iter_mut().zip(found) {
        dep.reachability = reachability;
        dep.imported_at = sites.into_iter().take(10).collect();
    }
    let jvm = RULES.iter().find(|rule| rule.by == By::Artifact).map_or(&[][..], |rule| rule.sources);
    let mut packages: Vec<(String, String)> = Vec::new();
    let mut seen = HashSet::new();
    for site in sites.iter().filter(|s| jvm.contains(&s.extension) && matches!(cx.store.get(s.file).map(|f| f.class), Some(Class::Source)))
    {
        // `org.springframework.web.bind.annotation.GetMapping` ⇢ `org.springframework.web.bind`.
        let package = site.spec.split('.').take(4).collect::<Vec<_>>().join(".");
        if seen.insert(package.clone()) {
            packages.push((package, format!("{}:{}", site.file, site.line)));
        }
    }
    packages
}

/// Imports by what they name, so each package looks up its own instead of scanning them all.
struct Index<'a> {
    sites: &'a [Site<'a>],
    /// npm package and Python top-level module ⇢ sites.
    by_package: HashMap<String, Vec<usize>>,
    /// First path segment, squashed (see `squash`) ⇢ sites.
    by_segment: HashMap<String, Vec<usize>>,
}

impl<'a> Index<'a> {
    fn new(sites: &'a [Site<'a>]) -> Index<'a> {
        let (mut by_package, mut by_segment) = (HashMap::<String, Vec<usize>>::new(), HashMap::<String, Vec<usize>>::new());
        for (i, site) in sites.iter().enumerate() {
            if let Some(package) = npm::package_of(&site.spec) {
                by_package.entry(package.to_owned()).or_default().push(i);
            }
            let module = site.spec.split('.').next().unwrap_or("").to_ascii_lowercase().replace('-', "_");
            by_package.entry(format!("py:{module}")).or_default().push(i);
            if let Some(first) = segments(&site.spec).next() {
                by_segment.entry(first).or_default().push(i);
            }
        }
        Index { sites, by_package, by_segment }
    }

    fn matching(
        &self,
        dep: &Dep,
        by: By,
        extensions: &[&str],
        cx: &Context,
        npm_versions: &HashMap<&str, HashSet<&str>>,
    ) -> Vec<&'a Site<'a>> {
        let of = |ids: Option<&Vec<usize>>| -> Vec<&'a Site<'a>> {
            ids.into_iter().flatten().map(|&i| &self.sites[i]).filter(|s| extensions.contains(&s.extension)).collect()
        };
        match by {
            By::Npm => of(self.by_package.get(&dep.name))
                .into_iter()
                // An import counts for the version its workspace resolves; one no lockfile explains counts for every version.
                .filter(|site| match cx.npm.resolve(site.file, &dep.name) {
                    Some(version) if npm_versions.get(dep.name.as_str()).is_some_and(|known| known.contains(version)) => {
                        version == dep.version
                    }
                    _ => true,
                })
                .collect(),
            By::Python => {
                let normalized = dep.name.to_ascii_lowercase().replace(['-', '.'], "_");
                let module = PYTHON_MODULES.iter().find(|(name, _)| *name == normalized).map_or(normalized.as_str(), |(_, module)| module);
                of(self.by_package.get(&format!("py:{module}")))
            }
            By::GoModule => self.all(extensions).filter(|s| s.spec == dep.name || s.spec.starts_with(&format!("{}/", dep.name))).collect(),
            By::Artifact => {
                let (group, artifact) = dep.name.split_once(':').unwrap_or((&dep.name, ""));
                let artifact = squash(artifact);
                self.all(extensions)
                    .filter(|s| {
                        let segments: Vec<String> = segments(&s.spec).collect();
                        s.spec == group
                            || s.spec.starts_with(&format!("{group}."))
                            || (0..segments.len()).any(|i| spells(&artifact, &segments[i..].join(".")))
                    })
                    .collect()
            }
            By::Namespace => {
                let prefixes: Vec<&str> =
                    cx.namespaces.iter().filter(|(_, package)| *package == dep.name).map(|(prefix, _)| prefix.as_str()).collect();
                self.all(extensions)
                    .filter(|s| {
                        let spec = s.spec.to_ascii_lowercase();
                        prefixes.iter().any(|p| spec == *p || spec.starts_with(&format!("{p}\\")))
                    })
                    .collect()
            }
            By::Name => {
                // The name's first segment is one of its squashed prefixes: look those up, then check the rest.
                let want = squash(&dep.name);
                (1..=want.len())
                    .filter(|&end| want.is_char_boundary(end))
                    .flat_map(|end| of(self.by_segment.get(&want[..end])))
                    .filter(|site| spells(&want, &site.spec))
                    .collect()
            }
        }
    }

    fn all<'e>(&self, extensions: &'e [&'e str]) -> impl Iterator<Item = &'a Site<'a>> + 'e
    where
        'a: 'e,
    {
        self.sites.iter().filter(move |s| extensions.contains(&s.extension))
    }
}

/// Whether a package name spells an import path's leading segments, ignoring case, `-` and `_`:
/// `net-http` ⇢ `net/http`, `Newtonsoft.Json` ⇢ `Newtonsoft.Json.Linq`, `phoenix_live_view` ⇢
/// `Phoenix.LiveView`, but not `serde` ⇢ `serde_json`.
fn spells(want: &str, spec: &str) -> bool {
    let mut have = String::new();
    for segment in segments(spec) {
        have.push_str(&segment);
        if have.len() >= want.len() {
            return have == want;
        }
    }
    false
}

fn segments(spec: &str) -> impl Iterator<Item = String> + '_ {
    spec.split(['.', '/', ':', '\\', '{', ',', ' ']).map(squash).filter(|s| !s.is_empty())
}

fn squash(text: &str) -> String {
    text.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

fn extension(path: &str) -> &str {
    path.rsplit_once('.').map_or("", |(_, extension)| extension)
}

/// Imports in hand-written source the extractor doesn't parse, once per name per file.
fn statements(store: &Store) -> Vec<Site<'_>> {
    static PATTERNS: LazyLock<Vec<(&[&str], Regex)>> =
        LazyLock::new(|| STATEMENTS.iter().map(|(extensions, pattern)| (*extensions, Regex::new(pattern).unwrap())).collect());
    let mut sites = Vec::new();
    for file in store.files.iter().filter(|file| !matches!(file.class, Class::Test | Class::Generated)) {
        let extension = extension(&file.path);
        let Some((_, pattern)) = PATTERNS.iter().find(|(extensions, _)| extensions.contains(&extension)) else { continue };
        let mut seen = HashSet::new();
        for captures in pattern.captures_iter(&file.text) {
            let Some(name) = captures.iter().skip(1).flatten().next() else { continue };
            if seen.insert(name.as_str()) {
                sites.push(Site { spec: name.as_str().to_owned(), file: &file.path, line: file.line_of(name.start()) as u32, extension });
            }
        }
    }
    sites
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_spell_import_paths() {
        for (name, spec) in [
            ("net-http", "net/http"),
            ("Newtonsoft.Json", "Newtonsoft.Json.Linq"),
            ("phoenix_live_view", "Phoenix.LiveView.Socket"),
            ("serde_json", "serde_json::Value"),
            ("serde", "serde::{Deserialize, Serialize}"),
            ("HTTP", "HTTP"),
            ("data.table", "data.table"),
        ] {
            assert!(spells(&squash(name), spec), "{name} ⇢ {spec}");
        }
        for (name, spec) in
            [("serde", "serde_json::Value"), ("react", "react-dom"), ("log", "logging"), ("phoenix_live_view", "Phoenix.Controller")]
        {
            assert!(!spells(&squash(name), spec), "{name} ⇢ {spec}");
        }
    }
}
