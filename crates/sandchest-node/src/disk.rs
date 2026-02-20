use std::path::Path;

use tracing::{info, warn};

/// Clone a base ext4 image into a per-sandbox ext4 file using reflink copy.
///
/// On XFS/btrfs this is an instant CoW clone. On other filesystems it falls
/// back to a regular copy. The cloned file is passed directly to Firecracker
/// as the drive's `path_on_host`.
pub async fn clone_disk(src_ext4: &str, sandbox_id: &str, data_dir: &str) -> Result<String, DiskError> {
    let sandbox_dir = format!("{}/sandboxes/{}", data_dir, sandbox_id);
    let dest = format!("{}/rootfs.ext4", sandbox_dir);

    // Create sandbox directory
    tokio::fs::create_dir_all(&sandbox_dir).await.map_err(|e| {
        DiskError::Io(format!("failed to create sandbox directory {}: {}", sandbox_dir, e))
    })?;

    if !Path::new(src_ext4).exists() {
        return Err(DiskError::SourceNotFound(src_ext4.to_string()));
    }

    info!(
        src = %src_ext4,
        dest = %dest,
        sandbox_id = %sandbox_id,
        "cloning disk with reflink"
    );

    let src = src_ext4.to_string();
    let dst = dest.clone();

    // Use --reflink=auto on Linux for instant CoW clones on XFS/btrfs.
    // On macOS/other platforms, fall back to regular cp.
    let output = if cfg!(target_os = "linux") {
        tokio::process::Command::new("cp")
            .arg("--reflink=auto")
            .arg(&src)
            .arg(&dst)
            .output()
            .await
            .map_err(|e| DiskError::Io(format!("failed to run cp: {}", e)))?
    } else {
        tokio::process::Command::new("cp")
            .arg(&src)
            .arg(&dst)
            .output()
            .await
            .map_err(|e| DiskError::Io(format!("failed to run cp: {}", e)))?
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(DiskError::Io(format!("cp failed: {}", stderr)));
    }

    info!(sandbox_id = %sandbox_id, dest = %dest, "disk clone complete");
    Ok(dest)
}

/// Remove a sandbox's data directory and its contents.
pub async fn cleanup_disk(sandbox_id: &str, data_dir: &str) -> Result<(), DiskError> {
    let sandbox_dir = format!("{}/sandboxes/{}", data_dir, sandbox_id);

    if !Path::new(&sandbox_dir).exists() {
        warn!(sandbox_id = %sandbox_id, "sandbox directory already absent");
        return Ok(());
    }

    tokio::fs::remove_dir_all(&sandbox_dir).await.map_err(|e| {
        DiskError::Io(format!("failed to remove {}: {}", sandbox_dir, e))
    })?;

    info!(sandbox_id = %sandbox_id, "disk cleanup complete");
    Ok(())
}

#[derive(Debug)]
pub enum DiskError {
    SourceNotFound(String),
    Io(String),
}

impl std::fmt::Display for DiskError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DiskError::SourceNotFound(path) => write!(f, "source image not found: {}", path),
            DiskError::Io(msg) => write!(f, "disk I/O error: {}", msg),
        }
    }
}

impl std::error::Error for DiskError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn clone_disk_fails_for_missing_source() {
        let result = clone_disk("/nonexistent/rootfs.ext4", "sb_test", "/tmp/sandchest-test").await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(matches!(err, DiskError::SourceNotFound(_)));
    }

    #[tokio::test]
    async fn clone_disk_creates_sandbox_dir_and_copies() {
        let tmp = std::env::temp_dir().join("sandchest-disk-test");
        let _ = std::fs::remove_dir_all(&tmp);

        // Create a small source file
        let src_dir = tmp.join("images");
        std::fs::create_dir_all(&src_dir).unwrap();
        let src_file = src_dir.join("rootfs.ext4");
        std::fs::write(&src_file, b"fake-ext4-data").unwrap();

        let data_dir = tmp.to_str().unwrap();
        let result = clone_disk(src_file.to_str().unwrap(), "sb_clone_test", data_dir).await;
        assert!(result.is_ok());

        let dest = result.unwrap();
        assert!(Path::new(&dest).exists());
        let content = std::fs::read(&dest).unwrap();
        assert_eq!(content, b"fake-ext4-data");

        // Cleanup
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn cleanup_disk_removes_directory() {
        let tmp = std::env::temp_dir().join("sandchest-cleanup-test");
        let sandbox_dir = tmp.join("sandboxes").join("sb_cleanup");
        std::fs::create_dir_all(&sandbox_dir).unwrap();
        std::fs::write(sandbox_dir.join("rootfs.ext4"), b"data").unwrap();

        let data_dir = tmp.to_str().unwrap();
        let result = cleanup_disk("sb_cleanup", data_dir).await;
        assert!(result.is_ok());
        assert!(!sandbox_dir.exists());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn cleanup_disk_is_idempotent() {
        let result = cleanup_disk("sb_nonexistent", "/tmp/sandchest-idempotent-test").await;
        assert!(result.is_ok());
    }
}
