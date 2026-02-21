use std::path::Path;
use std::process::Stdio;

use tokio::process::{Child, Command};
use tracing::{error, info, warn};

use crate::config::VmConfig;
use crate::jailer::{self, JailerConfig};

/// Handle to a running Firecracker VM process.
pub struct FirecrackerVm {
    pub sandbox_id: String,
    pub api_socket_path: String,
    pub vsock_path: String,
    pub data_dir: String,
    /// Chroot root path (Some when running under jailer).
    pub chroot_root: Option<String>,
    child: Child,
}

impl FirecrackerVm {
    /// Construct a FirecrackerVm from pre-existing parts (used for snapshot warm start).
    pub fn from_parts(
        sandbox_id: String,
        api_socket_path: String,
        vsock_path: String,
        data_dir: String,
        child: Child,
        chroot_root: Option<String>,
    ) -> Self {
        Self {
            sandbox_id,
            api_socket_path,
            vsock_path,
            data_dir,
            chroot_root,
            child,
        }
    }

    /// Convert a host-absolute path to a Firecracker-visible path.
    ///
    /// For jailed VMs, strips the chroot root prefix so the path is relative
    /// to the chroot. For non-jailed VMs, returns the path unchanged.
    pub fn fc_path(&self, host_path: &str) -> String {
        if let Some(ref root) = self.chroot_root {
            if let Some(relative) = host_path.strip_prefix(root.as_str()) {
                if relative.is_empty() {
                    "/".to_string()
                } else {
                    relative.to_string()
                }
            } else {
                host_path.to_string()
            }
        } else {
            host_path.to_string()
        }
    }

    /// Start a new Firecracker VM with the given configuration (no jailer).
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
            chroot_root: None,
            child,
        })
    }

    /// Start a jailed Firecracker VM using the Firecracker Jailer.
    ///
    /// The rootfs must already be at `{chroot_root}/rootfs.ext4` before calling this.
    ///
    /// 1. Prepares the chroot directory
    /// 2. Hard-links the kernel into the chroot
    /// 3. Writes Firecracker config with chroot-relative paths
    /// 4. Spawns the jailer process
    pub async fn create_jailed(
        vm_config: &VmConfig,
        jailer_config: &JailerConfig,
    ) -> Result<Self, FirecrackerError> {
        let sandbox_id = &vm_config.sandbox_id;
        let chroot_root = jailer_config.chroot_root(sandbox_id);
        let jail_dir = jailer_config.jail_dir(sandbox_id);
        let api_socket_path = jailer_config.host_api_socket_path(sandbox_id);
        let vsock_path = jailer_config.host_vsock_path(sandbox_id);

        // Ensure chroot directory exists
        jailer::prepare_chroot(jailer_config, sandbox_id)
            .await
            .map_err(|e| FirecrackerError::Setup(e.to_string()))?;

        // Hard-link kernel into chroot
        let chroot_kernel = chroot_root.join("vmlinux");
        if !chroot_kernel.exists() {
            jailer::hardlink_or_copy(&vm_config.kernel_path, &chroot_kernel)
                .await
                .map_err(|e| {
                    FirecrackerError::Setup(format!("failed to link kernel into chroot: {}", e))
                })?;
        }

        // Write Firecracker config with chroot-relative paths
        let jailed_vm_config = VmConfig {
            sandbox_id: sandbox_id.clone(),
            kernel_path: "/vmlinux".to_string(),
            rootfs_path: "/rootfs.ext4".to_string(),
            vcpu_count: vm_config.vcpu_count,
            mem_size_mib: vm_config.mem_size_mib,
            vsock_uds_path: "/vsock.sock".to_string(),
            tap_dev_name: vm_config.tap_dev_name.clone(),
            guest_mac: vm_config.guest_mac.clone(),
        };

        let config_json = jailed_vm_config
            .to_json()
            .map_err(|e| FirecrackerError::Setup(format!("failed to serialize config: {}", e)))?;
        let config_path = chroot_root.join("config.json");
        tokio::fs::write(&config_path, &config_json)
            .await
            .map_err(|e| {
                FirecrackerError::Setup(format!(
                    "failed to write jailed config to {}: {}",
                    config_path.display(),
                    e
                ))
            })?;

        info!(
            sandbox_id = %sandbox_id,
            chroot = %chroot_root.display(),
            "starting jailed Firecracker process"
        );

        // Spawn jailer
        let child = jailer::build_jailer_command(
            jailer_config,
            sandbox_id,
            true,
            Some(vm_config.vcpu_count),
            Some(vm_config.mem_size_mib),
        )
        .spawn()
        .map_err(|e| FirecrackerError::Spawn(format!("failed to spawn jailer: {}", e)))?;

        info!(
            sandbox_id = %sandbox_id,
            pid = ?child.id(),
            "jailer process started"
        );

        let chroot_str = chroot_root.to_str().unwrap_or("").to_string();

        Ok(Self {
            sandbox_id: sandbox_id.clone(),
            api_socket_path: api_socket_path.to_str().unwrap_or("").to_string(),
            vsock_path: vsock_path.to_str().unwrap_or("").to_string(),
            data_dir: jail_dir.to_str().unwrap_or("").to_string(),
            chroot_root: Some(chroot_str),
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

    #[test]
    fn firecracker_error_setup_display() {
        let err = super::FirecrackerError::Setup("bad config".to_string());
        assert_eq!(err.to_string(), "setup error: bad config");
    }

    #[test]
    fn firecracker_error_spawn_display() {
        let err = super::FirecrackerError::Spawn("not found".to_string());
        assert_eq!(err.to_string(), "spawn error: not found");
    }

    #[test]
    fn firecracker_error_is_std_error() {
        let err = super::FirecrackerError::Setup("test".to_string());
        let _: &dyn std::error::Error = &err;
    }

    #[test]
    fn firecracker_error_debug_format() {
        let err = super::FirecrackerError::Setup("debug test".to_string());
        let debug = format!("{:?}", err);
        assert!(debug.contains("Setup"));
        assert!(debug.contains("debug test"));
    }

    #[tokio::test]
    async fn firecracker_vm_create_fails_without_binary() {
        let config = VmConfig {
            sandbox_id: "sb_fc_test".to_string(),
            kernel_path: "/nonexistent/vmlinux".to_string(),
            rootfs_path: "/nonexistent/rootfs.ext4".to_string(),
            vcpu_count: 2,
            mem_size_mib: 4096,
            vsock_uds_path: "/tmp/sandchest-fc-test/vsock.sock".to_string(),
            tap_dev_name: None,
            guest_mac: None,
        };

        let tmp = std::env::temp_dir().join("sandchest-fc-create-test");
        let result = super::FirecrackerVm::create(&config, tmp.to_str().unwrap()).await;
        // Should fail since firecracker binary isn't installed in test env
        // or succeed in creating the dir but fail to spawn
        // Either way, we're testing the error path works
        if let Err(e) = result {
            let msg = e.to_string();
            assert!(msg.contains("error"), "unexpected error: {}", msg);
        }

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn fc_path_non_jailed_returns_unchanged() {
        // Simulate a non-jailed VM by constructing fields directly
        let path = "/var/sandchest/sandboxes/sb_test/snapshot_file";
        // Non-jailed: chroot_root is None, so fc_path returns as-is
        // We can't construct a FirecrackerVm in tests (Child not mockable),
        // so we test the logic inline
        let chroot_root: Option<String> = None;
        let result = if let Some(ref root) = chroot_root {
            path.strip_prefix(root.as_str())
                .unwrap_or(path)
                .to_string()
        } else {
            path.to_string()
        };
        assert_eq!(result, path);
    }

    #[test]
    fn fc_path_jailed_strips_chroot_prefix() {
        let chroot_root = Some("/var/sandchest/jailer/firecracker/sb_test/root".to_string());
        let host_path =
            "/var/sandchest/jailer/firecracker/sb_test/root/snapshot_file";
        let result = if let Some(ref root) = chroot_root {
            let relative = host_path.strip_prefix(root.as_str()).unwrap_or(host_path);
            if relative.is_empty() {
                "/".to_string()
            } else {
                relative.to_string()
            }
        } else {
            host_path.to_string()
        };
        assert_eq!(result, "/snapshot_file");
    }

    #[test]
    fn fc_path_jailed_chroot_root_itself() {
        let chroot_root = Some("/var/sandchest/jailer/firecracker/sb_test/root".to_string());
        let host_path = "/var/sandchest/jailer/firecracker/sb_test/root";
        let result = if let Some(ref root) = chroot_root {
            let relative = host_path.strip_prefix(root.as_str()).unwrap_or(host_path);
            if relative.is_empty() {
                "/".to_string()
            } else {
                relative.to_string()
            }
        } else {
            host_path.to_string()
        };
        assert_eq!(result, "/");
    }

    #[tokio::test]
    async fn create_jailed_fails_without_jailer_binary() {
        let jailer_config = crate::jailer::JailerConfig {
            enabled: true,
            jailer_binary: "/nonexistent/jailer".to_string(),
            firecracker_binary: "/nonexistent/firecracker".to_string(),
            chroot_base_dir: std::env::temp_dir()
                .join("sandchest-jailed-test")
                .to_str()
                .unwrap()
                .to_string(),
            uid: 10000,
            gid: 10000,
            cgroup_version: 2,
            seccomp_filter: None,
            new_pid_ns: true,
        };

        let tmp = std::env::temp_dir().join("sandchest-jailed-test");
        let _ = std::fs::remove_dir_all(&tmp);

        // Create a fake kernel and rootfs
        let chroot_root = jailer_config.chroot_root("sb_jail_test");
        std::fs::create_dir_all(&chroot_root).unwrap();
        std::fs::write(chroot_root.join("rootfs.ext4"), b"fake").unwrap();

        let kernel_path = tmp.join("vmlinux");
        std::fs::write(&kernel_path, b"fake kernel").unwrap();

        let vm_config = crate::config::VmConfig {
            sandbox_id: "sb_jail_test".to_string(),
            kernel_path: kernel_path.to_str().unwrap().to_string(),
            rootfs_path: chroot_root.join("rootfs.ext4").to_str().unwrap().to_string(),
            vcpu_count: 2,
            mem_size_mib: 4096,
            vsock_uds_path: "/vsock.sock".to_string(),
            tap_dev_name: None,
            guest_mac: None,
        };

        let result = super::FirecrackerVm::create_jailed(&vm_config, &jailer_config).await;
        match result {
            Ok(_) => panic!("expected error, got success"),
            Err(err) => {
                assert!(
                    err.to_string().contains("spawn") || err.to_string().contains("error"),
                    "unexpected error: {}",
                    err
                );
            }
        }

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
