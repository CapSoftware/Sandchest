//! The file store holds a bounded amount of a checkout in memory, however
//! large the repository is.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use sandchest_indexer::files::{MAX_TOTAL_BYTES, Store};
use serde_json::Value;

/// A fresh directory under the system temp dir, removed on drop.
struct Tree(PathBuf);

impl Tree {
    fn new(name: &str) -> Tree {
        let dir = std::env::temp_dir().join(format!("sandchest-index-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Tree(dir)
    }

    fn write(&self, path: &str, contents: &[u8]) {
        let full = self.0.join(path);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, contents).unwrap();
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn retained(store: &Store) -> usize {
    store.files.iter().map(|file| file.text.len() + file.line_starts.len() * 4).sum()
}

#[test]
fn a_repository_over_the_byte_budget_loads_only_up_to_it() {
    let tree = Tree::new("over-bytes");
    for i in 0..500 {
        tree.write(&format!("src/small{i}.ts"), format!("export const n{i} = {i};\n").as_bytes());
    }
    // Just under the per-file cap each, and well past the total budget together.
    let big = "a".repeat(1_900_000);
    for i in 0..150 {
        tree.write(&format!("data/big{i}.json"), big.as_bytes());
    }
    tree.write("huge.txt", &vec![b'x'; 3 * 1024 * 1024]);

    let store = Store::load(tree.path());
    assert!(retained(&store) as u64 <= MAX_TOTAL_BYTES, "retained {} bytes", retained(&store));
    assert_eq!(store.files.len() + store.skipped.len(), 651, "every file is either loaded or listed as skipped");
    let over: Vec<&str> = store.skipped.iter().filter(|s| s.reason == "over_budget").map(|s| s.path.as_str()).collect();
    assert!(!over.is_empty(), "files past the budget are listed as skipped");
    assert!(over.iter().all(|path| path.starts_with("data/") || path.starts_with("src/")), "{over:?}");
    let huge = store.skipped.iter().find(|s| s.path == "huge.txt").expect("huge.txt is skipped");
    assert_eq!(huge.reason, "too_large");
}

#[test]
fn a_normal_repository_loads_every_file() {
    let tree = Tree::new("normal");
    for i in 0..200 {
        tree.write(&format!("src/mod{i}.py"), format!("def f{i}():\n    return {i}\n").as_bytes());
    }
    tree.write("logo.png", b"\x89PNG\r\n\x1a\n\0\0\0");
    tree.write("node_modules/dep/index.js", b"module.exports = 1;\n");

    let store = Store::load(tree.path());
    assert_eq!(store.files.len(), 200);
    assert!(store.get("src/mod0.py").is_some());
    let reasons: Vec<(&str, &str)> = store.skipped.iter().map(|s| (s.path.as_str(), s.reason)).collect();
    assert_eq!(reasons, [("logo.png", "binary")]);
}

/// Starts `sandchest-index serve` with `flags`, returning the child and its port.
fn serve(root: &Path, flags: &[&str]) -> (std::process::Child, u16) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_sandchest-index"))
        .arg("serve")
        .arg(root)
        .args(["--port", "0"])
        .args(flags)
        .env("SANDCHEST_INDEX_TOKEN", "test-token")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.as_mut().unwrap()).read_line(&mut line).unwrap();
    let Ok(ready) = serde_json::from_str::<Value>(&line) else {
        let _ = child.kill();
        let mut stderr = String::new();
        let _ = child.stderr.take().unwrap().read_to_string(&mut stderr);
        panic!("indexer did not start: {stderr}");
    };
    (child, ready["port"].as_u64().unwrap() as u16)
}

fn request(port: u16, method: &str, tool: &str) -> Value {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(
        stream,
        "{method} /{tool} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer test-token\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    let (_, body) = response.split_once("\r\n\r\n").unwrap();
    serde_json::from_str(body).unwrap()
}

#[test]
fn serve_caps_files_and_bytes_from_the_command_line() {
    let tree = Tree::new("serve-caps");
    for i in 0..50 {
        tree.write(&format!("src/file{i}.js"), format!("exports.v{i} = {i};\n").as_bytes());
    }

    let (mut child, port) = serve(tree.path(), &["--max-files", "10", "--max-bytes", "1000000"]);
    let health = request(port, "GET", "health");
    let overview = request(port, "POST", "overview");
    let _ = child.kill();
    let _ = child.wait();

    assert_eq!(health["files"], 10, "{health}");
    assert_eq!(overview["files"], 10, "{overview}");
    assert_eq!(overview["skippedFiles"], 40, "{overview}");

    let (mut child, port) = serve(tree.path(), &["--max-bytes", "200"]);
    let health = request(port, "GET", "health");
    let _ = child.kill();
    let _ = child.wait();
    let files = health["files"].as_u64().unwrap();
    assert!(files > 0 && files < 50, "{health}");
}
