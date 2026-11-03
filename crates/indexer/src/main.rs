//! `sandchest-index`: indexes a checkout and serves the scan agents' tools.
//!
//!   sandchest-index serve <root> [--host 127.0.0.1] [--port 0] [--exit-on-stdin-close]
//!                         [--max-bytes N] [--max-files N]
//!   sandchest-index query <root> <tool> [json-args]
//!
//! `serve` prints `{"port":N}` on stdout once it is listening. Set
//! `SANDCHEST_INDEX_TOKEN` to require `Authorization: Bearer <token>`.
//! `--max-bytes` and `--max-files` bound how much of the checkout is held in
//! memory; files past them are listed as skipped.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use sandchest_indexer::files::{Limits, Store};
use sandchest_indexer::server;
use sandchest_indexer::tools::{self, State};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("serve") => serve(&args[1..]),
        Some("query") => query(&args[1..]),
        _ => Err(USAGE.to_owned()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

const USAGE: &str = "usage:\n  sandchest-index serve <root> [--host 127.0.0.1] [--port 0] [--exit-on-stdin-close] [--max-bytes N] [--max-files N]\n  sandchest-index query <root> <tool> [json-args]";

fn root_of(arg: Option<&String>) -> Result<PathBuf, String> {
    let root = arg.ok_or(USAGE)?;
    std::fs::canonicalize(root).map_err(|error| format!("cannot open {root}: {error}"))
}

fn serve(args: &[String]) -> Result<(), String> {
    let root = root_of(args.first())?;
    let mut host = "127.0.0.1".to_owned();
    let mut port = 0u16;
    let mut exit_on_stdin_close = false;
    let mut limits = Limits::default();
    let mut rest = args[1..].iter();
    while let Some(flag) = rest.next() {
        match flag.as_str() {
            "--host" => host = rest.next().ok_or("--host needs a value")?.clone(),
            "--port" => port = rest.next().and_then(|p| p.parse().ok()).ok_or("--port needs a number")?,
            "--exit-on-stdin-close" => exit_on_stdin_close = true,
            "--max-bytes" => limits.max_bytes = rest.next().and_then(|n| n.parse().ok()).ok_or("--max-bytes needs a number")?,
            "--max-files" => limits.max_files = rest.next().and_then(|n| n.parse().ok()).ok_or("--max-files needs a number")?,
            other => return Err(format!("unknown flag {other}\n{USAGE}")),
        }
    }

    // Load files before listening (fast), then index in the background while
    // file tools already answer.
    let state = Arc::new(State::new(Store::load_within(&root, limits)));
    let server = tiny_http::Server::http((host.as_str(), port)).map_err(|error| format!("cannot listen on {host}:{port}: {error}"))?;
    let port = server.server_addr().to_ip().map(|addr| addr.port()).unwrap_or(port);

    let indexing = Arc::clone(&state);
    std::thread::spawn(move || {
        indexing.build_index();
    });

    if exit_on_stdin_close {
        std::thread::spawn(|| {
            let _ = std::io::stdin().read_to_end(&mut Vec::new());
            std::process::exit(0);
        });
    }

    let mut stdout = std::io::stdout();
    writeln!(stdout, "{{\"port\":{port}}}").and_then(|()| stdout.flush()).map_err(|error| error.to_string())?;
    server::serve(server, state, std::env::var("SANDCHEST_INDEX_TOKEN").ok().filter(|t| !t.is_empty()));
    Ok(())
}

fn query(args: &[String]) -> Result<(), String> {
    let root = root_of(args.first())?;
    let tool = args.get(1).ok_or(USAGE)?;
    let input = match args.get(2) {
        Some(json) => serde_json::from_str(json).map_err(|error| format!("invalid JSON arguments: {error}"))?,
        None => serde_json::Value::Null,
    };
    let state = State::new(Store::load(&root));
    state.build_index();
    let output = tools::call(&state, tool, input)?;
    println!("{}", serde_json::to_string_pretty(&output).unwrap());
    Ok(())
}
