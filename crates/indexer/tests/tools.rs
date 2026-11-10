//! End-to-end checks of the tools against a small multi-language fixture.

use std::path::Path;
use std::sync::OnceLock;

use sandchest_indexer::files::Store;
use sandchest_indexer::tools::{self, State};
use serde_json::{Value, json};

fn state() -> &'static State {
    static STATE: OnceLock<State> = OnceLock::new();
    STATE.get_or_init(|| {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/app");
        let state = State::new(Store::load(&root));
        state.build_index();
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
fn definitions_enumerates_and_roots_are_a_subset_without_tests() {
    let all = call("definitions", json!({ "limit": 20_000 }));
    let all_files = strings(&all["definitions"], "file");
    assert!(!all_files.is_empty(), "expected some definitions");
    assert!(!all_files.iter().any(|f| f.starts_with("test/")), "tests are not product definitions: {all_files:?}");
    // every entry is a function or method, never a class
    let kinds = strings(&all["definitions"], "kind");
    assert!(kinds.iter().all(|k| k == "function" || k == "method"), "unexpected kinds: {kinds:?}");

    let roots = call("definitions", json!({ "roots": true, "limit": 20_000 }));
    let root_total = roots["total"].as_u64().unwrap();
    let all_total = all["total"].as_u64().unwrap();
    assert!(root_total <= all_total, "roots ({root_total}) must be a subset of all ({all_total})");
    assert!(root_total > 0, "expected at least one call-graph root");
    // route handlers the framework invokes (not called in-code) are roots
    let root_names = strings(&roots["definitions"], "name");
    for handler in ["ping", "items"] {
        assert!(root_names.iter().any(|n| n == handler), "expected route handler {handler} among roots: {root_names:?}");
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
    // The JS, Go and Java fixtures, plus the Rust one's built query.
    assert_eq!(found["filesWithMatches"], 4);
}

fn routes_of(framework: &str) -> Vec<(String, String, String)> {
    call("routes", json!({ "limit": 1000 }))["routes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["framework"] == framework)
        .map(|r| {
            let handlers = r["handlers"]
                .as_array()
                .unwrap()
                .iter()
                .map(|h| h.as_str().unwrap().split(" @ ").next().unwrap().to_owned())
                .collect::<Vec<_>>();
            (r["method"].as_str().unwrap().to_owned(), r["path"].as_str().unwrap().to_owned(), handlers.join(","))
        })
        .collect()
}

#[test]
fn rust_routes_from_axum_and_actix() {
    let axum = routes_of("axum");
    assert!(
        axum.iter().any(|(m, p, h)| m == "GET,POST" && p == "/items" && h.contains("list_items") && h.contains("create_item")),
        "{axum:?}"
    );
    assert!(
        axum.iter().any(|(m, p, h)| m == "GET" && p == "/run" && h == "GET /run"),
        "closure handlers are named after their route: {axum:?}"
    );
    let actix = routes_of("actix");
    assert!(actix.iter().any(|(m, p, h)| m == "GET" && p == "/files/{name}" && h == "read_named"), "{actix:?}");
}

#[test]
fn ruby_routes_from_rails_controllers_and_sinatra() {
    let rails = routes_of("rails");
    let paths: Vec<&str> = rails.iter().map(|(_, p, _)| p.as_str()).collect();
    for expected in ["/users#index", "/users#show", "/users#export", "/admin/reports#destroy"] {
        assert!(paths.contains(&expected), "missing {expected} in {paths:?}");
    }
    assert!(!paths.iter().any(|p| p.ends_with("#user_params")), "private helpers are not actions: {paths:?}");
    assert!(rails.iter().any(|(m, p, _)| m == "DELETE" && p == "/admin/reports#destroy"));
    let sinatra = routes_of("sinatra");
    assert!(sinatra.iter().any(|(m, p, _)| m == "GET" && p == "/hello/:name"), "{sinatra:?}");
}

#[test]
fn rust_and_ruby_sinks_are_found_and_reachable() {
    let sinks = call("sinks", json!({ "limit": 500 }));
    let found: Vec<String> = sinks["sinks"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["reachable"] == true)
        .map(|s| format!("{} {} {}", s["kind"].as_str().unwrap(), s["input"].as_str().unwrap(), s["at"].as_str().unwrap()))
        .collect();
    for expected in [
        "sql built rails/app/controllers/users_controller.rb:5",
        "command built rails/app/controllers/users_controller.rb:13",
        "redirect variable rails/app/controllers/admin/reports_controller.rb:4",
        "command built rs/src/main.rs:15",
        "path built rs/src/actix.rs:6",
        "sql variable rs/src/main.rs:25",
        // Reached across files through `require_relative`.
        "command built sinatra/helpers.rb:2",
    ] {
        assert!(found.contains(&expected.to_owned()), "missing reachable sink {expected} in {found:?}");
    }
}

#[test]
fn traces_a_rust_route_through_helpers_to_its_sink() {
    let trace = call("trace", json!({ "from": "GET /items", "to": "sql" }));
    let paths: Vec<String> = trace["paths"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["hops"].as_array().unwrap().iter().map(|h| h["symbol"].as_str().unwrap().to_owned()).collect::<Vec<_>>().join(" > "))
        .collect();
    assert!(paths.iter().any(|p| p.starts_with("list_items > load_items > db_query")), "{paths:?}");
}

#[test]
fn counts_rust_and_ruby_as_languages() {
    let overview = call("overview", json!({}));
    let languages: Vec<&str> = overview["languages"].as_array().unwrap().iter().map(|l| l["language"].as_str().unwrap()).collect();
    assert!(languages.contains(&"rust") && languages.contains(&"ruby"), "{languages:?}");
}

#[test]
fn next_routes_exported_as_values_and_middleware() {
    let mut next = routes_of("nextjs");
    next.sort();
    assert_eq!(
        next,
        [
            ("ANY", "/* (middleware)", "proxy"),
            ("GET", "/api/auth/[...nextauth]", "handler"),
            ("GET", "/api/items", "GET"),
            ("GET", "/api/v1/[...route]", "handler"),
            ("POST", "/api/auth/[...nextauth]", "handler"),
            ("POST", "/api/v1/[...route]", "handler"),
        ]
        .map(|(m, p, h)| (m.to_owned(), p.to_owned(), h.to_owned()))
    );
}
