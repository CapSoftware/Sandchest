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

/// Clone a base ext4 image to a specific destination directory.
///
/// Like `clone_disk` but allows specifying the target directory directly.
/// The destination directory must already exist.
pub async fn clone_disk_to(src_ext4: &str, dest_dir: &str) -> Result<String, DiskError> {
    let dest = format!("{}/rootfs.ext4", dest_dir);

    if !Path::new(src_ext4).exists() {
        return Err(DiskError::SourceNotFound(src_ext4.to_string()));
    }

    info!(
        src = %src_ext4,
        dest = %dest,
        "cloning disk with reflink to target directory"
    );

    let src = src_ext4.to_string();
    let dst = dest.clone();

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

    info!(dest = %dest, "disk clone complete");
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

    #[test]
    fn disk_error_source_not_found_display() {
        let err = DiskError::SourceNotFound("/missing/rootfs.ext4".to_string());
        assert_eq!(
            err.to_string(),
            "source image not found: /missing/rootfs.ext4"
        );
    }

    #[test]
    fn disk_error_io_display() {
        let err = DiskError::Io("permission denied".to_string());
        assert_eq!(err.to_string(), "disk I/O error: permission denied");
    }

    #[test]
    fn disk_error_is_std_error() {
        let err = DiskError::SourceNotFound("test".to_string());
        let _: &dyn std::error::Error = &err;
    }

    #[test]
    fn disk_error_debug_format() {
        let err = DiskError::Io("test".to_string());
        let debug = format!("{:?}", err);
        assert!(debug.contains("Io"));
    }

    #[tokio::test]
    async fn clone_disk_output_path_format() {
        let tmp = std::env::temp_dir().join("sandchest-disk-path-test");
        let _ = std::fs::remove_dir_all(&tmp);

        let src_dir = tmp.join("images");
        std::fs::create_dir_all(&src_dir).unwrap();
        let src_file = src_dir.join("base.ext4");
        std::fs::write(&src_file, b"data").unwrap();

        let data_dir = tmp.to_str().unwrap();
        let dest = clone_disk(src_file.to_str().unwrap(), "sb_pathtest", data_dir)
            .await
            .unwrap();

        // Verify the output path matches expected format
        assert!(dest.ends_with("/sandboxes/sb_pathtest/rootfs.ext4"));
        assert!(dest.starts_with(data_dir));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn clone_disk_to_copies_to_target_dir() {
        let tmp = std::env::temp_dir().join("sandchest-disk-to-test");
        let _ = std::fs::remove_dir_all(&tmp);

        let src_dir = tmp.join("images");
        std::fs::create_dir_all(&src_dir).unwrap();
        let src_file = src_dir.join("rootfs.ext4");
        std::fs::write(&src_file, b"fake-ext4-to").unwrap();

        let dest_dir = tmp.join("target");
        std::fs::create_dir_all(&dest_dir).unwrap();

        let result = clone_disk_to(src_file.to_str().unwrap(), dest_dir.to_str().unwrap()).await;
        assert!(result.is_ok());

        let dest = result.unwrap();
        assert!(dest.ends_with("/rootfs.ext4"));
        assert!(Path::new(&dest).exists());
        assert_eq!(std::fs::read(&dest).unwrap(), b"fake-ext4-to");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn clone_disk_to_fails_for_missing_source() {
        let tmp = std::env::temp_dir().join("sandchest-disk-to-missing");
        std::fs::create_dir_all(&tmp).unwrap();

        let result = clone_disk_to("/nonexistent/rootfs.ext4", tmp.to_str().unwrap()).await;
        assert!(matches!(result.unwrap_err(), DiskError::SourceNotFound(_)));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn cleanup_disk_removes_nested_files() {
        let tmp = std::env::temp_dir().join("sandchest-nested-cleanup");
        let sandbox_dir = tmp.join("sandboxes").join("sb_nested");
        let nested = sandbox_dir.join("subdir");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("file.txt"), b"nested").unwrap();
        std::fs::write(sandbox_dir.join("rootfs.ext4"), b"root").unwrap();

        let result = cleanup_disk("sb_nested", tmp.to_str().unwrap()).await;
        assert!(result.is_ok());
        assert!(!sandbox_dir.exists());

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
