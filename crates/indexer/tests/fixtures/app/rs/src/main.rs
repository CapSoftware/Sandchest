use axum::{routing::get, Router};
use std::process::Command;

pub fn app() -> Router {
    Router::new()
        .route("/items", get(list_items).post(create_item))
        .route("/run", get(|| async { "ok" }))
}

async fn list_items() -> String {
    load_items("all")
}

async fn create_item(name: String) -> String {
    let out = Command::new("sh").arg(format!("echo {}", name)).output().unwrap();
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn load_items(filter: &str) -> String {
    let query = format!("SELECT * FROM items WHERE kind = '{}'", filter);
    db_query(&query)
}

fn db_query(sql: &str) -> String {
    sqlx::query(sql).to_string()
}
