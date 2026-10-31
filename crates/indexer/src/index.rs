//! The code index: symbols, a name-resolved call graph, routes, sinks,
//! secrets and dependencies for the whole checkout, built in parallel.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::time::Instant;

use rayon::prelude::*;
use serde::Serialize;

use crate::deps::{self, Dep, ImportSite};
use crate::extract::{self, Route, Symbol, SymbolKind};
use crate::files::{Class, Store};
use crate::modules::{self, Modules};
use crate::sinks::{Input, SinkKind};
use crate::textscan::{self, Marker, Secret};

/// A call that could resolve to more definitions than this is too ambiguous to follow.
const MAX_FANOUT: usize = 6;

pub struct Index {
    pub symbols: Vec<SymbolAt>,
    calls: Vec<CallAt>,
    pub routes: Vec<RouteAt>,
    pub sinks: Vec<SinkAt>,
    pub secrets: Vec<At<Secret>>,
    pub markers: Vec<At<Marker>>,
    pub deps: Vec<Dep>,
    /// Symbol ids by name.
    by_name: HashMap<String, Vec<u32>>,
    /// Call ids by the callee's last segment.
    calls_by_name: HashMap<String, Vec<u32>>,
    /// Call ids by calling symbol.
    calls_by_caller: HashMap<u32, Vec<u32>>,
    /// Symbol ids per file, in source order.
    file_symbols: Vec<Vec<u32>>,
    /// Files each file imports (sorted), used to pick the right definition of a name.
    file_imports: Vec<Vec<u32>>,
    /// Symbols some route handler can reach through the call graph.
    reachable: HashSet<u32>,
    pub build_ms: u128,
}

#[derive(Serialize)]
pub struct At<T> {
    pub file: u32,
    #[serde(flatten)]
    pub item: T,
}

pub struct SymbolAt {
    pub file: u32,
    pub symbol: Symbol,
}

struct CallAt {
    file: u32,
    caller: Option<u32>,
    callee: String,
    line: u32,
}

pub struct RouteAt {
    pub file: u32,
    pub route: Route,
}

pub struct SinkAt {
    pub file: u32,
    pub kind: SinkKind,
    /// The call, or the text pattern for markup sinks.
    pub callee: String,
    pub input: Input,
    pub line: u32,
    pub caller: Option<u32>,
}

impl Index {
    pub fn build(store: &Store) -> Index {
        let started = Instant::now();

        let per_file: Vec<(extract::Facts, textscan::TextFacts)> = store
            .files
            .par_iter()
            .map(|file| {
                let code = match (file.lang, file.class) {
                    (Some(lang), Class::Source) => extract::extract(file, lang),
                    _ => extract::Facts::default(),
                };
                (code, textscan::scan(file))
            })
            .collect();

        let mut index = Index {
            symbols: Vec::new(),
            calls: Vec::new(),
            routes: Vec::new(),
            sinks: Vec::new(),
            secrets: Vec::new(),
            markers: Vec::new(),
            deps: Vec::new(),
            by_name: HashMap::new(),
            calls_by_name: HashMap::new(),
            calls_by_caller: HashMap::new(),
            file_symbols: vec![Vec::new(); store.files.len()],
            file_imports: Vec::new(),
            reachable: HashSet::new(),
            build_ms: 0,
        };
        let mut imports = Vec::new();

        for (file, (code, text)) in per_file.into_iter().enumerate() {
            let file = file as u32;
            let base = index.symbols.len() as u32;
            let global = |local: Option<u32>| local.map(|id| base + id);

            for symbol in code.symbols {
                let id = index.symbols.len() as u32;
                index.by_name.entry(symbol.name.clone()).or_default().push(id);
                index.file_symbols[file as usize].push(id);
                index.symbols.push(SymbolAt { file, symbol });
            }
            for call in code.calls {
                let id = index.calls.len() as u32;
                index.calls_by_name.entry(last_segment(&call.callee).to_owned()).or_default().push(id);
                if let Some(caller) = global(call.caller) {
                    index.calls_by_caller.entry(caller).or_default().push(id);
                }
                index.calls.push(CallAt { file, caller: global(call.caller), callee: call.callee, line: call.line });
            }
            index.routes.extend(code.routes.into_iter().map(|route| RouteAt { file, route }));
            index.sinks.extend(code.sinks.into_iter().map(|sink| SinkAt {
                file,
                kind: sink.kind,
                callee: sink.callee,
                input: sink.input,
                line: sink.line,
                caller: global(sink.caller),
            }));
            for sink in text.sinks {
                let caller = index.enclosing(file, sink.line);
                index.sinks.push(SinkAt {
                    file,
                    kind: sink.kind,
                    callee: sink.pattern.to_owned(),
                    input: Input::Variable,
                    line: sink.line,
                    caller,
                });
            }
            index.secrets.extend(text.secrets.into_iter().map(|item| At { file, item }));
            index.markers.extend(text.markers.into_iter().map(|item| At { file, item }));
            imports.extend(code.imports.into_iter().map(|import| (file, import)));
        }

        let sites: Vec<ImportSite> = imports
            .iter()
            .map(|(file, import)| ImportSite { spec: &import.spec, file: &store.files[*file as usize].path, line: import.line })
            .collect();
        index.deps = deps::collect(store, &sites);
        index.file_imports = resolve_imports(store, &imports);
        index.reachable = index.reachable_from_routes();
        index.build_ms = started.elapsed().as_millis();
        index
    }

    /// The innermost function containing `line`, or the innermost class if none.
    pub fn enclosing(&self, file: u32, line: u32) -> Option<u32> {
        let mut best: Option<u32> = None;
        for &id in self.file_symbols.get(file as usize)? {
            let symbol = &self.symbols[id as usize].symbol;
            if symbol.line > line {
                break;
            }
            if symbol.end_line >= line {
                let replaces = match best {
                    None => true,
                    Some(current) => symbol.kind != SymbolKind::Class || self.symbols[current as usize].symbol.kind == SymbolKind::Class,
                };
                if replaces {
                    best = Some(id);
                }
            }
        }
        best
    }

    pub fn symbol_name(&self, id: Option<u32>) -> String {
        match id {
            Some(id) => {
                let symbol = &self.symbols[id as usize].symbol;
                match &symbol.container {
                    Some(container) => format!("{container}.{}", symbol.name),
                    None => symbol.name.clone(),
                }
            }
            None => "(top level)".to_owned(),
        }
    }

    /// Symbols matching a name, `Container.name`, or a route handler name.
    pub fn resolve(&self, name: &str) -> Vec<u32> {
        if let Some(ids) = self.by_name.get(name) {
            return ids.clone();
        }
        let Some((container, last)) = name.rsplit_once('.') else { return Vec::new() };
        self.by_name
            .get(last)
            .map(|ids| ids.iter().copied().filter(|&id| self.symbols[id as usize].symbol.container.as_deref() == Some(container)).collect())
            .unwrap_or_default()
    }

    pub fn find_symbols(&self, query: &str, limit: usize) -> Vec<u32> {
        let lower = query.to_ascii_lowercase();
        let mut exact = self.resolve(query);
        let mut prefix = Vec::new();
        let mut contains = Vec::new();
        for (name, ids) in &self.by_name {
            if name == query {
                continue;
            }
            let name = name.to_ascii_lowercase();
            if name.starts_with(&lower) {
                prefix.extend_from_slice(ids);
            } else if name.contains(&lower) {
                contains.extend_from_slice(ids);
            }
        }
        prefix.sort_unstable();
        contains.sort_unstable();
        exact.extend(prefix);
        exact.extend(contains);
        exact.truncate(limit);
        exact
    }

    /// Call sites that may invoke `name`.
    pub fn callers(&self, name: &str) -> impl Iterator<Item = (u32, Option<u32>, &str, u32)> {
        let last = last_segment(name);
        let qualifier = name.rsplit_once('.').map(|(q, _)| q);
        self.calls_by_name.get(last).into_iter().flatten().filter_map(move |&id| {
            let call = &self.calls[id as usize];
            // `Class.method` should not match unrelated `other.method` calls when the class is named.
            if let Some(qualifier) = qualifier {
                let caller_class = call.caller.and_then(|c| self.symbols[c as usize].symbol.container.as_deref());
                if !call.callee.contains(qualifier) && caller_class != Some(qualifier) && !call.callee.starts_with(last) {
                    return None;
                }
            }
            Some((call.file, call.caller, call.callee.as_str(), call.line))
        })
    }

    /// Calls made inside symbol `id`: `(callee, line, resolved definitions)`.
    pub fn callees(&self, id: u32) -> impl Iterator<Item = (&str, u32, Vec<u32>)> {
        self.calls_by_caller.get(&id).into_iter().flatten().map(move |&call_id| {
            let call = &self.calls[call_id as usize];
            let targets = self.call_targets(call);
            (call.callee.as_str(), call.line, targets)
        })
    }

    fn call_targets(&self, call: &CallAt) -> Vec<u32> {
        self.definitions(last_segment(&call.callee), call.file)
    }

    /// Definitions of `name` as seen from `file`: those in the file itself or
    /// in files it imports win; otherwise any, if the name is unambiguous enough.
    pub fn definitions(&self, name: &str, file: u32) -> Vec<u32> {
        let candidates = self.resolve(name);
        let callable: Vec<u32> = candidates
            .iter()
            .copied()
            .filter(|&id| self.symbols[id as usize].symbol.kind != SymbolKind::Class || candidates.len() == 1)
            .collect();
        let imported = &self.file_imports[file as usize];
        let visible: Vec<u32> = callable
            .iter()
            .copied()
            .filter(|&id| {
                let defined_in = self.symbols[id as usize].file;
                defined_in == file || imported.binary_search(&defined_in).is_ok()
            })
            .collect();
        if !visible.is_empty() {
            visible
        } else if callable.len() <= MAX_FANOUT {
            callable
        } else {
            Vec::new()
        }
    }

    /// Symbols that handle a route, resolved from its handler names.
    pub fn route_handlers(&self, route: &RouteAt) -> Vec<u32> {
        let mut ids: Vec<u32> = route.route.handlers.iter().flat_map(|name| self.definitions(name, route.file)).collect();
        ids.dedup();
        ids
    }

    /// Shortest call paths from `starts` to symbols for which `is_target` holds.
    /// Returns, per path, the symbols visited and the call line used to reach each.
    pub fn paths(&self, starts: &[u32], is_target: impl Fn(u32) -> bool, max_depth: usize, limit: usize) -> Vec<Vec<(u32, u32)>> {
        let mut found = Vec::new();
        let mut parent: HashMap<u32, (u32, u32)> = HashMap::new();
        let mut seen: HashSet<u32> = starts.iter().copied().collect();
        let mut queue: VecDeque<(u32, usize)> = starts.iter().map(|&id| (id, 0)).collect();

        while let Some((id, depth)) = queue.pop_front() {
            if is_target(id) {
                let mut path = vec![(id, 0)];
                let mut cursor = id;
                while let Some(&(previous, line)) = parent.get(&cursor) {
                    path.last_mut().unwrap().1 = line;
                    path.push((previous, 0));
                    cursor = previous;
                }
                path.reverse();
                // Store the call line on the hop that makes the call.
                let lines: Vec<u32> = path.iter().map(|&(_, line)| line).collect();
                let path: Vec<(u32, u32)> =
                    path.iter().enumerate().map(|(i, &(sym, _))| (sym, if i + 1 < lines.len() { lines[i + 1] } else { 0 })).collect();
                found.push(path);
                if found.len() >= limit {
                    break;
                }
            }
            if depth >= max_depth {
                continue;
            }
            for &call_id in self.calls_by_caller.get(&id).into_iter().flatten() {
                let call = &self.calls[call_id as usize];
                for target in self.call_targets(call) {
                    if seen.insert(target) {
                        parent.insert(target, (id, call.line));
                        queue.push_back((target, depth + 1));
                    }
                }
            }
        }
        found
    }

    /// Whether code at this sink runs when some route is called. Unknown callers count as unreachable.
    pub fn is_reachable(&self, sink: &SinkAt) -> bool {
        sink.caller.is_some_and(|caller| self.reachable.contains(&caller))
            || self.routes.iter().any(|route| route.file == sink.file && route.route.handlers.is_empty())
    }

    fn reachable_from_routes(&self) -> HashSet<u32> {
        let mut seen: HashSet<u32> = self.routes.iter().flat_map(|route| self.route_handlers(route)).collect();
        let mut queue: VecDeque<u32> = seen.iter().copied().collect();
        while let Some(id) = queue.pop_front() {
            for &call_id in self.calls_by_caller.get(&id).into_iter().flatten() {
                for target in self.call_targets(&self.calls[call_id as usize]) {
                    if seen.insert(target) {
                        queue.push_back(target);
                    }
                }
            }
        }
        seen
    }

    pub fn sinks_in(&self, symbol: u32) -> impl Iterator<Item = &SinkAt> {
        self.sinks.iter().filter(move |sink| sink.caller == Some(symbol))
    }

    /// Sink count per kind and input.
    pub fn sink_summary(&self) -> BTreeMap<SinkKind, BTreeMap<&'static str, usize>> {
        let mut summary: BTreeMap<SinkKind, BTreeMap<&'static str, usize>> = BTreeMap::new();
        for sink in &self.sinks {
            let input = match sink.input {
                Input::Literal => "literal",
                Input::Variable => "variable",
                Input::Built => "built",
            };
            *summary.entry(sink.kind).or_default().entry(input).or_default() += 1;
        }
        summary
    }
}

/// Resolved imports per file. Go files also see their whole package.
fn resolve_imports(store: &Store, imports: &[(u32, extract::Import)]) -> Vec<Vec<u32>> {
    let modules = Modules::new(store);
    let mut resolved: Vec<Vec<u32>> = vec![Vec::new(); store.files.len()];
    for (file, import) in imports {
        let source = &store.files[*file as usize];
        if let Some(lang) = source.lang {
            resolved[*file as usize].extend(modules.resolve(lang.family(), &source.path, &import.spec));
        }
    }
    for (id, file) in store.files.iter().enumerate() {
        if file.class == Class::Source && file.path.ends_with(".go") {
            let dir = file.path.rsplit_once('/').map_or("", |(dir, _)| dir);
            resolved[id].extend(modules::files_in_dir(store, dir, ".go"));
        }
    }
    for files in &mut resolved {
        files.sort_unstable();
        files.dedup();
    }
    resolved
}

fn last_segment(callee: &str) -> &str {
    callee.rsplit('.').next().unwrap_or(callee)
}
