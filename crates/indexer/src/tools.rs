//! The agent tools. Each takes JSON arguments and returns JSON; transport
//! lives in `server`. Paths are always repository-relative.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::files::{Class, Store};
use crate::index::{Index, SinkAt};
use crate::search;
use crate::sinks::{Input, SinkKind};

const MAX_READ_LINES: usize = 300;
const MAX_READ_BYTES: usize = 40_000;

pub struct State {
    pub store: Store,
    pub index: OnceLock<Index>,
}

impl State {
    /// Blocks until the index is built. File tools never wait.
    fn index(&self) -> &Index {
        self.index.wait()
    }

    fn path(&self, file: u32) -> &str {
        &self.store.files[file as usize].path
    }

    fn location(&self, file: u32, line: u32) -> String {
        format!("{}:{line}", self.path(file))
    }
}

pub const NAMES: &[&str] = &[
    "overview",
    "search",
    "read_file",
    "list_dir",
    "symbols",
    "callers",
    "callees",
    "routes",
    "sinks",
    "trace",
    "deps",
    "leads",
    "locate",
];

pub fn call(state: &State, tool: &str, args: Value) -> Result<Value, String> {
    match tool {
        "overview" => Ok(overview(state)),
        "search" => search(state, parse(args)?),
        "read_file" => read_file(state, parse(args)?),
        "list_dir" => list_dir(state, parse(args)?),
        "symbols" => Ok(symbols(state, parse(args)?)),
        "callers" => Ok(callers(state, parse(args)?)),
        "callees" => Ok(callees(state, parse(args)?)),
        "routes" => Ok(routes(state, parse(args)?)),
        "sinks" => sinks(state, parse(args)?),
        "trace" => trace(state, parse(args)?),
        "deps" => Ok(deps(state, parse(args)?)),
        "leads" => Ok(leads(state)),
        "locate" => Ok(locate(state, parse(args)?)),
        _ => Err(format!("unknown tool {tool}; available: {}", NAMES.join(", "))),
    }
}

fn parse<T: DeserializeOwned>(args: Value) -> Result<T, String> {
    let args = if args.is_null() { json!({}) } else { args };
    serde_json::from_value(args).map_err(|error| format!("invalid arguments: {error}"))
}

fn clean_path(path: &str) -> Result<&str, String> {
    let path = path.trim().trim_start_matches("./").trim_matches('/');
    if path.split('/').any(|segment| segment == "..") {
        return Err("paths must stay inside the repository".to_owned());
    }
    Ok(path)
}

fn input_name(input: Input) -> &'static str {
    match input {
        Input::Literal => "literal",
        Input::Variable => "variable",
        Input::Built => "built",
    }
}

// ---- overview -----------------------------------------------------------

fn overview(state: &State) -> Value {
    let index = state.index();
    let mut languages: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
    let mut top_dirs: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
    let (mut source_files, mut test_files, mut loc) = (0, 0, 0);

    for file in &state.store.files {
        match file.class {
            Class::Source => {
                let lines = file.loc();
                source_files += 1;
                loc += lines;
                let lang = file.lang.map_or("other", |lang| lang.name());
                let entry = languages.entry(lang).or_default();
                entry.0 += 1;
                entry.1 += lines;
                let top = file.path.split_once('/').map_or(".", |(dir, _)| dir);
                let entry = top_dirs.entry(top).or_default();
                entry.0 += 1;
                entry.1 += lines;
            }
            Class::Test => test_files += 1,
            _ => {}
        }
    }

    let mut frameworks: BTreeMap<&str, usize> = BTreeMap::new();
    for route in &index.routes {
        *frameworks.entry(route.route.framework).or_default() += 1;
    }
    let manifests: Vec<&str> =
        index.deps.iter().map(|dep| dep.manifest.as_str()).collect::<std::collections::BTreeSet<_>>().into_iter().collect();

    json!({
        "files": state.store.files.len(),
        "sourceFiles": source_files,
        "testFiles": test_files,
        "skippedFiles": state.store.skipped.len(),
        "loc": loc,
        "languages": languages.iter().map(|(lang, (files, loc))| json!({ "language": lang, "files": files, "loc": loc })).collect::<Vec<_>>(),
        "topDirectories": top_dirs.iter().map(|(dir, (files, loc))| json!({ "path": dir, "files": files, "loc": loc })).collect::<Vec<_>>(),
        "routes": index.routes.len(),
        "routeFrameworks": frameworks,
        "symbols": index.symbols.len(),
        "sinks": index.sink_summary(),
        "secrets": index.secrets.len(),
        "injectionMarkers": index.markers.len(),
        "dependencies": { "total": index.deps.len(), "direct": index.deps.iter().filter(|dep| dep.direct).count() },
        "manifests": manifests,
        "indexMs": index.build_ms,
    })
}

// ---- files --------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SearchArgs {
    pattern: String,
    #[serde(default)]
    literal: bool,
    #[serde(default)]
    ignore_case: bool,
    glob: Option<String>,
    max_results: Option<usize>,
    #[serde(default)]
    include_tests: bool,
}

fn search(state: &State, args: SearchArgs) -> Result<Value, String> {
    let max = args.max_results.unwrap_or(50).clamp(1, 200);
    let query = search::Query::new(&args.pattern, args.literal, args.ignore_case, args.glob.as_deref(), max, args.include_tests)?;
    Ok(serde_json::to_value(search::run(&state.store, &query)).unwrap())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadArgs {
    path: String,
    start_line: Option<usize>,
    end_line: Option<usize>,
}

fn read_file(state: &State, args: ReadArgs) -> Result<Value, String> {
    let path = clean_path(&args.path)?;
    let Some(file) = state.store.get(path) else {
        if let Some(skipped) = state.store.skipped.iter().find(|s| s.path == path) {
            return Err(format!("{path} is not readable ({}, {} bytes)", skipped.reason, skipped.bytes));
        }
        return Err(format!("no such file: {path}"));
    };
    let total = file.line_count();
    let start = args.start_line.unwrap_or(1).max(1);
    if total > 0 && start > total {
        return Err(format!("{path} has only {total} lines"));
    }
    let requested_end = args.end_line.unwrap_or(total).min(total).max(start);
    let mut end = requested_end.min(start + MAX_READ_LINES - 1);

    let mut content = String::new();
    for line in start..=end {
        let text = file.line(line).unwrap_or("");
        if content.len() + text.len() > MAX_READ_BYTES && line > start {
            end = line - 1;
            break;
        }
        content.push_str(text);
        content.push('\n');
    }
    Ok(
        json!({ "path": path, "startLine": start, "endLine": end, "totalLines": total, "truncated": end < requested_end, "content": content }),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListArgs {
    #[serde(default)]
    path: String,
}

fn list_dir(state: &State, args: ListArgs) -> Result<Value, String> {
    let path = clean_path(&args.path)?;
    let entries = state.store.list_dir(path);
    if entries.is_empty() && !path.is_empty() {
        return Err(format!("no such directory: {path}"));
    }
    let entries: Vec<Value> = entries
        .into_iter()
        .map(|(name, is_dir)| {
            if is_dir {
                json!({ "name": name, "type": "dir" })
            } else {
                let full = if path.is_empty() { name.clone() } else { format!("{path}/{name}") };
                let lines = state.store.get(&full).map(|file| file.line_count());
                json!({ "name": name, "type": "file", "lines": lines })
            }
        })
        .collect();
    Ok(json!({ "path": path, "entries": entries }))
}

// ---- symbols and call graph ---------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SymbolArgs {
    query: String,
    limit: Option<usize>,
}

fn symbols(state: &State, args: SymbolArgs) -> Value {
    let index = state.index();
    let ids = index.find_symbols(args.query.trim(), args.limit.unwrap_or(30).clamp(1, 100));
    let symbols: Vec<Value> = ids.into_iter().map(|id| symbol_json(state, index, id)).collect();
    json!({ "symbols": symbols })
}

fn symbol_json(state: &State, index: &Index, id: u32) -> Value {
    let entry = &index.symbols[id as usize];
    json!({
        "name": index.symbol_name(Some(id)),
        "kind": entry.symbol.kind,
        "file": state.path(entry.file),
        "line": entry.symbol.line,
        "endLine": entry.symbol.end_line,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GraphArgs {
    symbol: String,
    limit: Option<usize>,
}

fn callers(state: &State, args: GraphArgs) -> Value {
    let index = state.index();
    let limit = args.limit.unwrap_or(40).clamp(1, 200);
    let all: Vec<_> = index.callers(args.symbol.trim()).collect();
    let callers: Vec<Value> = all
        .iter()
        .take(limit)
        .map(|&(file, caller, callee, line)| {
            json!({ "caller": index.symbol_name(caller), "call": callee, "at": state.location(file, line) })
        })
        .collect();
    json!({ "symbol": args.symbol, "callers": callers, "total": all.len() })
}

fn callees(state: &State, args: GraphArgs) -> Value {
    let index = state.index();
    let limit = args.limit.unwrap_or(60).clamp(1, 200);
    let definitions: Vec<Value> = index
        .resolve(args.symbol.trim())
        .into_iter()
        .take(5)
        .map(|id| {
            let calls: Vec<Value> = index
                .callees(id)
                .take(limit)
                .map(|(callee, line, targets)| {
                    let resolved: Vec<String> = targets
                        .iter()
                        .take(3)
                        .map(|&t| state.location(index.symbols[t as usize].file, index.symbols[t as usize].symbol.line))
                        .collect();
                    json!({ "call": callee, "line": line, "definedAt": resolved })
                })
                .collect();
            json!({ "definition": symbol_json(state, index, id), "calls": calls })
        })
        .collect();
    json!({ "symbol": args.symbol, "definitions": definitions })
}

// ---- routes, sinks and paths ---------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RouteArgs {
    filter: Option<String>,
    limit: Option<usize>,
}

fn routes(state: &State, args: RouteArgs) -> Value {
    let index = state.index();
    let filter = args.filter.as_deref().map(str::to_ascii_lowercase).filter(|f| !f.is_empty());
    let limit = args.limit.unwrap_or(200).clamp(1, 1000);
    let matching: Vec<_> = index
        .routes
        .iter()
        .filter(|entry| {
            let Some(filter) = &filter else { return true };
            let route = &entry.route;
            let haystack =
                format!("{} {} {} {}", route.method, route.path, state.path(entry.file), route.handlers.join(" ")).to_ascii_lowercase();
            haystack.contains(filter)
        })
        .collect();
    let total = matching.len();
    let routes: Vec<Value> = matching
        .into_iter()
        .take(limit)
        .map(|entry| {
            let handlers: Vec<String> = index
                .route_handlers(entry)
                .into_iter()
                .take(6)
                .map(|id| {
                    format!(
                        "{} @ {}",
                        index.symbol_name(Some(id)),
                        state.location(index.symbols[id as usize].file, index.symbols[id as usize].symbol.line)
                    )
                })
                .collect();
            json!({
                "method": entry.route.method,
                "path": entry.route.path,
                "at": state.location(entry.file, entry.route.line),
                "chain": entry.route.handlers,
                "handlers": handlers,
                "framework": entry.route.framework,
            })
        })
        .collect();
    json!({ "routes": routes, "total": total })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SinkArgs {
    kind: Option<String>,
    path: Option<String>,
    min_input: Option<String>,
    limit: Option<usize>,
}

fn sinks(state: &State, args: SinkArgs) -> Result<Value, String> {
    let index = state.index();
    let kind = match args.kind.as_deref().filter(|k| !k.is_empty()) {
        Some(name) => Some(SinkKind::parse(name).ok_or_else(|| format!("unknown sink kind {name}"))?),
        None => None,
    };
    let min_input = match args.min_input.as_deref() {
        Some("built") => Input::Built,
        Some("literal") => Input::Literal,
        _ => Input::Variable,
    };
    let prefix = args.path.as_deref().map(clean_path).transpose()?.unwrap_or("");
    let limit = args.limit.unwrap_or(80).clamp(1, 500);

    let mut matching: Vec<&SinkAt> = index
        .sinks
        .iter()
        .filter(|sink| kind.is_none_or(|kind| sink.kind == kind) && sink.input >= min_input && state.path(sink.file).starts_with(prefix))
        .collect();
    // Assembled input first: that is where injections live.
    matching.sort_by(|a, b| b.input.cmp(&a.input).then(a.file.cmp(&b.file)).then(a.line.cmp(&b.line)));
    let total = matching.len();
    let sinks: Vec<Value> = matching.into_iter().take(limit).map(|sink| sink_json(state, index, sink)).collect();
    Ok(json!({ "sinks": sinks, "total": total }))
}

fn sink_json(state: &State, index: &Index, sink: &SinkAt) -> Value {
    let code = state.store.files[sink.file as usize].line(sink.line as usize).unwrap_or("").trim();
    json!({
        "kind": sink.kind,
        "at": state.location(sink.file, sink.line),
        "in": index.symbol_name(sink.caller),
        "call": sink.callee,
        "input": input_name(sink.input),
        "reachable": index.is_reachable(sink),
        "code": truncate(code, 200),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TraceArgs {
    from: String,
    to: Option<String>,
    max_depth: Option<usize>,
    limit: Option<usize>,
}

/// Call paths from an entry point (route or symbol) to sinks of a kind or to a symbol.
fn trace(state: &State, args: TraceArgs) -> Result<Value, String> {
    let index = state.index();
    let from = args.from.trim();
    let starts = start_symbols(index, from);
    if starts.is_empty() {
        return Err(format!("no route or symbol matches {from:?}; use routes() or symbols() to find one"));
    }
    let to = args.to.as_deref().map(str::trim).filter(|t| !t.is_empty());
    let sink_kind = to.and_then(SinkKind::parse);
    let target_symbols: Vec<u32> = match (to, sink_kind) {
        (Some(name), None) => index.resolve(name),
        _ => Vec::new(),
    };
    if to.is_some() && sink_kind.is_none() && target_symbols.is_empty() {
        return Err(format!("{:?} is neither a sink kind nor a known symbol", to.unwrap()));
    }

    let is_target = |id: u32| {
        if !target_symbols.is_empty() {
            return target_symbols.contains(&id);
        }
        index.sinks_in(id).any(|sink| sink.input > Input::Literal && sink_kind.is_none_or(|kind| sink.kind == kind))
    };
    let paths = index.paths(&starts, is_target, args.max_depth.unwrap_or(8).clamp(1, 12), args.limit.unwrap_or(10).clamp(1, 30));

    let paths: Vec<Value> = paths
        .into_iter()
        .map(|path| {
            let last = path.last().unwrap().0;
            let hops: Vec<Value> = path
                .iter()
                .map(|&(id, call_line)| {
                    let symbol = &index.symbols[id as usize];
                    let mut hop =
                        json!({ "symbol": index.symbol_name(Some(id)), "definedAt": state.location(symbol.file, symbol.symbol.line) });
                    if call_line > 0 {
                        hop["callsNextAt"] = json!(state.location(symbol.file, call_line));
                    }
                    hop
                })
                .collect();
            let sinks: Vec<Value> = index
                .sinks_in(last)
                .filter(|sink| sink.input > Input::Literal && sink_kind.is_none_or(|kind| sink.kind == kind))
                .take(5)
                .map(|sink| sink_json(state, index, sink))
                .collect();
            json!({ "hops": hops, "sinks": sinks })
        })
        .collect();
    Ok(
        json!({ "from": from, "paths": paths, "note": "Paths follow calls by name and may include false edges; confirm each hop by reading the code." }),
    )
}

/// Symbols that start a trace: a route given as "METHOD /path" or "/path", or a symbol name.
fn start_symbols(index: &Index, from: &str) -> Vec<u32> {
    let (method, path) = match from.split_once(' ') {
        Some((method, path)) if method.chars().all(|c| c.is_ascii_uppercase()) => (Some(method), path.trim()),
        _ => (None, from),
    };
    if path.starts_with('/') || path.contains('#') {
        let mut ids = Vec::new();
        for entry in &index.routes {
            if entry.route.path == path && method.is_none_or(|m| entry.route.method.split(',').any(|rm| rm == m || rm == "ANY")) {
                ids.extend(index.route_handlers(entry));
                // PHP scripts are their own handler: start from everything defined in the file.
                if entry.route.handlers.is_empty() {
                    ids.extend(index.symbols.iter().enumerate().filter(|(_, s)| s.file == entry.file).map(|(i, _)| i as u32));
                }
            }
        }
        if !ids.is_empty() {
            ids.sort_unstable();
            ids.dedup();
            return ids;
        }
    }
    index.resolve(from)
}

// ---- dependencies and leads ---------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DepsArgs {
    #[serde(default)]
    imported_only: bool,
}

fn deps(state: &State, args: DepsArgs) -> Value {
    let index = state.index();
    let deps: Vec<&crate::deps::Dep> =
        index.deps.iter().filter(|dep| !args.imported_only || dep.reachability == crate::deps::Reachability::Imported).collect();
    json!({ "dependencies": deps })
}

/// Deterministic signals: committed secrets, text addressed to the scanner, and the sink inventory.
fn leads(state: &State) -> Value {
    let index = state.index();
    let secrets: Vec<Value> = index
        .secrets
        .iter()
        .map(|s| json!({ "rule": s.item.rule, "at": state.location(s.file, s.item.line), "redacted": s.item.redacted }))
        .collect();
    let markers: Vec<Value> =
        index.markers.iter().map(|m| json!({ "at": state.location(m.file, m.item.line), "text": m.item.text })).collect();
    let mut built: Vec<&SinkAt> = index
        .sinks
        .iter()
        .filter(|sink| {
            sink.input == Input::Built
                || matches!(
                    sink.kind,
                    SinkKind::Deserialization
                        | SinkKind::Xxe
                        | SinkKind::Jwt
                        | SinkKind::Xss
                        | SinkKind::Nosql
                        | SinkKind::Command
                        | SinkKind::CodeEval
                )
        })
        .collect();
    // Sinks a route can reach first: code that never runs on a request is rarely exploitable.
    built.sort_by_key(|sink| (!index.is_reachable(sink), std::cmp::Reverse(sink.input), sink.file, sink.line));
    let sinks: Vec<Value> = built.into_iter().take(200).map(|sink| sink_json(state, index, sink)).collect();
    json!({ "secrets": secrets, "injectionMarkers": markers, "sinks": sinks, "sinkSummary": index.sink_summary() })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocateArgs {
    locations: Vec<Location>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Location {
    file: String,
    line: u32,
}

/// Checks `file:line` citations and returns the cited line and its enclosing symbol.
fn locate(state: &State, args: LocateArgs) -> Value {
    let index = state.index();
    let results: Vec<Value> = args
        .locations
        .iter()
        .take(200)
        .map(|location| {
            let path = clean_path(&location.file).unwrap_or("");
            let Some(file_id) = state.store.index_of(path) else {
                return json!({ "file": location.file, "line": location.line, "exists": false });
            };
            let file = &state.store.files[file_id];
            match file.line(location.line as usize) {
                Some(text) => {
                    let symbol = index.enclosing(file_id as u32, location.line);
                    json!({
                        "file": path,
                        "line": location.line,
                        "exists": true,
                        "text": truncate(text, 400),
                        "symbol": symbol.map(|id| index.symbol_name(Some(id))),
                        "totalLines": file.line_count(),
                    })
                }
                None => json!({ "file": path, "line": location.line, "exists": false, "totalLines": file.line_count() }),
            }
        })
        .collect();
    json!({ "locations": results })
}

fn truncate(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((cut, _)) => format!("{}…", &text[..cut]),
        None => text.to_owned(),
    }
}
