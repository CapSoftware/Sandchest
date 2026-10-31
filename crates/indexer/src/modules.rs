//! Resolves import specifiers to files in the checkout, so a call can prefer
//! the definition the calling file actually imports.

use std::collections::HashMap;

use crate::files::Store;
use crate::lang::{Family, Lang};

const JS_SUFFIXES: &[&str] = &["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js", "/index.jsx"];

pub struct Modules<'a> {
    store: &'a Store,
    /// Module path declared in the root `go.mod`.
    go_module: Option<String>,
    /// Java files by file name, for package-qualified imports.
    java_files: HashMap<&'a str, Vec<u32>>,
}

impl<'a> Modules<'a> {
    pub fn new(store: &'a Store) -> Modules<'a> {
        let go_module = store
            .get("go.mod")
            .and_then(|file| file.text.lines().find_map(|line| line.strip_prefix("module ")).map(|m| m.trim().to_owned()));
        let mut java_files: HashMap<&str, Vec<u32>> = HashMap::new();
        for (id, file) in store.files.iter().enumerate() {
            if file.lang == Some(Lang::Java) {
                java_files.entry(file.path.rsplit('/').next().unwrap_or(&file.path)).or_default().push(id as u32);
            }
        }
        Modules { store, go_module, java_files }
    }

    /// Files that `spec`, imported from `from`, may refer to. Go packages
    /// resolve to every file in the package directory.
    pub fn resolve(&self, family: Family, from: &str, spec: &str) -> Vec<u32> {
        let store = self.store;
        let dir = parent(from);
        match family {
            Family::Js => {
                let base = if spec.starts_with('.') {
                    join(dir, spec)
                } else if let Some(rest) = spec.strip_prefix("@/").or_else(|| spec.strip_prefix("~/")) {
                    // Common path aliases for the source root.
                    return first_existing(store, &[format!("src/{rest}"), rest.to_owned()], JS_SUFFIXES);
                } else {
                    return Vec::new();
                };
                base.map(|base| first_existing(store, &[base], JS_SUFFIXES)).unwrap_or_default()
            }
            Family::Python => {
                let dots = spec.chars().take_while(|&c| c == '.').count();
                let module = spec[dots..].replace('.', "/");
                let mut bases = Vec::new();
                if dots > 0 {
                    let mut base = dir.to_owned();
                    for _ in 1..dots {
                        base = parent(&base).to_owned();
                    }
                    bases.push(join_plain(&base, &module));
                } else {
                    // Absolute imports: from the root, or from any ancestor (src layouts, Django projects).
                    let mut ancestor = dir;
                    loop {
                        bases.push(join_plain(ancestor, &module));
                        if ancestor.is_empty() {
                            break;
                        }
                        ancestor = parent(ancestor);
                    }
                }
                for base in bases {
                    let found = first_existing(store, &[base.clone()], &[".py", "/__init__.py"]);
                    if !found.is_empty() {
                        return found;
                    }
                }
                Vec::new()
            }
            Family::Go => {
                let Some(module) = self.go_module.as_deref() else { return Vec::new() };
                let Some(rest) = spec.strip_prefix(module) else { return Vec::new() };
                files_in_dir(store, rest.trim_start_matches('/'), ".go")
            }
            Family::Java => {
                let Some(class) = spec.rsplit('.').next() else { return Vec::new() };
                let path = format!("{}.java", spec.replace('.', "/"));
                let candidates = self.java_files.get(format!("{class}.java").as_str()).into_iter().flatten();
                candidates.copied().filter(|&id| store.files[id as usize].path.ends_with(&path)).collect()
            }
            Family::Php => Vec::new(),
        }
    }
}

/// Every file with `extension` directly inside `dir`.
pub fn files_in_dir(store: &Store, dir: &str, extension: &str) -> Vec<u32> {
    let prefix = if dir.is_empty() { String::new() } else { format!("{dir}/") };
    let start = store.files.partition_point(|file| file.path.as_str() < prefix.as_str());
    store.files[start..]
        .iter()
        .enumerate()
        .take_while(|(_, file)| file.path.starts_with(&prefix))
        .filter(|(_, file)| !file.path[prefix.len()..].contains('/') && file.path.ends_with(extension))
        .map(|(i, _)| (start + i) as u32)
        .collect()
}

fn first_existing(store: &Store, bases: &[String], suffixes: &[&str]) -> Vec<u32> {
    for base in bases {
        for suffix in suffixes {
            if let Some(id) = store.index_of(&format!("{base}{suffix}")) {
                return vec![id as u32];
            }
        }
    }
    Vec::new()
}

fn parent(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(dir, _)| dir)
}

fn join_plain(dir: &str, rest: &str) -> String {
    if dir.is_empty() { rest.to_owned() } else { format!("{dir}/{rest}") }
}

/// Joins a relative specifier onto `dir`, resolving `.` and `..`.
fn join(dir: &str, spec: &str) -> Option<String> {
    let mut parts: Vec<&str> = dir.split('/').filter(|p| !p.is_empty()).collect();
    for segment in spec.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            other => parts.push(other),
        }
    }
    Some(parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_relative_specs() {
        assert_eq!(join("routes", "../lib/insecurity").as_deref(), Some("lib/insecurity"));
        assert_eq!(join("", "./server").as_deref(), Some("server"));
        assert_eq!(join("", "../x"), None);
    }
}
