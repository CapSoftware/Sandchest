//! End-to-end checks of the tools against a small multi-language fixture.

use std::path::Path;
use std::sync::OnceLock;

use sandchest_indexer::files::Store;
use sandchest_indexer::index::Index;
use sandchest_indexer::tools::{self, State};
use serde_json::{Value, json};

fn state() -> &'static State {
    static STATE: OnceLock<State> = OnceLock::new();
    STATE.get_or_init(|| {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/app");
        let state = State { store: Store::load(&root), index: OnceLock::new() };
        let _ = state.index.set(Index::build(&state.store));
        state
    })
}

fn call(tool: &str, args: Value) -> Value {
    tools::call(state(), tool, args).unwrap_or_else(|error| panic!("{tool} failed: {error}"))
}

fn strings(value: &Value, key: &str) -> Vec<String> {
    value.as_array().unwrap().iter().map(|item| item[key].as_str().unwrap().to_owned()).collect()
}

#[test]
fn finds_routes_across_frameworks() {
    let routes = call("routes", json!({}));
    let found: Vec<String> = routes["routes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| format!("{} {}", r["method"].as_str().unwrap(), r["path"].as_str().unwrap()))
        .collect();
    for expected in ["POST /login", "GET /files/:name", "POST /ping", "POST /items", "GET /api/users/{id}", "ANY /php/view.php"] {
        assert!(found.contains(&expected.to_owned()), "missing {expected} in {found:?}");
    }
}

#[test]
fn resolves_route_handlers_through_imports() {
    let routes = call("routes", json!({ "filter": "/login" }));
    let handlers = routes["routes"][0]["handlers"].as_array().unwrap();
    assert_eq!(handlers[0], "login @ routes/login.js:3");
}

#[test]
fn flags_built_sinks_and_skips_safe_ones() {
    let sinks = call("sinks", json!({ "minInput": "built" }));
    let at = strings(&sinks["sinks"], "at");
    for expected in
        ["routes/login.js:11", "py/views.py:11", "go/main.go:11", "java/com/acme/UserController.java:10", "php/view.php:3", "server.js:8"]
    {
        assert!(at.contains(&expected.to_owned()), "missing sink {expected} in {at:?}");
    }
    let all = strings(&call("sinks", json!({ "limit": 500 }))["sinks"], "at");
    assert!(!all.iter().any(|at| at.starts_with("py/views.py:16")), "SafeLoader is not a sink");
    assert!(!all.iter().any(|at| at.starts_with("test/")), "tests are not attack surface");
}

#[test]
fn traces_from_route_to_sink() {
    let trace = call("trace", json!({ "from": "POST /login", "to": "sql" }));
    let path = &trace["paths"][0];
    let hops = strings(&path["hops"], "symbol");
    assert_eq!(hops, ["login", "findUser"]);
    assert_eq!(path["sinks"][0]["at"], "routes/login.js:11");
}

#[test]
fn reports_secrets_and_injection_markers() {
    let leads = call("leads", json!({}));
    assert_eq!(strings(&leads["secrets"], "at"), ["config.js:2"]);
    assert_eq!(strings(&leads["injectionMarkers"], "at"), ["server.js:10"]);
}

#[test]
fn marks_dependency_reachability() {
    let deps = call("deps", json!({}));
    let by_name = |name: &str| deps["dependencies"].as_array().unwrap().iter().find(|d| d["name"] == name).cloned().unwrap();
    assert_eq!(by_name("pg")["reachability"], "imported");
    assert_eq!(by_name("pg")["version"], "8.7.0");
    assert_eq!(by_name("lodash")["reachability"], "not_imported");
}

#[test]
fn reads_files_and_refuses_escapes() {
    let read = call("read_file", json!({ "path": "routes/login.js", "startLine": 10, "endLine": 12 }));
    assert_eq!(
        read["content"],
        "async function findUser (email) {\n  return db.query(\"SELECT * FROM users WHERE email = '\" + email + \"'\")\n}\n"
    );
    assert!(tools::call(state(), "read_file", json!({ "path": "../../Cargo.toml" })).is_err());
    assert!(tools::call(state(), "read_file", json!({ "path": "routes/login.js", "bogus": 1 })).is_err());
}

#[test]
fn locates_citations() {
    let located =
        call("locate", json!({ "locations": [{ "file": "routes/login.js", "line": 11 }, { "file": "routes/login.js", "line": 99 }] }));
    assert_eq!(located["locations"][0]["symbol"], "findUser");
    assert_eq!(located["locations"][1]["exists"], false);
}

#[test]
fn searches_with_globs() {
    let found = call("search", json!({ "pattern": "SELECT", "glob": "*.py" }));
    assert_eq!(found["matches"].as_array().unwrap().len(), 0);
    let found = call("search", json!({ "pattern": "select \\*", "ignoreCase": true }));
    assert_eq!(found["filesWithMatches"], 3);
}
