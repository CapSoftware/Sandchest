//! The file store: every readable text file in the checkout, loaded into
//! memory once so search and reads never touch the disk again.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Mutex;

use ignore::{WalkBuilder, WalkState};
use serde::Serialize;

use crate::lang::Lang;

/// Files larger than this are listed but not loaded.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// Bytes inspected when sniffing for binary content or generated-file markers.
const SNIFF_BYTES: usize = 8 * 1024;

/// Directories that only ever hold third-party or build output.
const VENDORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "bower_components",
    "jspm_packages",
    "vendor",
    "third_party",
    "third-party",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".output",
    "coverage",
    "target",
    "__pycache__",
    ".venv",
    "venv",
    "site-packages",
    ".tox",
    ".mypy_cache",
    ".gradle",
    ".idea",
    ".vscode",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Class {
    /// Hand-written code: parsed, scanned and counted.
    Source,
    /// Tests and fixtures: searchable, but not part of the attack surface.
    Test,
    /// Generated or minified output: readable on request, otherwise ignored.
    Generated,
    /// Configuration, docs, data and anything else that is not code.
    Other,
}

pub struct File {
    /// Repository-relative path with `/` separators.
    pub path: String,
    pub lang: Option<Lang>,
    pub class: Class,
    pub text: String,
    /// Byte offset at which each line starts.
    pub line_starts: Vec<u32>,
}

impl File {
    pub fn line_count(&self) -> usize {
        // A trailing newline does not start a new line.
        if self.text.ends_with('\n') { self.line_starts.len() - 1 } else { self.line_starts.len() }
    }

    /// 1-based line number containing `offset`.
    pub fn line_of(&self, offset: usize) -> usize {
        self.line_starts.partition_point(|&start| start as usize <= offset)
    }

    /// The text of 1-based `line`, without its line ending.
    pub fn line(&self, line: usize) -> Option<&str> {
        if line == 0 || line > self.line_count() {
            return None;
        }
        let start = self.line_starts[line - 1] as usize;
        let end = self.line_starts.get(line).map_or(self.text.len(), |&end| end as usize);
        Some(self.text[start..end].trim_end_matches(['\n', '\r']))
    }

    /// Non-blank lines.
    pub fn loc(&self) -> usize {
        self.text.lines().filter(|line| !line.trim().is_empty()).count()
    }
}

/// A file that exists but was not loaded.
#[derive(Serialize)]
pub struct Skipped {
    pub path: String,
    pub reason: &'static str,
    pub bytes: u64,
}

pub struct Store {
    /// Sorted by path.
    pub files: Vec<File>,
    pub skipped: Vec<Skipped>,
}

impl Store {
    /// Walks `root` in parallel and loads every text file. Honours `.gitignore`,
    /// never follows symlinks, and leaves out vendored directories entirely.
    pub fn load(root: &Path) -> Store {
        let files = Mutex::new(Vec::new());
        let skipped = Mutex::new(Vec::new());

        WalkBuilder::new(root)
            .hidden(false)
            .follow_links(false)
            .require_git(false)
            .filter_entry(|entry| {
                !(entry.file_type().is_some_and(|t| t.is_dir()) && VENDORED_DIRS.contains(&entry.file_name().to_str().unwrap_or("")))
            })
            .build_parallel()
            .run(|| {
                Box::new(|entry| {
                    let Ok(entry) = entry else { return WalkState::Continue };
                    if !entry.file_type().is_some_and(|t| t.is_file()) {
                        return WalkState::Continue;
                    }
                    let Some(path) = relative_path(root, entry.path()) else { return WalkState::Continue };
                    match load_file(entry.path(), path) {
                        Ok(file) => files.lock().unwrap().push(file),
                        Err(skip) => skipped.lock().unwrap().push(skip),
                    }
                    WalkState::Continue
                })
            });

        let mut files = files.into_inner().unwrap();
        files.sort_unstable_by(|a, b| a.path.cmp(&b.path));
        let mut skipped = skipped.into_inner().unwrap();
        skipped.sort_unstable_by(|a, b| a.path.cmp(&b.path));
        Store { files, skipped }
    }

    pub fn get(&self, path: &str) -> Option<&File> {
        self.files.binary_search_by(|file| file.path.as_str().cmp(path)).ok().map(|i| &self.files[i])
    }

    pub fn index_of(&self, path: &str) -> Option<usize> {
        self.files.binary_search_by(|file| file.path.as_str().cmp(path)).ok()
    }

    /// Immediate children of directory `dir` ("" for the root): `(name, is_dir)`.
    pub fn list_dir(&self, dir: &str) -> Vec<(String, bool)> {
        let prefix = if dir.is_empty() { String::new() } else { format!("{dir}/") };
        let start = self.files.partition_point(|file| file.path.as_str() < prefix.as_str());
        let mut entries = BTreeSet::new();
        let loaded = self.files[start..].iter().map(|file| file.path.as_str());
        let skipped = self.skipped.iter().map(|file| file.path.as_str()).filter(|path| path.starts_with(&prefix));
        for path in loaded.take_while(|path| path.starts_with(&prefix)).chain(skipped) {
            let rest = &path[prefix.len()..];
            match rest.split_once('/') {
                Some((name, _)) => entries.insert((name.to_owned(), true)),
                None => entries.insert((rest.to_owned(), false)),
            };
        }
        entries.into_iter().collect()
    }
}

fn relative_path(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?.to_str()?;
    Some(if std::path::MAIN_SEPARATOR == '/' { relative.to_owned() } else { relative.replace(std::path::MAIN_SEPARATOR, "/") })
}

fn load_file(full: &Path, path: String) -> Result<File, Skipped> {
    let bytes = std::fs::metadata(full).map(|m| m.len()).unwrap_or(0);
    if bytes > MAX_FILE_BYTES {
        return Err(Skipped { path, reason: "too_large", bytes });
    }
    let data = std::fs::read(full).map_err(|_| Skipped { path: path.clone(), reason: "unreadable", bytes })?;
    let head = &data[..data.len().min(SNIFF_BYTES)];
    if memchr::memchr(0, head).is_some() {
        return Err(Skipped { path, reason: "binary", bytes });
    }

    let text = match String::from_utf8(data) {
        Ok(text) => text,
        Err(error) => String::from_utf8_lossy(error.as_bytes()).into_owned(),
    };
    let line_starts = std::iter::once(0).chain(memchr::memchr_iter(b'\n', text.as_bytes()).map(|i| i as u32 + 1)).collect();
    let lang = Lang::from_path(&path);
    let class = classify(&path, lang, &text);
    Ok(File { path, lang, class, text, line_starts })
}

fn classify(path: &str, lang: Option<Lang>, text: &str) -> Class {
    let name = path.rsplit('/').next().unwrap_or(path);
    let lower = name.to_ascii_lowercase();
    if lower.contains(".min.")
        || lower.ends_with(".map")
        || lower.ends_with(".pb.go")
        || lower.ends_with("_pb2.py")
        || lower.contains(".generated.")
        || lower.contains(".bundle.")
    {
        return Class::Generated;
    }
    if lang.is_none() {
        return Class::Other;
    }
    let head = &text[..floor_char_boundary(text, SNIFF_BYTES.min(text.len()))];
    if head.contains("@generated") || head.contains("Code generated") && head.contains("DO NOT EDIT") || is_minified(text) {
        return Class::Generated;
    }
    if is_test_path(path, &lower) {
        return Class::Test;
    }
    Class::Source
}

fn is_test_path(path: &str, lower_name: &str) -> bool {
    // File-system routers (`app/api/test/route.ts`) use directory names as URL segments.
    let routed = path.split('/').any(|segment| matches!(segment, "app" | "pages" | "routes"));
    let in_test_dir = !routed
        && path.split('/').any(|segment| {
            matches!(
                segment,
                "test"
                    | "tests"
                    | "__tests__"
                    | "__mocks__"
                    | "spec"
                    | "specs"
                    | "e2e"
                    | "cypress"
                    | "testdata"
                    | "fixtures"
                    | "test-fixtures"
            )
        });
    in_test_dir
        || lower_name.contains(".test.")
        || lower_name.contains(".spec.")
        || lower_name.ends_with("_test.go")
        || lower_name.ends_with("_test.py")
        || lower_name.starts_with("test_") && lower_name.ends_with(".py")
        || lower_name.ends_with("test.java") && !lower_name.eq("test.java")
}

/// Minified files have very long lines on average.
fn is_minified(text: &str) -> bool {
    text.len() > 4096 && text.len() / text.bytes().filter(|&b| b == b'\n').count().max(1) > 400
}

fn floor_char_boundary(text: &str, mut index: usize) -> usize {
    while !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}
