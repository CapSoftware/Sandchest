use actix_web::{get, web, HttpResponse};

/// Reads a file the caller names.
#[get("/files/{name}")]
async fn read_named(name: web::Path<String>) -> HttpResponse {
    let body = std::fs::read_to_string(format!("/srv/{}", name)).unwrap();
    HttpResponse::Ok().body(body)
}
