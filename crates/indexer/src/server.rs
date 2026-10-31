//! The tool daemon: `POST /<tool>` with a JSON body, JSON back. One worker
//! thread per core; index-backed tools block until the index is ready.

use std::io::Read;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
use std::time::Instant;

use serde_json::{Value, json};
use tiny_http::{Header, Method, Request, Response, Server};

use crate::tools::{self, State};

const MAX_BODY_BYTES: u64 = 1024 * 1024;

pub fn serve(server: Server, state: Arc<State>, token: Option<String>) {
    let server = Arc::new(server);
    let workers = std::thread::available_parallelism().map_or(4, |n| n.get()).max(2);
    let token = token.map(|token| format!("Bearer {token}"));

    let handles: Vec<_> = (0..workers)
        .map(|_| {
            let server = Arc::clone(&server);
            let state = Arc::clone(&state);
            let token = token.clone();
            std::thread::spawn(move || {
                for request in server.incoming_requests() {
                    handle(request, &state, token.as_deref());
                }
            })
        })
        .collect();
    for handle in handles {
        let _ = handle.join();
    }
}

fn handle(mut request: Request, state: &State, token: Option<&str>) {
    if let Some(expected) = token {
        let given = request.headers().iter().find(|h| h.field.equiv("authorization")).map(|h| h.value.as_str()).unwrap_or("");
        if !constant_time_eq(given.as_bytes(), expected.as_bytes()) {
            return respond(request, 401, json!({ "error": "unauthorized" }));
        }
    }

    let tool = request.url().trim_start_matches('/').split('?').next().unwrap_or("").to_owned();
    if tool == "health" {
        let status = match state.index_status() {
            None => json!("indexing"),
            Some(Ok(())) => json!("ready"),
            Some(Err(error)) => json!({ "failed": error }),
        };
        return respond(request, 200, json!({ "status": status, "files": state.store.files.len() }));
    }
    if *request.method() != Method::Post {
        return respond(request, 405, json!({ "error": "use POST /<tool>" }));
    }

    let mut body = String::new();
    if request.as_reader().take(MAX_BODY_BYTES + 1).read_to_string(&mut body).is_err() || body.len() as u64 > MAX_BODY_BYTES {
        return respond(request, 400, json!({ "error": "body must be UTF-8 JSON under 1 MB" }));
    }
    let args: Value = if body.trim().is_empty() {
        Value::Null
    } else {
        match serde_json::from_str(&body) {
            Ok(args) => args,
            Err(error) => return respond(request, 400, json!({ "error": format!("invalid JSON: {error}") })),
        }
    };

    let started = Instant::now();
    // A bug in one tool must not take down the daemon: report it and keep serving.
    let outcome = catch_unwind(AssertUnwindSafe(|| tools::call(state, &tool, args)));
    let Ok(outcome) = outcome else {
        return respond(request, 500, json!({ "error": format!("internal error in {tool}") }));
    };
    match outcome {
        Ok(mut result) => {
            if let Value::Object(map) = &mut result {
                map.insert("ms".to_owned(), json!(started.elapsed().as_secs_f64() * 1000.0));
            }
            respond(request, 200, result)
        }
        Err(error) => respond(request, if tools::NAMES.contains(&tool.as_str()) { 400 } else { 404 }, json!({ "error": error })),
    }
}

fn respond(request: Request, status: u16, body: Value) {
    let header = Header::from_bytes("content-type", "application/json").unwrap();
    let response = Response::from_string(body.to_string()).with_status_code(status).with_header(header);
    // The client may have gone away; nothing to do about it.
    let _ = request.respond(response);
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
