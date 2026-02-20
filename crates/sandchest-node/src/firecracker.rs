use std::path::Path;
use std::process::Stdio;

use tokio::process::{Child, Command};
use tracing::{error, info, warn};

use crate::config::VmConfig;

/// Handle to a running Firecracker VM process.
pub struct FirecrackerVm {
    pub sandbox_id: String,
    pub api_socket_path: String,
    pub vsock_path: String,
    pub data_dir: String,
    child: Child,
}

impl FirecrackerVm {
    /// Start a new Firecracker VM with the given configuration.
    ///
    /// 1. Creates the sandbox data directory
    /// 2. Writes the Firecracker config JSON
    /// 3. Spawns the Firecracker process
    pub async fn create(
        vm_config: &VmConfig,
        base_data_dir: &str,
    ) -> Result<Self, FirecrackerError> {
        let sandbox_dir = format!("{}/sandboxes/{}", base_data_dir, vm_config.sandbox_id);
        let config_path = format!("{}/config.json", sandbox_dir);
        let api_socket_path = format!("{}/api.sock", sandbox_dir);

        // Create sandbox directory
        tokio::fs::create_dir_all(&sandbox_dir).await.map_err(|e| {
            FirecrackerError::Setup(format!(
                "failed to create sandbox directory {}: {}",
                sandbox_dir, e
            ))
        })?;

        // Write Firecracker config
        let config_json = vm_config
            .to_json()
            .map_err(|e| FirecrackerError::Setup(format!("failed to serialize config: {}", e)))?;
        tokio::fs::write(&config_path, &config_json)
            .await
            .map_err(|e| {
                FirecrackerError::Setup(format!("failed to write config to {}: {}", config_path, e))
            })?;

        info!(
            sandbox_id = %vm_config.sandbox_id,
            config_path = %config_path,
            "starting Firecracker process"
        );

        // Start Firecracker process
        let child = Command::new("firecracker")
            .arg("--api-sock")
            .arg(&api_socket_path)
            .arg("--config-file")
            .arg(&config_path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| {
                FirecrackerError::Spawn(format!("failed to spawn firecracker: {}", e))
            })?;

        info!(
            sandbox_id = %vm_config.sandbox_id,
            pid = ?child.id(),
            "Firecracker process started"
        );

        Ok(Self {
            sandbox_id: vm_config.sandbox_id.clone(),
            api_socket_path,
            vsock_path: vm_config.vsock_uds_path.clone(),
            data_dir: sandbox_dir,
            child,
        })
    }

    /// Destroy the Firecracker VM: kill the process and clean up resources.
    pub async fn destroy(mut self) -> Result<(), FirecrackerError> {
        info!(sandbox_id = %self.sandbox_id, "destroying Firecracker VM");

        // Send SIGTERM first for graceful shutdown
        #[cfg(unix)]
        if let Some(pid) = self.child.id() {
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }

            // Wait up to 5 seconds for graceful exit
            let graceful = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                self.child.wait(),
            )
            .await;

            if graceful.is_err() {
                warn!(sandbox_id = %self.sandbox_id, "Firecracker did not exit gracefully, sending SIGKILL");
                let _ = self.child.kill().await;
            }
        }

        #[cfg(not(unix))]
        {
            let _ = self.child.kill().await;
        }

        // Clean up sandbox data directory
        if Path::new(&self.data_dir).exists() {
            if let Err(e) = tokio::fs::remove_dir_all(&self.data_dir).await {
                error!(
                    sandbox_id = %self.sandbox_id,
                    dir = %self.data_dir,
                    error = %e,
                    "failed to clean up sandbox directory"
                );
            }
        }

        // Clean up vsock socket if it exists outside the data dir
        if Path::new(&self.vsock_path).exists() {
            let _ = tokio::fs::remove_file(&self.vsock_path).await;
        }

        info!(sandbox_id = %self.sandbox_id, "Firecracker VM destroyed");
        Ok(())
    }

    /// Check if the Firecracker process is still running.
    pub fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

#[derive(Debug)]
pub enum FirecrackerError {
    Setup(String),
    Spawn(String),
}

impl std::fmt::Display for FirecrackerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FirecrackerError::Setup(msg) => write!(f, "setup error: {}", msg),
            FirecrackerError::Spawn(msg) => write!(f, "spawn error: {}", msg),
        }
    }
}

impl std::error::Error for FirecrackerError {}

#[cfg(test)]
mod tests {
    use crate::config::VmConfig;

    #[test]
    fn vm_config_generates_valid_json() {
        let config = VmConfig {
            sandbox_id: "sb_test123".to_string(),
            kernel_path: "/var/sandchest/images/vmlinux-5.10".to_string(),
            rootfs_path: "/var/sandchest/sandboxes/sb_test123/rootfs.ext4".to_string(),
            vcpu_count: 2,
            mem_size_mib: 4096,
            vsock_uds_path: "/var/sandchest/sandboxes/sb_test123/vsock.sock".to_string(),
            tap_dev_name: Some("tap-sb_test1".to_string()),
            guest_mac: Some("AA:FC:00:00:00:01".to_string()),
        };

        let json = config.to_json().unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();

        assert_eq!(
            parsed["boot-source"]["kernel_image_path"],
            "/var/sandchest/images/vmlinux-5.10"
        );
        assert_eq!(
            parsed["boot-source"]["boot_args"],
            "console=ttyS0 reboot=k panic=1 pci=off init=/sbin/overlay-init"
        );
        assert_eq!(parsed["drives"][0]["drive_id"], "rootfs");
        assert_eq!(
            parsed["drives"][0]["path_on_host"],
            "/var/sandchest/sandboxes/sb_test123/rootfs.ext4"
        );
        assert_eq!(parsed["drives"][0]["is_root_device"], true);
        assert_eq!(parsed["drives"][0]["is_read_only"], false);
        assert_eq!(parsed["machine-config"]["vcpu_count"], 2);
        assert_eq!(parsed["machine-config"]["mem_size_mib"], 4096);
        assert_eq!(parsed["machine-config"]["smt"], false);
        assert_eq!(parsed["vsock"]["guest_cid"], 3);
        assert_eq!(
            parsed["vsock"]["uds_path"],
            "/var/sandchest/sandboxes/sb_test123/vsock.sock"
        );
        assert_eq!(parsed["network-interfaces"][0]["iface_id"], "eth0");
        assert_eq!(
            parsed["network-interfaces"][0]["guest_mac"],
            "AA:FC:00:00:00:01"
        );
        assert_eq!(
            parsed["network-interfaces"][0]["host_dev_name"],
            "tap-sb_test1"
        );
    }

    #[test]
    fn vm_config_without_network() {
        let config = VmConfig {
            sandbox_id: "sb_test123".to_string(),
            kernel_path: "/var/sandchest/images/vmlinux-5.10".to_string(),
            rootfs_path: "/var/sandchest/sandboxes/sb_test123/rootfs.ext4".to_string(),
            vcpu_count: 4,
            mem_size_mib: 8192,
            vsock_uds_path: "/var/sandchest/sandboxes/sb_test123/vsock.sock".to_string(),
            tap_dev_name: None,
            guest_mac: None,
        };

        let json = config.to_json().unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();

        // network-interfaces should not be present when omitted
        assert!(parsed.get("network-interfaces").is_none());
        assert_eq!(parsed["machine-config"]["vcpu_count"], 4);
        assert_eq!(parsed["machine-config"]["mem_size_mib"], 8192);
    }
}
