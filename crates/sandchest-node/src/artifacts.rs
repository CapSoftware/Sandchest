use std::path::Path;

use sha2::{Digest, Sha256};
use tokio_stream::StreamExt;
use tonic::Status;
use tracing::{info, warn};

use crate::agent_client::agent_proto;
use crate::config::S3Config;
use crate::proto;

type AgentGrpcClient =
    agent_proto::guest_agent_client::GuestAgentClient<tonic::transport::Channel>;

/// Collect artifacts from a sandbox by reading files via the guest agent
/// and uploading them to S3-compatible object storage.
pub async fn collect(
    client: &mut AgentGrpcClient,
    sandbox_id: &str,
    paths: &[String],
    s3_config: Option<&S3Config>,
) -> Result<Vec<proto::CollectedArtifact>, Status> {
    let mut artifacts = Vec::with_capacity(paths.len());

    for path in paths {
        match collect_one(client, sandbox_id, path, s3_config).await {
            Ok(artifact) => artifacts.push(artifact),
            Err(e) => {
                warn!(
                    sandbox_id = %sandbox_id,
                    path = %path,
                    error = %e,
                    "failed to collect artifact, skipping"
                );
            }
        }
    }

    info!(
        sandbox_id = %sandbox_id,
        total = paths.len(),
        collected = artifacts.len(),
        "artifact collection complete"
    );

    Ok(artifacts)
}

/// Collect a single artifact: fetch file, hash, detect mime, upload to S3.
async fn collect_one(
    client: &mut AgentGrpcClient,
    sandbox_id: &str,
    path: &str,
    s3_config: Option<&S3Config>,
) -> Result<proto::CollectedArtifact, Status> {
    // 1. Fetch file contents from guest agent
    let data = fetch_file(client, path).await?;

    // 2. Compute SHA256
    let sha256 = compute_sha256(&data);

    // 3. Detect MIME type from extension
    let mime = detect_mime(path);

    // 4. Extract filename
    let name = Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());

    // 5. Upload to S3 (or generate local ref)
    let storage_ref = if let Some(config) = s3_config {
        let key = format!("{}/artifacts/{}", sandbox_id, name);
        upload_to_s3(config, &key, &data).await?;
        key
    } else {
        format!("local://{}/artifacts/{}", sandbox_id, name)
    };

    Ok(proto::CollectedArtifact {
        name,
        mime,
        bytes: data.len() as u64,
        sha256,
        r#ref: storage_ref,
    })
}

/// Read an entire file from the guest agent via streaming get_file RPC.
async fn fetch_file(client: &mut AgentGrpcClient, path: &str) -> Result<Vec<u8>, Status> {
    let request = agent_proto::GetFileRequest {
        path: path.to_string(),
    };

    let response = client.get_file(request).await.map_err(|e| {
        Status::internal(format!("agent get_file failed for {}: {}", path, e))
    })?;

    let mut stream = response.into_inner();
    let mut data = Vec::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if chunk.done && chunk.data.is_empty() {
            break;
        }
        data.extend_from_slice(&chunk.data);
        if chunk.done {
            break;
        }
    }

    Ok(data)
}

/// Upload artifact data to S3-compatible object storage.
async fn upload_to_s3(config: &S3Config, key: &str, data: &[u8]) -> Result<(), Status> {
    let s3_client = build_s3_client(config).await;

    s3_client
        .put_object()
        .bucket(&config.bucket)
        .key(key)
        .body(data.to_vec().into())
        .send()
        .await
        .map_err(|e| Status::internal(format!("S3 upload failed for {}: {}", key, e)))?;

    Ok(())
}

/// Build an AWS S3 client configured for the given S3-compatible endpoint.
async fn build_s3_client(config: &S3Config) -> aws_sdk_s3::Client {
    let creds = aws_credential_types::Credentials::new(
        &config.access_key,
        &config.secret_key,
        None,
        None,
        "sandchest-node",
    );

    let mut s3_config = aws_sdk_s3::config::Builder::new()
        .region(aws_sdk_s3::config::Region::new(config.region.clone()))
        .credentials_provider(creds)
        .force_path_style(true);

    if let Some(ref endpoint) = config.endpoint {
        s3_config = s3_config.endpoint_url(endpoint);
    }

    aws_sdk_s3::Client::from_conf(s3_config.build())
}

/// Compute the hex-encoded SHA256 hash of data.
pub fn compute_sha256(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

/// Detect MIME type from file extension, falling back to application/octet-stream.
pub fn detect_mime(path: &str) -> String {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");

    match ext {
        "txt" | "log" => "text/plain",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" => "application/javascript",
        "json" => "application/json",
        "xml" => "application/xml",
        "csv" => "text/csv",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "gz" | "gzip" => "application/gzip",
        "tar" => "application/x-tar",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "wasm" => "application/wasm",
        "md" => "text/markdown",
        "yaml" | "yml" => "application/yaml",
        "toml" => "application/toml",
        "rs" | "py" | "ts" | "tsx" | "jsx" | "go" | "rb" | "sh" | "bash" => "text/plain",
        _ => "application/octet-stream",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_empty_data() {
        let hash = compute_sha256(b"");
        assert_eq!(
            hash,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn sha256_hello_world() {
        let hash = compute_sha256(b"hello world");
        assert_eq!(
            hash,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
    }

    #[test]
    fn sha256_binary_data() {
        let hash = compute_sha256(&[0xFF, 0x00, 0xAB, 0xCD]);
        assert_eq!(hash.len(), 64);
        assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn mime_text_plain() {
        assert_eq!(detect_mime("/output/file.txt"), "text/plain");
        assert_eq!(detect_mime("app.log"), "text/plain");
    }

    #[test]
    fn mime_json() {
        assert_eq!(detect_mime("/data/result.json"), "application/json");
    }

    #[test]
    fn mime_pdf() {
        assert_eq!(detect_mime("/output/report.pdf"), "application/pdf");
    }

    #[test]
    fn mime_images() {
        assert_eq!(detect_mime("screenshot.png"), "image/png");
        assert_eq!(detect_mime("photo.jpg"), "image/jpeg");
        assert_eq!(detect_mime("photo.jpeg"), "image/jpeg");
        assert_eq!(detect_mime("icon.svg"), "image/svg+xml");
        assert_eq!(detect_mime("anim.gif"), "image/gif");
        assert_eq!(detect_mime("pic.webp"), "image/webp");
    }

    #[test]
    fn mime_archives() {
        assert_eq!(detect_mime("bundle.zip"), "application/zip");
        assert_eq!(detect_mime("backup.tar"), "application/x-tar");
        assert_eq!(detect_mime("data.gz"), "application/gzip");
    }

    #[test]
    fn mime_code_files() {
        assert_eq!(detect_mime("main.rs"), "text/plain");
        assert_eq!(detect_mime("app.py"), "text/plain");
        assert_eq!(detect_mime("index.ts"), "text/plain");
        assert_eq!(detect_mime("run.sh"), "text/plain");
    }

    #[test]
    fn mime_web_files() {
        assert_eq!(detect_mime("index.html"), "text/html");
        assert_eq!(detect_mime("page.htm"), "text/html");
        assert_eq!(detect_mime("style.css"), "text/css");
        assert_eq!(detect_mime("app.js"), "application/javascript");
        assert_eq!(detect_mime("module.mjs"), "application/javascript");
    }

    #[test]
    fn mime_config_files() {
        assert_eq!(detect_mime("config.yaml"), "application/yaml");
        assert_eq!(detect_mime("config.yml"), "application/yaml");
        assert_eq!(detect_mime("Cargo.toml"), "application/toml");
        assert_eq!(detect_mime("data.xml"), "application/xml");
        assert_eq!(detect_mime("data.csv"), "text/csv");
    }

    #[test]
    fn mime_unknown_extension() {
        assert_eq!(detect_mime("file.xyz"), "application/octet-stream");
        assert_eq!(detect_mime("binary"), "application/octet-stream");
    }

    #[test]
    fn mime_no_extension() {
        assert_eq!(detect_mime("/usr/bin/myapp"), "application/octet-stream");
    }

    #[test]
    fn mime_markdown() {
        assert_eq!(detect_mime("README.md"), "text/markdown");
    }

    #[test]
    fn mime_wasm() {
        assert_eq!(detect_mime("module.wasm"), "application/wasm");
    }

    #[test]
    fn mime_video() {
        assert_eq!(detect_mime("clip.mp4"), "video/mp4");
        assert_eq!(detect_mime("stream.webm"), "video/webm");
    }
}
