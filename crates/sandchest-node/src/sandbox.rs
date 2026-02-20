use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::RwLock;
use tracing::{error, info, warn};

use crate::agent_client::AgentClient;
use crate::config::{NodeConfig, Profile, VmConfig};
use crate::disk;
use crate::firecracker::FirecrackerVm;
use crate::snapshot::FirecrackerApi;

/// Health check timeout for guest agent after boot.
const AGENT_HEALTH_TIMEOUT: Duration = Duration::from_secs(10);

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
    ///
    /// 1. Clone base image ext4 via reflink copy
    /// 2. Configure and start Firecracker process
    /// 3. Wait for guest agent health check
    /// 4. Store env vars for inclusion in exec/session requests
    /// 5. Mark sandbox as running
    pub async fn create_sandbox(
        &self,
        sandbox_id: &str,
        kernel_ref: &str,
        rootfs_ref: &str,
        cpu_cores: u32,
        memory_mb: u32,
        env: HashMap<String, String>,
    ) -> Result<SandboxInfo, SandboxError> {
        let start = Instant::now();
        let profile = Profile::from_resources(cpu_cores, memory_mb);

        info!(sandbox_id = %sandbox_id, ?profile, "creating sandbox via cold boot");

        // Insert as provisioning
        self.insert_provisioning(sandbox_id, profile, &env, start).await?;

        // Step 1: Clone base image ext4
        let rootfs_path = match disk::clone_disk(rootfs_ref, sandbox_id, &self.node_config.data_dir).await {
            Ok(path) => path,
            Err(e) => {
                error!(sandbox_id = %sandbox_id, error = %e, "failed to clone disk");
                self.set_status(sandbox_id, SandboxStatus::Failed).await;
                return Err(SandboxError::CreateFailed(format!("disk clone failed: {}", e)));
            }
        };

        // Step 2: Configure and start Firecracker
        let vm = match self.start_firecracker(sandbox_id, kernel_ref, &rootfs_path, profile).await {
            Ok(vm) => vm,
            Err(e) => {
                error!(sandbox_id = %sandbox_id, error = %e, "failed to start Firecracker");
                self.set_status(sandbox_id, SandboxStatus::Failed).await;
                // Best-effort cleanup of cloned disk
                let _ = disk::cleanup_disk(sandbox_id, &self.node_config.data_dir).await;
                return Err(e);
            }
        };

        // Step 3: Wait for guest agent health
        if let Err(e) = self.wait_for_agent_health(sandbox_id).await {
            error!(sandbox_id = %sandbox_id, error = %e, "guest agent health check failed");
            self.set_status(sandbox_id, SandboxStatus::Failed).await;
            let _ = vm.destroy().await;
            return Err(SandboxError::CreateFailed(format!("agent health check failed: {}", e)));
        }

        // Step 4 + 5: Store VM handle, env vars already stored, mark running
        let boot_duration_ms = start.elapsed().as_millis() as u64;
        self.vms.write().await.insert(sandbox_id.to_string(), vm);
        self.finalize_running(sandbox_id, boot_duration_ms).await;

        info!(
            sandbox_id = %sandbox_id,
            boot_duration_ms = boot_duration_ms,
            "sandbox running (cold boot)"
        );

        self.get_sandbox_or_err(sandbox_id).await
    }

    /// Create a sandbox from a pre-built snapshot (warm start).
    ///
    /// 1. Clone snapshot's disk state via reflink copy
    /// 2. Start new Firecracker process (without config-file, will load snapshot)
    /// 3. Load snapshot via Firecracker API
    /// 4. Resume VM
    /// 5. Wait for agent health (near-instant)
    /// 6. Store env vars, mark running
    pub async fn create_sandbox_from_snapshot(
        &self,
        sandbox_id: &str,
        snapshot_ref: &str,
        env: HashMap<String, String>,
    ) -> Result<SandboxInfo, SandboxError> {
        let start = Instant::now();

        // Resolve snapshot paths
        let snapshot_dir = format!("{}/snapshots/{}", self.node_config.data_dir, snapshot_ref);
        let snapshot_rootfs = format!("{}/rootfs.ext4", snapshot_dir);
        let snapshot_mem = format!("{}/mem_file", snapshot_dir);
        let snapshot_state = format!("{}/snapshot_file", snapshot_dir);

        if !Path::new(&snapshot_dir).exists() {
            return Err(SandboxError::CreateFailed(format!(
                "snapshot not found: {}",
                snapshot_ref
            )));
        }

        // Determine profile from snapshot (default to small for warm starts)
        let profile = Profile::Small;

        info!(
            sandbox_id = %sandbox_id,
            snapshot_ref = %snapshot_ref,
            "creating sandbox via warm start"
        );

        self.insert_provisioning(sandbox_id, profile, &env, start).await?;

        // Step 1: Clone snapshot's disk state
        let _rootfs_path = match disk::clone_disk(&snapshot_rootfs, sandbox_id, &self.node_config.data_dir).await {
            Ok(path) => path,
            Err(e) => {
                error!(sandbox_id = %sandbox_id, error = %e, "failed to clone snapshot disk");
                self.set_status(sandbox_id, SandboxStatus::Failed).await;
                return Err(SandboxError::CreateFailed(format!("disk clone failed: {}", e)));
            }
        };

        // Step 2: Start Firecracker process (no config-file — we'll load a snapshot)
        let sandbox_dir = format!("{}/sandboxes/{}", self.node_config.data_dir, sandbox_id);
        let api_socket_path = format!("{}/api.sock", sandbox_dir);
        let vsock_path = format!("{}/vsock.sock", sandbox_dir);

        // Copy snapshot memory file into sandbox dir for Firecracker to access
        let local_mem = format!("{}/mem_file", sandbox_dir);
        let local_snapshot = format!("{}/snapshot_file", sandbox_dir);
        if let Err(e) = tokio::fs::copy(&snapshot_mem, &local_mem).await {
            self.set_status(sandbox_id, SandboxStatus::Failed).await;
            return Err(SandboxError::CreateFailed(format!("failed to copy mem file: {}", e)));
        }
        if let Err(e) = tokio::fs::copy(&snapshot_state, &local_snapshot).await {
            self.set_status(sandbox_id, SandboxStatus::Failed).await;
            return Err(SandboxError::CreateFailed(format!("failed to copy snapshot file: {}", e)));
        }

        // Start Firecracker without --config-file (snapshot mode)
        let child = tokio::process::Command::new("firecracker")
            .arg("--api-sock")
            .arg(&api_socket_path)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| {
                SandboxError::CreateFailed(format!("failed to spawn firecracker: {}", e))
            })?;

        let vm = FirecrackerVm::from_parts(
            sandbox_id.to_string(),
            api_socket_path.clone(),
            vsock_path,
            sandbox_dir,
            child,
        );

        // Step 3: Wait for Firecracker API socket, then load snapshot
        let fc_api = FirecrackerApi::new(&api_socket_path);
        if let Err(e) = fc_api.wait_for_ready(Duration::from_secs(5)).await {
            self.set_status(sandbox_id, SandboxStatus::Failed).await;
            let _ = vm.destroy().await;
            return Err(SandboxError::CreateFailed(format!(
                "firecracker API not ready: {}",
                e
            )));
        }

        if let Err(e) = fc_api.restore_snapshot(&local_snapshot, &local_mem).await {
            self.set_status(sandbox_id, SandboxStatus::Failed).await;
            let _ = vm.destroy().await;
            return Err(SandboxError::CreateFailed(format!(
                "snapshot restore failed: {}",
                e
            )));
        }

        // Step 4: Resume VM
        if let Err(e) = fc_api.resume_vm().await {
            self.set_status(sandbox_id, SandboxStatus::Failed).await;
            let _ = vm.destroy().await;
            return Err(SandboxError::CreateFailed(format!(
                "VM resume failed: {}",
                e
            )));
        }

        // Step 5: Wait for agent health (should be near-instant after snapshot restore)
        if let Err(e) = self.wait_for_agent_health(sandbox_id).await {
            warn!(sandbox_id = %sandbox_id, error = %e, "agent health check failed after warm start");
            self.set_status(sandbox_id, SandboxStatus::Failed).await;
            let _ = vm.destroy().await;
            return Err(SandboxError::CreateFailed(format!(
                "agent health check failed: {}",
                e
            )));
        }

        // Step 6: Finalize
        let boot_duration_ms = start.elapsed().as_millis() as u64;
        self.vms.write().await.insert(sandbox_id.to_string(), vm);
        self.finalize_running(sandbox_id, boot_duration_ms).await;

        info!(
            sandbox_id = %sandbox_id,
            boot_duration_ms = boot_duration_ms,
            "sandbox running (warm start)"
        );

        self.get_sandbox_or_err(sandbox_id).await
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

    // --- Internal helpers ---

    async fn insert_provisioning(
        &self,
        sandbox_id: &str,
        profile: Profile,
        env: &HashMap<String, String>,
        created_at: Instant,
    ) -> Result<(), SandboxError> {
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
                created_at,
                boot_duration_ms: None,
            },
        );
        Ok(())
    }

    async fn start_firecracker(
        &self,
        sandbox_id: &str,
        kernel_ref: &str,
        rootfs_path: &str,
        profile: Profile,
    ) -> Result<FirecrackerVm, SandboxError> {
        let sandbox_dir = format!("{}/sandboxes/{}", self.node_config.data_dir, sandbox_id);
        let vsock_path = format!("{}/vsock.sock", sandbox_dir);

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
            tap_dev_name: None, // Networking added in Task 7
            guest_mac: None,
        };

        FirecrackerVm::create(&vm_config, &self.node_config.data_dir)
            .await
            .map_err(|e| SandboxError::CreateFailed(e.to_string()))
    }

    async fn wait_for_agent_health(&self, _sandbox_id: &str) -> Result<(), SandboxError> {
        // In dev mode, connect via TCP; in production, use vsock
        let endpoint = if std::env::var("SANDCHEST_AGENT_DEV").unwrap_or_default() == "1" {
            AgentClient::dev_endpoint()
        } else {
            // vsock endpoint — for now, fall back to dev endpoint since
            // tonic doesn't natively support vsock URIs. Full vsock transport
            // will be wired up when running on bare-metal Linux.
            let port = std::env::var("SANDCHEST_AGENT_DEV_PORT")
                .ok()
                .and_then(|s| s.parse::<u16>().ok())
                .unwrap_or(8052);
            format!("http://127.0.0.1:{}", port)
        };

        AgentClient::wait_for_health(&endpoint, AGENT_HEALTH_TIMEOUT)
            .await
            .map_err(|e| SandboxError::CreateFailed(e.to_string()))
    }

    async fn finalize_running(&self, sandbox_id: &str, boot_duration_ms: u64) {
        let mut sandboxes = self.sandboxes.write().await;
        if let Some(info) = sandboxes.get_mut(sandbox_id) {
            info.status = SandboxStatus::Running;
            info.boot_duration_ms = Some(boot_duration_ms);
        }
    }

    async fn get_sandbox_or_err(&self, sandbox_id: &str) -> Result<SandboxInfo, SandboxError> {
        self.get_sandbox(sandbox_id)
            .await
            .ok_or_else(|| SandboxError::NotFound(sandbox_id.to_string()))
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

    #[tokio::test]
    async fn insert_provisioning_rejects_duplicates() {
        let manager = SandboxManager::new(test_node_config());

        let env = HashMap::new();
        let result = manager
            .insert_provisioning("sb_dup", Profile::Small, &env, Instant::now())
            .await;
        assert!(result.is_ok());

        let result = manager
            .insert_provisioning("sb_dup", Profile::Small, &env, Instant::now())
            .await;
        assert!(matches!(result, Err(SandboxError::AlreadyExists(_))));
    }
}
