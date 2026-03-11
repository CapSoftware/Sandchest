use std::path::Path;

use tracing::{info, warn};

use crate::artifacts::build_s3_client;
use crate::config::S3Config;
use crate::proto;

/// R2 key prefix for rootfs images.
const IMAGE_PREFIX: &str = "images/";

/// R2 key for the image manifest file.
const MANIFEST_KEY: &str = "images/manifest.json";

/// A manifest entry listing an available image in R2.
#[derive(Debug, serde::Deserialize)]
struct ManifestEntry {
    os_version: String,
    toolchain: String,
}

#[derive(Debug, serde::Deserialize)]
struct Manifest {
    images: Vec<ManifestEntry>,
}

/// Provision images by downloading missing rootfs ext4 files from R2.
///
/// If `image_refs` is empty, discovers available images from the R2 manifest.
/// Returns a status entry for each image.
pub async fn provision_images(
    s3_config: &S3Config,
    images_dir: &str,
    image_refs: &[String],
) -> Vec<proto::ProvisionedImage> {
    let refs = if image_refs.is_empty() {
        match discover_images(s3_config).await {
            Ok(refs) => refs,
            Err(e) => {
                warn!(error = %e, "failed to discover images from R2 manifest");
                return vec![proto::ProvisionedImage {
                    image_ref: "manifest".to_string(),
                    status: "failed".to_string(),
                    error: format!("failed to read manifest: {}", e),
                }];
            }
        }
    } else {
        image_refs.to_vec()
    };

    let s3_client = build_s3_client(s3_config).await;
    let mut results = Vec::with_capacity(refs.len());

    for image_ref in &refs {
        let local_path = format!("{}/{}/rootfs.ext4", images_dir, image_ref);

        if Path::new(&local_path).exists() {
            info!(image_ref = %image_ref, "image already exists locally");
            results.push(proto::ProvisionedImage {
                image_ref: image_ref.clone(),
                status: "already_exists".to_string(),
                error: String::new(),
            });
            continue;
        }

        let r2_key = format!("{}{}/rootfs.ext4", IMAGE_PREFIX, image_ref);
        match download_image(&s3_client, &s3_config.bucket, &r2_key, &local_path).await {
            Ok(()) => {
                info!(image_ref = %image_ref, path = %local_path, "image downloaded");
                results.push(proto::ProvisionedImage {
                    image_ref: image_ref.clone(),
                    status: "downloaded".to_string(),
                    error: String::new(),
                });
            }
            Err(e) => {
                warn!(image_ref = %image_ref, error = %e, "failed to download image");
                results.push(proto::ProvisionedImage {
                    image_ref: image_ref.clone(),
                    status: "failed".to_string(),
                    error: e.to_string(),
                });
            }
        }
    }

    results
}

/// Discover available images by reading the R2 manifest file.
async fn discover_images(s3_config: &S3Config) -> Result<Vec<String>, String> {
    let s3_client = build_s3_client(s3_config).await;

    let response = s3_client
        .get_object()
        .bucket(&s3_config.bucket)
        .key(MANIFEST_KEY)
        .send()
        .await
        .map_err(|e| format!("failed to get {}: {}", MANIFEST_KEY, e))?;

    let body = response
        .body
        .collect()
        .await
        .map_err(|e| format!("failed to read manifest body: {}", e))?;

    let manifest: Manifest = serde_json::from_slice(&body.into_bytes())
        .map_err(|e| format!("failed to parse manifest JSON: {}", e))?;

    let refs: Vec<String> = manifest
        .images
        .into_iter()
        .map(|entry| format!("{}/{}", entry.os_version, entry.toolchain))
        .collect();

    info!(count = refs.len(), "discovered images from manifest");
    Ok(refs)
}

/// Download a single image from R2 to a local path.
async fn download_image(
    s3_client: &aws_sdk_s3::Client,
    bucket: &str,
    key: &str,
    dest_path: &str,
) -> Result<(), String> {
    // Create parent directories
    if let Some(parent) = Path::new(dest_path).parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("failed to create directory {}: {}", parent.display(), e))?;
    }

    let response = s3_client
        .get_object()
        .bucket(bucket)
        .key(key)
        .send()
        .await
        .map_err(|e| format!("S3 get_object failed for {}: {}", key, e))?;

    let body = response
        .body
        .collect()
        .await
        .map_err(|e| format!("failed to read S3 body for {}: {}", key, e))?;

    let bytes = body.into_bytes();
    info!(key = %key, size_mb = bytes.len() / (1024 * 1024), "writing image to disk");

    tokio::fs::write(dest_path, &bytes)
        .await
        .map_err(|e| format!("failed to write {}: {}", dest_path, e))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_deserialization() {
        let json = r#"{
            "images": [
                {"os_version": "ubuntu-22.04", "toolchain": "base"},
                {"os_version": "ubuntu-22.04", "toolchain": "node-22"}
            ]
        }"#;

        let manifest: Manifest = serde_json::from_str(json).unwrap();
        assert_eq!(manifest.images.len(), 2);
        assert_eq!(manifest.images[0].os_version, "ubuntu-22.04");
        assert_eq!(manifest.images[0].toolchain, "base");
        assert_eq!(manifest.images[1].toolchain, "node-22");
    }

    #[test]
    fn manifest_to_refs() {
        let manifest = Manifest {
            images: vec![
                ManifestEntry {
                    os_version: "ubuntu-22.04".to_string(),
                    toolchain: "base".to_string(),
                },
                ManifestEntry {
                    os_version: "ubuntu-22.04".to_string(),
                    toolchain: "python-3.12".to_string(),
                },
            ],
        };

        let refs: Vec<String> = manifest
            .images
            .into_iter()
            .map(|e| format!("{}/{}", e.os_version, e.toolchain))
            .collect();

        assert_eq!(refs, vec!["ubuntu-22.04/base", "ubuntu-22.04/python-3.12"]);
    }
}
