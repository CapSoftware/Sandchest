use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use tokio::sync::RwLock;
use tracing::{error, info};

use crate::config::{NodeConfig, Profile, VmConfig};
use crate::firecracker::FirecrackerVm;



/// Information about an active sandbox.
pub struct SandboxInfo {
    pub sandbox_id: String,
    pub status: SandboxStatus,
    pub profile: Profile,
    pub env: HashMap<String, String>,
    pub created_at: Instant,
    pub boot_duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxStatus {
    Provisioning,
    Running,
    Stopping,
    Stopped,
    Failed,
}

impl std::fmt::Display for SandboxStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SandboxStatus::Provisioning => write!(f, "provisioning"),
            SandboxStatus::Running => write!(f, "running"),
            SandboxStatus::Stopping => write!(f, "stopping"),
            SandboxStatus::Stopped => write!(f, "stopped"),
            SandboxStatus::Failed => write!(f, "failed"),
        }
    }
}

/// Manages active sandboxes on this node.
pub struct SandboxManager {
    sandboxes: RwLock<HashMap<String, SandboxInfo>>,
    vms: RwLock<HashMap<String, FirecrackerVm>>,
    node_config: Arc<NodeConfig>,
}

impl SandboxManager {
    pub fn new(node_config: Arc<NodeConfig>) -> Self {
        Self {
            sandboxes: RwLock::new(HashMap::new()),
            vms: RwLock::new(HashMap::new()),
            node_config,
        }
    }

    /// Create a new sandbox via cold boot.
    pub async fn create_sandbox(
        &self,
        sandbox_id: &str,
        kernel_ref: &str,
        rootfs_path: &str,
        cpu_cores: u32,
        memory_mb: u32,
        env: HashMap<String, String>,
    ) -> Result<SandboxInfo, SandboxError> {
        let start = Instant::now();
        let profile = Profile::from_resources(cpu_cores, memory_mb);

        info!(sandbox_id = %sandbox_id, ?profile, "creating sandbox");

        // Insert as provisioning
        {
            let mut sandboxes = self.sandboxes.write().await;
            if sandboxes.contains_key(sandbox_id) {
                return Err(SandboxError::AlreadyExists(sandbox_id.to_string()));
            }
            sandboxes.insert(
                sandbox_id.to_string(),
                SandboxInfo {
                    sandbox_id: sandbox_id.to_string(),
                    status: SandboxStatus::Provisioning,
                    profile,
                    env: env.clone(),
                    created_at: start,
                    boot_duration_ms: None,
                },
            );
        }

        let sandbox_dir = format!(
            "{}/sandboxes/{}",
            self.node_config.data_dir, sandbox_id
        );
        let vsock_path = format!("{}/vsock.sock", sandbox_dir);

        // Resolve kernel path: use kernel_ref if provided, else default
        let kernel_path = if kernel_ref.is_empty() {
            self.node_config.kernel_path.clone()
        } else {
            kernel_ref.to_string()
        };

        let vm_config = VmConfig {
            sandbox_id: sandbox_id.to_string(),
            kernel_path,
            rootfs_path: rootfs_path.to_string(),
            vcpu_count: profile.vcpu_count(),
            mem_size_mib: profile.mem_size_mib(),
            vsock_uds_path: vsock_path,
            tap_dev_name: None,  // Networking added in Task 7
            guest_mac: None,
        };

        // Start Firecracker VM
        let vm = match FirecrackerVm::create(&vm_config, &self.node_config.data_dir).await {
            Ok(vm) => vm,
            Err(e) => {
                error!(sandbox_id = %sandbox_id, error = %e, "failed to create VM");
                self.set_status(sandbox_id, SandboxStatus::Failed).await;
                return Err(SandboxError::CreateFailed(e.to_string()));
            }
        };

        let boot_duration_ms = start.elapsed().as_millis() as u64;

        // Store VM handle
        self.vms
            .write()
            .await
            .insert(sandbox_id.to_string(), vm);

        // Update sandbox info to running
        {
            let mut sandboxes = self.sandboxes.write().await;
            if let Some(info) = sandboxes.get_mut(sandbox_id) {
                info.status = SandboxStatus::Running;
                info.boot_duration_ms = Some(boot_duration_ms);
            }
        }

        info!(
            sandbox_id = %sandbox_id,
            boot_duration_ms = boot_duration_ms,
            "sandbox running"
        );

        let sandboxes = self.sandboxes.read().await;
        let info = sandboxes.get(sandbox_id).unwrap();
        Ok(SandboxInfo {
            sandbox_id: info.sandbox_id.clone(),
            status: info.status,
            profile: info.profile,
            env: info.env.clone(),
            created_at: info.created_at,
            boot_duration_ms: info.boot_duration_ms,
        })
    }

    /// Destroy a sandbox: kill the VM and clean up state.
    pub async fn destroy_sandbox(&self, sandbox_id: &str) -> Result<(), SandboxError> {
        info!(sandbox_id = %sandbox_id, "destroying sandbox");

        self.set_status(sandbox_id, SandboxStatus::Stopping).await;

        // Remove and destroy the VM
        let vm = self.vms.write().await.remove(sandbox_id);
        if let Some(vm) = vm {
            if let Err(e) = vm.destroy().await {
                error!(sandbox_id = %sandbox_id, error = %e, "error destroying VM");
            }
        }

        // Update status and remove from tracking
        self.set_status(sandbox_id, SandboxStatus::Stopped).await;
        self.sandboxes.write().await.remove(sandbox_id);

        info!(sandbox_id = %sandbox_id, "sandbox destroyed");
        Ok(())
    }

    /// Get sandbox info by ID.
    pub async fn get_sandbox(&self, sandbox_id: &str) -> Option<SandboxInfo> {
        let sandboxes = self.sandboxes.read().await;
        sandboxes.get(sandbox_id).map(|info| SandboxInfo {
            sandbox_id: info.sandbox_id.clone(),
            status: info.status,
            profile: info.profile,
            env: info.env.clone(),
            created_at: info.created_at,
            boot_duration_ms: info.boot_duration_ms,
        })
    }

    /// List all active sandboxes.
    pub async fn list_sandboxes(&self) -> Vec<SandboxInfo> {
        let sandboxes = self.sandboxes.read().await;
        sandboxes
            .values()
            .map(|info| SandboxInfo {
                sandbox_id: info.sandbox_id.clone(),
                status: info.status,
                profile: info.profile,
                env: info.env.clone(),
                created_at: info.created_at,
                boot_duration_ms: info.boot_duration_ms,
            })
            .collect()
    }

    /// Get list of active sandbox IDs (for heartbeat).
    pub async fn active_sandbox_ids(&self) -> Vec<String> {
        let sandboxes = self.sandboxes.read().await;
        sandboxes
            .values()
            .filter(|s| s.status == SandboxStatus::Running)
            .map(|s| s.sandbox_id.clone())
            .collect()
    }

    /// Get count of active sandboxes (for slot utilization).
    pub async fn active_count(&self) -> usize {
        let sandboxes = self.sandboxes.read().await;
        sandboxes
            .values()
            .filter(|s| {
                s.status == SandboxStatus::Running
                    || s.status == SandboxStatus::Provisioning
            })
            .count()
    }

    async fn set_status(&self, sandbox_id: &str, status: SandboxStatus) {
        let mut sandboxes = self.sandboxes.write().await;
        if let Some(info) = sandboxes.get_mut(sandbox_id) {
            info.status = status;
        }
    }
}

#[derive(Debug)]
pub enum SandboxError {
    AlreadyExists(String),
    NotFound(String),
    CreateFailed(String),
}

impl std::fmt::Display for SandboxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SandboxError::AlreadyExists(id) => {
                write!(f, "sandbox already exists: {}", id)
            }
            SandboxError::NotFound(id) => write!(f, "sandbox not found: {}", id),
            SandboxError::CreateFailed(msg) => {
                write!(f, "sandbox creation failed: {}", msg)
            }
        }
    }
}

impl std::error::Error for SandboxError {}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_node_config() -> Arc<NodeConfig> {
        Arc::new(NodeConfig {
            node_id: crate::id::generate_id(crate::id::NODE_PREFIX),
            grpc_port: 50051,
            data_dir: "/tmp/sandchest-test".to_string(),
            kernel_path: "/var/sandchest/images/vmlinux-5.10".to_string(),
        })
    }

    #[tokio::test]
    async fn sandbox_manager_tracks_state() {
        let manager = SandboxManager::new(test_node_config());

        // Initially empty
        assert_eq!(manager.active_count().await, 0);
        assert!(manager.list_sandboxes().await.is_empty());

        // Get non-existent sandbox returns None
        assert!(manager.get_sandbox("sb_nonexistent").await.is_none());
    }

    #[tokio::test]
    async fn active_sandbox_ids_empty_initially() {
        let manager = SandboxManager::new(test_node_config());
        let ids = manager.active_sandbox_ids().await;
        assert!(ids.is_empty());
    }

    #[test]
    fn sandbox_status_display() {
        assert_eq!(SandboxStatus::Provisioning.to_string(), "provisioning");
        assert_eq!(SandboxStatus::Running.to_string(), "running");
        assert_eq!(SandboxStatus::Stopping.to_string(), "stopping");
        assert_eq!(SandboxStatus::Stopped.to_string(), "stopped");
        assert_eq!(SandboxStatus::Failed.to_string(), "failed");
    }
}
