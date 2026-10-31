//! Regex search over the in-memory file store.

use globset::{Glob, GlobMatcher};
use rayon::prelude::*;
use regex::{Regex, RegexBuilder};
use serde::Serialize;

use crate::files::{Class, File, Store};

/// Longest line text returned per match.
const MAX_MATCH_TEXT: usize = 240;

pub struct Query {
    pub regex: Regex,
    pub glob: Option<GlobMatcher>,
    pub max_results: usize,
    pub include_tests: bool,
}

impl Query {
    pub fn new(
        pattern: &str,
        literal: bool,
        ignore_case: bool,
        glob: Option<&str>,
        max_results: usize,
        include_tests: bool,
    ) -> Result<Query, String> {
        let source = if literal { regex::escape(pattern) } else { pattern.to_owned() };
        let regex = RegexBuilder::new(&source)
            .case_insensitive(ignore_case)
            .multi_line(true)
            .size_limit(1 << 22)
            .dfa_size_limit(1 << 24)
            .build()
            .map_err(|error| format!("invalid pattern: {error}"))?;
        let glob = match glob.filter(|glob| !glob.is_empty()) {
            Some(glob) => Some(Glob::new(glob).map_err(|error| format!("invalid glob: {error}"))?.compile_matcher()),
            None => None,
        };
        Ok(Query { regex, glob, max_results, include_tests })
    }
}

#[derive(Serialize)]
pub struct Match {
    pub file: String,
    pub line: usize,
    pub text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Results {
    pub matches: Vec<Match>,
    /// More matches exist than were returned.
    pub truncated: bool,
    pub files_with_matches: usize,
}

pub fn run(store: &Store, query: &Query) -> Results {
    let per_file: Vec<Vec<Match>> = store
        .files
        .par_iter()
        .filter(|file| file.class != Class::Generated && (query.include_tests || file.class != Class::Test || query.glob.is_some()))
        .filter(|file| query.glob.as_ref().is_none_or(|glob| glob.is_match(&file.path)))
        .map(|file| matches_in(file, &query.regex, query.max_results + 1))
        .filter(|matches| !matches.is_empty())
        .collect();

    let files_with_matches = per_file.len();
    let mut matches: Vec<Match> = per_file.into_iter().flatten().collect();
    let truncated = matches.len() > query.max_results;
    matches.truncate(query.max_results);
    Results { matches, truncated, files_with_matches }
}

/// One match per line, scanning the whole file in a single regex pass.
fn matches_in(file: &File, regex: &Regex, cap: usize) -> Vec<Match> {
    let mut out = Vec::new();
    let mut last_line = 0;
    for found in regex.find_iter(&file.text) {
        let line = file.line_of(found.start());
        if line == last_line {
            continue;
        }
        last_line = line;
        let text = file.line(line).unwrap_or("").trim();
        out.push(Match { file: file.path.clone(), line, text: truncate(text) });
        if out.len() >= cap {
            break;
        }
    }
    out
}

fn truncate(text: &str) -> String {
    match text.char_indices().nth(MAX_MATCH_TEXT) {
        Some((cut, _)) => format!("{}…", &text[..cut]),
        None => text.to_owned(),
    }
}
