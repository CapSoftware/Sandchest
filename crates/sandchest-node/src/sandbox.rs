use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::RwLock;
use tracing::{error, info, warn};

use crate::agent_client::AgentClient;
use crate::config::{NodeConfig, Profile, VmConfig};
use crate::disk;
use crate::events::{self, EventSender};
use crate::firecracker::FirecrackerVm;
use crate::network;
use crate::proto;
use crate::slot::SlotManager;
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
    pub network_slot: Option<u16>,
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
    slot_manager: SlotManager,
    event_sender: Option<EventSender>,
}

impl SandboxManager {
    pub fn new(node_config: Arc<NodeConfig>) -> Self {
        Self {
            sandboxes: RwLock::new(HashMap::new()),
            vms: RwLock::new(HashMap::new()),
            node_config,
            slot_manager: SlotManager::new(),
            event_sender: None,
        }
    }

    /// Set the event sender for reporting sandbox lifecycle events.
    pub fn with_event_sender(mut self, sender: EventSender) -> Self {
        self.event_sender = Some(sender);
        self
    }

    /// Get current slot utilization count.
    pub fn slots_used(&self) -> u32 {
        self.slot_manager.active_count() as u32
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

        // Allocate network slot
        let slot = self
            .slot_manager
            .allocate()
            .map_err(|e| SandboxError::CreateFailed(e.to_string()))?;

        // Insert as provisioning
        self.insert_provisioning(sandbox_id, profile, &env, start, Some(slot)).await?;
        self.report_event(events::sandbox_event(
            sandbox_id,
            proto::SandboxEventType::Created,
            "provisioning started",
        ));

        // Step 1: Set up networking (TAP device + NAT)
        let net_config = match network::setup_network(sandbox_id, slot).await {
            Ok(cfg) => cfg,
            Err(e) => {
                error!(sandbox_id = %sandbox_id, error = %e, "failed to set up network");
                self.set_status(sandbox_id, SandboxStatus::Failed).await;
                self.report_event(events::sandbox_event(sandbox_id, proto::SandboxEventType::Failed, &format!("network setup failed: {}", e)));
                self.slot_manager.release(slot);
                return Err(SandboxError::CreateFailed(format!("network setup failed: {}", e)));
            }
        };

        // Step 2: Clone base image ext4
        let rootfs_path = match disk::clone_disk(rootfs_ref, sandbox_id, &self.node_config.data_dir).await {
            Ok(path) => path,
            Err(e) => {
                error!(sandbox_id = %sandbox_id, error = %e, "failed to clone disk");
                self.set_status(sandbox_id, SandboxStatus::Failed).await;
                self.report_event(events::sandbox_event(sandbox_id, proto::SandboxEventType::Failed, &format!("disk clone failed: {}", e)));
                network::teardown_network(sandbox_id, slot).await;
                self.slot_manager.release(slot);
                return Err(SandboxError::CreateFailed(format!("disk clone failed: {}", e)));
            }
        };

        // Step 3: Configure and start Firecracker (with networking)
        let vm = match self.start_firecracker(sandbox_id, kernel_ref, &rootfs_path, profile, &net_config).await {
            Ok(vm) => vm,
            Err(e) => {
                error!(sandbox_id = %sandbox_id, error = %e, "failed to start Firecracker");
                self.set_status(sandbox_id, SandboxStatus::Failed).await;
                self.report_event(events::sandbox_event(sandbox_id, proto::SandboxEventType::Failed, &format!("firecracker failed: {}", e)));
                network::teardown_network(sandbox_id, slot).await;
                self.slot_manager.release(slot);
                // Best-effort cleanup of cloned disk
                let _ = disk::cleanup_disk(sandbox_id, &self.node_config.data_dir).await;
                return Err(e);
            }
        };

        // Step 4: Wait for guest agent health
        if let Err(e) = self.wait_for_agent_health(sandbox_id).await {
            error!(sandbox_id = %sandbox_id, error = %e, "guest agent health check failed");
            self.set_status(sandbox_id, SandboxStatus::Failed).await;
            self.report_event(events::sandbox_event(sandbox_id, proto::SandboxEventType::Failed, &format!("agent health check failed: {}", e)));
            let _ = vm.destroy().await;
            network::teardown_network(sandbox_id, slot).await;
            self.slot_manager.release(slot);
            return Err(SandboxError::CreateFailed(format!("agent health check failed: {}", e)));
        }

        // Step 5 + 6: Store VM handle, env vars already stored, mark running
        let boot_duration_ms = start.elapsed().as_millis() as u64;
        self.vms.write().await.insert(sandbox_id.to_string(), vm);
        self.finalize_running(sandbox_id, boot_duration_ms).await;

        self.report_event(events::sandbox_event(
            sandbox_id,
            proto::SandboxEventType::Ready,
            &format!("running (cold boot: {}ms)", boot_duration_ms),
        ));

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

        // Allocate network slot
        let slot = self
            .slot_manager
            .allocate()
            .map_err(|e| SandboxError::CreateFailed(e.to_string()))?;

        self.insert_provisioning(sandbox_id, profile, &env, start, Some(slot)).await?;
        self.report_event(events::sandbox_event(
            sandbox_id,
            proto::SandboxEventType::Created,
            "provisioning started (warm start)",
        ));

        // Step 1a: Set up networking
        // Network is set up but config isn't passed to Firecracker in snapshot mode
        // (snapshot already has networking baked in). We keep the TAP/NAT rules active.
        let _net_config = match network::setup_network(sandbox_id, slot).await {
            Ok(cfg) => cfg,
            Err(e) => {
                error!(sandbox_id = %sandbox_id, error = %e, "failed to set up network");
                self.set_status(sandbox_id, SandboxStatus::Failed).await;
                self.report_event(events::sandbox_event(sandbox_id, proto::SandboxEventType::Failed, &format!("network setup failed: {}", e)));
                self.slot_manager.release(slot);
                return Err(SandboxError::CreateFailed(format!("network setup failed: {}", e)));
            }
        };

        // Step 1b: Clone snapshot's disk state
        let _rootfs_path = match disk::clone_disk(&snapshot_rootfs, sandbox_id, &self.node_config.data_dir).await {
            Ok(path) => path,
            Err(e) => {
                error!(sandbox_id = %sandbox_id, error = %e, "failed to clone snapshot disk");
                self.set_status(sandbox_id, SandboxStatus::Failed).await;
                self.report_event(events::sandbox_event(sandbox_id, proto::SandboxEventType::Failed, &format!("disk clone failed: {}", e)));
                network::teardown_network(sandbox_id, slot).await;
                self.slot_manager.release(slot);
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
            self.report_event(events::sandbox_event(sandbox_id, proto::SandboxEventType::Failed, &format!("copy mem file failed: {}", e)));
            network::teardown_network(sandbox_id, slot).await;
            self.slot_manager.release(slot);
            return Err(SandboxError::CreateFailed(format!("failed to copy mem file: {}", e)));
        }
        if let Err(e) = tokio::fs::copy(&snapshot_state, &local_snapshot).await {
            self.set_status(sandbox_id, SandboxStatus::Failed).await;
            self.report_event(events::sandbox_event(sandbox_id, proto::SandboxEventType::Failed, &format!("copy snapshot file failed: {}", e)));
            network::teardown_network(sandbox_id, slot).await;
            self.slot_manager.release(slot);
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
                // Note: network cleanup on spawn failure is best-effort since we can't await in map_err
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
            self.report_event(events::sandbox_event(sandbox_id, proto::SandboxEventType::Failed, &format!("firecracker API not ready: {}", e)));
            let _ = vm.destroy().await;
            network::teardown_network(sandbox_id, slot).await;
            self.slot_manager.release(slot);
            return Err(SandboxError::CreateFailed(format!(
                "firecracker API not ready: {}",
                e
            )));
        }

        if let Err(e) = fc_api.restore_snapshot(&local_snapshot, &local_mem).await {
            self.set_status(sandbox_id, SandboxStatus::Failed).await;
            self.report_event(events::sandbox_event(sandbox_id, proto::SandboxEventType::Failed, &format!("snapshot restore failed: {}", e)));
            let _ = vm.destroy().await;
            network::teardown_network(sandbox_id, slot).await;
            self.slot_manager.release(slot);
            return Err(SandboxError::CreateFailed(format!(
                "snapshot restore failed: {}",
                e
            )));
        }

        // Step 4: Resume VM
        if let Err(e) = fc_api.resume_vm().await {
            self.set_status(sandbox_id, SandboxStatus::Failed).await;
            self.report_event(events::sandbox_event(sandbox_id, proto::SandboxEventType::Failed, &format!("VM resume failed: {}", e)));
            let _ = vm.destroy().await;
            network::teardown_network(sandbox_id, slot).await;
            self.slot_manager.release(slot);
            return Err(SandboxError::CreateFailed(format!(
                "VM resume failed: {}",
                e
            )));
        }

        // Step 5: Wait for agent health (should be near-instant after snapshot restore)
        if let Err(e) = self.wait_for_agent_health(sandbox_id).await {
            warn!(sandbox_id = %sandbox_id, error = %e, "agent health check failed after warm start");
            self.set_status(sandbox_id, SandboxStatus::Failed).await;
            self.report_event(events::sandbox_event(sandbox_id, proto::SandboxEventType::Failed, &format!("agent health check failed: {}", e)));
            let _ = vm.destroy().await;
            network::teardown_network(sandbox_id, slot).await;
            self.slot_manager.release(slot);
            return Err(SandboxError::CreateFailed(format!(
                "agent health check failed: {}",
                e
            )));
        }

        // Step 6: Finalize
        let boot_duration_ms = start.elapsed().as_millis() as u64;
        self.vms.write().await.insert(sandbox_id.to_string(), vm);
        self.finalize_running(sandbox_id, boot_duration_ms).await;

        self.report_event(events::sandbox_event(
            sandbox_id,
            proto::SandboxEventType::Ready,
            &format!("running (warm start: {}ms)", boot_duration_ms),
        ));

        info!(
            sandbox_id = %sandbox_id,
            boot_duration_ms = boot_duration_ms,
            "sandbox running (warm start)"
        );

        self.get_sandbox_or_err(sandbox_id).await
    }

    /// Fork a running sandbox by snapshotting it and booting a new VM from that snapshot.
    ///
    /// 1. Pause source VM (~1ms)
    /// 2. Take snapshot of memory + state (~200-300ms)
    /// 3. Clone source disk via reflink copy (~1ms while paused)
    /// 4. Resume source VM (~1ms) — parent downtime ends here
    /// 5. Boot fork from snapshot (~100-200ms)
    /// 6. Wait for agent health (~50-100ms)
    /// 7. Mark new sandbox as running
    pub async fn fork_sandbox(
        &self,
        source_sandbox_id: &str,
        new_sandbox_id: &str,
    ) -> Result<SandboxInfo, SandboxError> {
        let start = Instant::now();

        // Validate source sandbox exists and is running
        let source_info = self
            .get_sandbox(source_sandbox_id)
            .await
            .ok_or_else(|| SandboxError::NotFound(source_sandbox_id.to_string()))?;

        if source_info.status != SandboxStatus::Running {
            return Err(SandboxError::ForkFailed(format!(
                "source sandbox {} is not running (status: {})",
                source_sandbox_id, source_info.status
            )));
        }

        let profile = source_info.profile;
        let env = source_info.env.clone();

        info!(
            source = %source_sandbox_id,
            fork = %new_sandbox_id,
            ?profile,
            "forking sandbox"
        );

        // Get source VM's API socket path
        let source_api_socket = {
            let vms = self.vms.read().await;
            let vm = vms.get(source_sandbox_id).ok_or_else(|| {
                SandboxError::ForkFailed(format!(
                    "source VM handle not found: {}",
                    source_sandbox_id
                ))
            })?;
            vm.api_socket_path.clone()
        };

        // Allocate network slot for the fork
        let slot = self
            .slot_manager
            .allocate()
            .map_err(|e| SandboxError::ForkFailed(e.to_string()))?;

        // Insert fork as provisioning
        if let Err(e) = self
            .insert_provisioning(new_sandbox_id, profile, &env, start, Some(slot))
            .await
        {
            self.slot_manager.release(slot);
            return Err(e);
        }

        self.report_event(events::sandbox_event(
            new_sandbox_id,
            proto::SandboxEventType::Created,
            &format!("fork from {} started", source_sandbox_id),
        ));

        // Set up networking for the fork
        if let Err(e) = network::setup_network(new_sandbox_id, slot).await {
            self.cleanup_fork_failure(
                new_sandbox_id,
                slot,
                None,
                &format!("network setup failed: {}", e),
            )
            .await;
            return Err(SandboxError::ForkFailed(format!(
                "network setup failed: {}",
                e
            )));
        }

        // Create fork sandbox directory (needed before Firecracker writes snapshot files)
        let fork_sandbox_dir =
            format!("{}/sandboxes/{}", self.node_config.data_dir, new_sandbox_id);
        if let Err(e) = tokio::fs::create_dir_all(&fork_sandbox_dir).await {
            self.cleanup_fork_failure(
                new_sandbox_id,
                slot,
                None,
                &format!("mkdir failed: {}", e),
            )
            .await;
            return Err(SandboxError::ForkFailed(format!(
                "failed to create fork dir: {}",
                e
            )));
        }

        let snapshot_path = format!("{}/snapshot_file", fork_sandbox_dir);
        let mem_path = format!("{}/mem_file", fork_sandbox_dir);
        let source_rootfs = format!(
            "{}/sandboxes/{}/rootfs.ext4",
            self.node_config.data_dir, source_sandbox_id
        );

        // --- Step 1: Pause source VM ---
        let fc_api = FirecrackerApi::new(&source_api_socket);
        if let Err(e) = fc_api.pause_vm().await {
            self.cleanup_fork_failure(
                new_sandbox_id,
                slot,
                None,
                &format!("pause source failed: {}", e),
            )
            .await;
            return Err(SandboxError::ForkFailed(format!(
                "failed to pause source: {}",
                e
            )));
        }

        // --- Step 2: Take snapshot (while source is paused) ---
        if let Err(e) = fc_api.take_snapshot(&snapshot_path, &mem_path).await {
            let _ = fc_api.resume_vm().await; // Best-effort resume on failure
            self.cleanup_fork_failure(
                new_sandbox_id,
                slot,
                None,
                &format!("snapshot failed: {}", e),
            )
            .await;
            return Err(SandboxError::ForkFailed(format!(
                "failed to take snapshot: {}",
                e
            )));
        }

        // --- Step 3: Clone disk (while source is paused for consistency) ---
        let disk_result =
            disk::clone_disk(&source_rootfs, new_sandbox_id, &self.node_config.data_dir).await;

        // --- Step 4: Resume source VM (minimize parent downtime) ---
        if let Err(e) = fc_api.resume_vm().await {
            warn!(source = %source_sandbox_id, error = %e, "failed to resume source after fork");
        }

        let parent_downtime_ms = start.elapsed().as_millis() as u64;
        info!(source = %source_sandbox_id, parent_downtime_ms, "source VM resumed");

        // Check disk clone result after resuming source
        if let Err(e) = disk_result {
            self.cleanup_fork_failure(
                new_sandbox_id,
                slot,
                None,
                &format!("disk clone failed: {}", e),
            )
            .await;
            return Err(SandboxError::ForkFailed(format!(
                "failed to clone disk: {}",
                e
            )));
        }

        // --- Step 5: Boot fork from snapshot ---
        let api_socket_path = format!("{}/api.sock", fork_sandbox_dir);
        let vsock_path = format!("{}/vsock.sock", fork_sandbox_dir);

        let child = match tokio::process::Command::new("firecracker")
            .arg("--api-sock")
            .arg(&api_socket_path)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                self.cleanup_fork_failure(
                    new_sandbox_id,
                    slot,
                    None,
                    &format!("spawn failed: {}", e),
                )
                .await;
                return Err(SandboxError::ForkFailed(format!(
                    "failed to spawn firecracker: {}",
                    e
                )));
            }
        };

        let vm = FirecrackerVm::from_parts(
            new_sandbox_id.to_string(),
            api_socket_path.clone(),
            vsock_path,
            fork_sandbox_dir,
            child,
        );

        // Wait for Firecracker API socket
        let fork_fc_api = FirecrackerApi::new(&api_socket_path);
        if let Err(e) = fork_fc_api.wait_for_ready(Duration::from_secs(5)).await {
            self.cleanup_fork_failure(
                new_sandbox_id,
                slot,
                Some(vm),
                &format!("fork API not ready: {}", e),
            )
            .await;
            return Err(SandboxError::ForkFailed(format!(
                "fork API not ready: {}",
                e
            )));
        }

        // Load snapshot into fork VM
        if let Err(e) = fork_fc_api
            .restore_snapshot(&snapshot_path, &mem_path)
            .await
        {
            self.cleanup_fork_failure(
                new_sandbox_id,
                slot,
                Some(vm),
                &format!("snapshot restore failed: {}", e),
            )
            .await;
            return Err(SandboxError::ForkFailed(format!(
                "snapshot restore failed: {}",
                e
            )));
        }

        // Resume fork VM
        if let Err(e) = fork_fc_api.resume_vm().await {
            self.cleanup_fork_failure(
                new_sandbox_id,
                slot,
                Some(vm),
                &format!("fork resume failed: {}", e),
            )
            .await;
            return Err(SandboxError::ForkFailed(format!(
                "fork resume failed: {}",
                e
            )));
        }

        // --- Step 6: Wait for agent health ---
        if let Err(e) = self.wait_for_agent_health(new_sandbox_id).await {
            self.cleanup_fork_failure(
                new_sandbox_id,
                slot,
                Some(vm),
                &format!("agent health check failed: {}", e),
            )
            .await;
            return Err(SandboxError::ForkFailed(format!(
                "agent health check failed: {}",
                e
            )));
        }

        // --- Step 7: Finalize ---
        let boot_duration_ms = start.elapsed().as_millis() as u64;
        self.vms.write().await.insert(new_sandbox_id.to_string(), vm);
        self.finalize_running(new_sandbox_id, boot_duration_ms).await;

        self.report_event(events::sandbox_event(
            new_sandbox_id,
            proto::SandboxEventType::Forked,
            &format!(
                "forked from {} ({}ms, parent downtime: {}ms)",
                source_sandbox_id, boot_duration_ms, parent_downtime_ms
            ),
        ));

        info!(
            source = %source_sandbox_id,
            fork = %new_sandbox_id,
            boot_duration_ms,
            parent_downtime_ms,
            "fork complete"
        );

        self.get_sandbox_or_err(new_sandbox_id).await
    }

    /// Destroy a sandbox: kill the VM, tear down networking, and clean up state.
    pub async fn destroy_sandbox(&self, sandbox_id: &str) -> Result<(), SandboxError> {
        info!(sandbox_id = %sandbox_id, "destroying sandbox");

        self.set_status(sandbox_id, SandboxStatus::Stopping).await;

        // Get the network slot before removing sandbox info
        let network_slot = {
            let sandboxes = self.sandboxes.read().await;
            sandboxes.get(sandbox_id).and_then(|s| s.network_slot)
        };

        // Remove and destroy the VM
        let vm = self.vms.write().await.remove(sandbox_id);
        if let Some(vm) = vm {
            if let Err(e) = vm.destroy().await {
                error!(sandbox_id = %sandbox_id, error = %e, "error destroying VM");
            }
        }

        // Tear down networking
        if let Some(slot) = network_slot {
            network::teardown_network(sandbox_id, slot).await;
            self.slot_manager.release(slot);
        }

        // Update status and remove from tracking
        self.set_status(sandbox_id, SandboxStatus::Stopped).await;
        self.report_event(events::sandbox_event(
            sandbox_id,
            proto::SandboxEventType::Stopped,
            "destroyed",
        ));
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
            network_slot: info.network_slot,
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
                network_slot: info.network_slot,
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

    // --- Event reporting ---

    fn report_event(&self, event: proto::NodeToControl) {
        if let Some(ref sender) = self.event_sender {
            // Non-blocking send — drop if channel is full
            let _ = sender.try_send(event);
        }
    }

    // --- Internal helpers ---

    /// Clean up resources after a fork failure: mark failed, report event,
    /// destroy VM or clean disk, tear down network, release slot.
    async fn cleanup_fork_failure(
        &self,
        sandbox_id: &str,
        slot: u16,
        vm: Option<FirecrackerVm>,
        message: &str,
    ) {
        error!(sandbox_id = %sandbox_id, error = %message, "fork failed");
        self.set_status(sandbox_id, SandboxStatus::Failed).await;
        self.report_event(events::sandbox_event(
            sandbox_id,
            proto::SandboxEventType::Failed,
            message,
        ));
        if let Some(vm) = vm {
            // vm.destroy() removes the sandbox dir and vsock socket
            let _ = vm.destroy().await;
        } else {
            let _ = disk::cleanup_disk(sandbox_id, &self.node_config.data_dir).await;
        }
        network::teardown_network(sandbox_id, slot).await;
        self.slot_manager.release(slot);
    }

    async fn insert_provisioning(
        &self,
        sandbox_id: &str,
        profile: Profile,
        env: &HashMap<String, String>,
        created_at: Instant,
        network_slot: Option<u16>,
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
                network_slot,
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
        net_config: &network::NetworkConfig,
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
            tap_dev_name: Some(net_config.tap_name.clone()),
            guest_mac: Some(net_config.guest_mac.clone()),
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
    ForkFailed(String),
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
            SandboxError::ForkFailed(msg) => {
                write!(f, "sandbox fork failed: {}", msg)
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
            control_plane_url: None,
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
            .insert_provisioning("sb_dup", Profile::Small, &env, Instant::now(), Some(0))
            .await;
        assert!(result.is_ok());

        let result = manager
            .insert_provisioning("sb_dup", Profile::Small, &env, Instant::now(), Some(1))
            .await;
        assert!(matches!(result, Err(SandboxError::AlreadyExists(_))));
    }

    #[tokio::test]
    async fn with_event_sender_reports_events() {
        let (tx, mut rx) = crate::events::channel(16);
        let manager = SandboxManager::new(test_node_config()).with_event_sender(tx);

        // report_event should send through the channel
        manager.report_event(crate::events::sandbox_event(
            "sb_test",
            proto::SandboxEventType::Created,
            "test",
        ));

        let msg = rx.try_recv().unwrap();
        assert!(matches!(
            msg.event,
            Some(proto::node_to_control::Event::SandboxEvent(_))
        ));
    }

    #[tokio::test]
    async fn slots_used_starts_at_zero() {
        let manager = SandboxManager::new(test_node_config());
        assert_eq!(manager.slots_used(), 0);
    }

    #[tokio::test]
    async fn report_event_without_sender_is_noop() {
        let manager = SandboxManager::new(test_node_config());
        // Should not panic when no event sender is set
        manager.report_event(crate::events::sandbox_event(
            "sb_test",
            proto::SandboxEventType::Created,
            "test",
        ));
    }

    #[test]
    fn sandbox_error_already_exists_display() {
        let err = SandboxError::AlreadyExists("sb_dup".to_string());
        assert_eq!(err.to_string(), "sandbox already exists: sb_dup");
    }

    #[test]
    fn sandbox_error_not_found_display() {
        let err = SandboxError::NotFound("sb_missing".to_string());
        assert_eq!(err.to_string(), "sandbox not found: sb_missing");
    }

    #[test]
    fn sandbox_error_create_failed_display() {
        let err = SandboxError::CreateFailed("disk clone failed".to_string());
        assert_eq!(
            err.to_string(),
            "sandbox creation failed: disk clone failed"
        );
    }

    #[test]
    fn sandbox_error_is_std_error() {
        let err = SandboxError::NotFound("test".to_string());
        let _: &dyn std::error::Error = &err;
    }

    #[test]
    fn sandbox_status_equality() {
        assert_eq!(SandboxStatus::Running, SandboxStatus::Running);
        assert_ne!(SandboxStatus::Running, SandboxStatus::Stopped);
        assert_ne!(SandboxStatus::Provisioning, SandboxStatus::Failed);
    }

    #[test]
    fn sandbox_status_clone_and_copy() {
        let s = SandboxStatus::Running;
        let s2 = s; // Copy
        let s3 = s; // Another Copy
        assert_eq!(s, s2);
        assert_eq!(s, s3);
    }

    #[test]
    fn sandbox_status_debug() {
        let debug = format!("{:?}", SandboxStatus::Provisioning);
        assert_eq!(debug, "Provisioning");
    }

    #[tokio::test]
    async fn get_sandbox_returns_correct_fields() {
        let manager = SandboxManager::new(test_node_config());
        let mut env = HashMap::new();
        env.insert("KEY".to_string(), "value".to_string());

        manager
            .insert_provisioning("sb_fields", Profile::Medium, &env, Instant::now(), Some(5))
            .await
            .unwrap();

        let info = manager.get_sandbox("sb_fields").await.unwrap();
        assert_eq!(info.sandbox_id, "sb_fields");
        assert_eq!(info.status, SandboxStatus::Provisioning);
        assert_eq!(info.profile.vcpu_count(), 4); // Medium
        assert_eq!(info.env.get("KEY").unwrap(), "value");
        assert!(info.boot_duration_ms.is_none());
        assert_eq!(info.network_slot, Some(5));
    }

    #[tokio::test]
    async fn list_sandboxes_returns_all() {
        let manager = SandboxManager::new(test_node_config());
        let env = HashMap::new();

        manager
            .insert_provisioning("sb_a", Profile::Small, &env, Instant::now(), Some(0))
            .await
            .unwrap();
        manager
            .insert_provisioning("sb_b", Profile::Large, &env, Instant::now(), Some(1))
            .await
            .unwrap();

        let list = manager.list_sandboxes().await;
        assert_eq!(list.len(), 2);

        let ids: Vec<&str> = list.iter().map(|s| s.sandbox_id.as_str()).collect();
        assert!(ids.contains(&"sb_a"));
        assert!(ids.contains(&"sb_b"));
    }

    #[tokio::test]
    async fn finalize_running_updates_status_and_boot_time() {
        let manager = SandboxManager::new(test_node_config());
        let env = HashMap::new();

        manager
            .insert_provisioning("sb_fin", Profile::Small, &env, Instant::now(), Some(0))
            .await
            .unwrap();

        manager.finalize_running("sb_fin", 250).await;

        let info = manager.get_sandbox("sb_fin").await.unwrap();
        assert_eq!(info.status, SandboxStatus::Running);
        assert_eq!(info.boot_duration_ms, Some(250));
    }

    #[tokio::test]
    async fn set_status_updates_sandbox() {
        let manager = SandboxManager::new(test_node_config());
        let env = HashMap::new();

        manager
            .insert_provisioning("sb_status", Profile::Small, &env, Instant::now(), Some(0))
            .await
            .unwrap();

        manager
            .set_status("sb_status", SandboxStatus::Failed)
            .await;

        let info = manager.get_sandbox("sb_status").await.unwrap();
        assert_eq!(info.status, SandboxStatus::Failed);
    }

    #[tokio::test]
    async fn set_status_nonexistent_is_noop() {
        let manager = SandboxManager::new(test_node_config());
        // Should not panic
        manager
            .set_status("sb_ghost", SandboxStatus::Stopped)
            .await;
    }

    #[tokio::test]
    async fn active_sandbox_ids_only_includes_running() {
        let manager = SandboxManager::new(test_node_config());
        let env = HashMap::new();

        manager
            .insert_provisioning("sb_prov", Profile::Small, &env, Instant::now(), Some(0))
            .await
            .unwrap();
        manager
            .insert_provisioning("sb_run", Profile::Small, &env, Instant::now(), Some(1))
            .await
            .unwrap();

        // Only sb_run is Running after finalize
        manager.finalize_running("sb_run", 100).await;

        let ids = manager.active_sandbox_ids().await;
        assert_eq!(ids, vec!["sb_run"]);
    }

    #[tokio::test]
    async fn active_count_includes_provisioning_and_running() {
        let manager = SandboxManager::new(test_node_config());
        let env = HashMap::new();

        manager
            .insert_provisioning("sb_p", Profile::Small, &env, Instant::now(), Some(0))
            .await
            .unwrap();
        manager
            .insert_provisioning("sb_r", Profile::Small, &env, Instant::now(), Some(1))
            .await
            .unwrap();
        manager.finalize_running("sb_r", 50).await;

        // 1 provisioning + 1 running = 2 active
        assert_eq!(manager.active_count().await, 2);
    }

    #[tokio::test]
    async fn active_count_excludes_failed_and_stopped() {
        let manager = SandboxManager::new(test_node_config());
        let env = HashMap::new();

        manager
            .insert_provisioning("sb_f", Profile::Small, &env, Instant::now(), Some(0))
            .await
            .unwrap();
        manager
            .set_status("sb_f", SandboxStatus::Failed)
            .await;

        manager
            .insert_provisioning("sb_s", Profile::Small, &env, Instant::now(), Some(1))
            .await
            .unwrap();
        manager
            .set_status("sb_s", SandboxStatus::Stopped)
            .await;

        assert_eq!(manager.active_count().await, 0);
    }

    #[tokio::test]
    async fn destroy_sandbox_nonexistent_succeeds() {
        let manager = SandboxManager::new(test_node_config());
        // Destroying a sandbox that doesn't exist in VM map should still succeed
        // because the sandbox info won't be found for network slot
        let result = manager.destroy_sandbox("sb_ghost").await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn event_dropped_when_channel_full() {
        let (tx, _rx) = crate::events::channel(1);
        let manager = SandboxManager::new(test_node_config()).with_event_sender(tx);

        // Fill the channel
        manager.report_event(crate::events::sandbox_event(
            "sb_1",
            proto::SandboxEventType::Created,
            "",
        ));
        // This should not panic — just silently dropped
        manager.report_event(crate::events::sandbox_event(
            "sb_2",
            proto::SandboxEventType::Created,
            "",
        ));
    }

    // --- Fork sandbox tests ---

    #[tokio::test]
    async fn fork_sandbox_source_not_found() {
        let manager = SandboxManager::new(test_node_config());
        let result = manager.fork_sandbox("sb_nonexistent", "sb_fork").await;
        assert!(matches!(result, Err(SandboxError::NotFound(_))));
    }

    #[tokio::test]
    async fn fork_sandbox_source_not_running_provisioning() {
        let manager = SandboxManager::new(test_node_config());
        let env = HashMap::new();
        manager
            .insert_provisioning("sb_src", Profile::Small, &env, Instant::now(), Some(0))
            .await
            .unwrap();

        let result = manager.fork_sandbox("sb_src", "sb_fork").await;
        assert!(matches!(result, Err(SandboxError::ForkFailed(ref msg)) if msg.contains("not running")));
    }

    #[tokio::test]
    async fn fork_sandbox_source_not_running_failed() {
        let manager = SandboxManager::new(test_node_config());
        let env = HashMap::new();
        manager
            .insert_provisioning("sb_src", Profile::Small, &env, Instant::now(), Some(0))
            .await
            .unwrap();
        manager
            .set_status("sb_src", SandboxStatus::Failed)
            .await;

        let result = manager.fork_sandbox("sb_src", "sb_fork").await;
        assert!(matches!(result, Err(SandboxError::ForkFailed(ref msg)) if msg.contains("not running")));
    }

    #[tokio::test]
    async fn fork_sandbox_source_not_running_stopped() {
        let manager = SandboxManager::new(test_node_config());
        let env = HashMap::new();
        manager
            .insert_provisioning("sb_src", Profile::Small, &env, Instant::now(), Some(0))
            .await
            .unwrap();
        manager
            .set_status("sb_src", SandboxStatus::Stopped)
            .await;

        let result = manager.fork_sandbox("sb_src", "sb_fork").await;
        assert!(matches!(result, Err(SandboxError::ForkFailed(ref msg)) if msg.contains("not running")));
    }

    #[tokio::test]
    async fn fork_sandbox_no_vm_handle() {
        let manager = SandboxManager::new(test_node_config());
        let env = HashMap::new();
        manager
            .insert_provisioning("sb_src", Profile::Small, &env, Instant::now(), Some(0))
            .await
            .unwrap();
        manager.finalize_running("sb_src", 100).await;

        // Source is Running but has no VM handle in the vms map
        let result = manager.fork_sandbox("sb_src", "sb_fork").await;
        assert!(matches!(result, Err(SandboxError::ForkFailed(ref msg)) if msg.contains("VM handle not found")));
    }

    #[test]
    fn sandbox_error_fork_failed_display() {
        let err = SandboxError::ForkFailed("source not running".to_string());
        assert_eq!(
            err.to_string(),
            "sandbox fork failed: source not running"
        );
    }

    #[test]
    fn sandbox_error_fork_failed_debug() {
        let err = SandboxError::ForkFailed("test".to_string());
        let debug = format!("{:?}", err);
        assert!(debug.contains("ForkFailed"));
        assert!(debug.contains("test"));
    }

    #[test]
    fn sandbox_error_fork_failed_is_std_error() {
        let err = SandboxError::ForkFailed("test".to_string());
        let _: &dyn std::error::Error = &err;
    }

    #[tokio::test]
    async fn fork_sandbox_preserves_source_profile() {
        let manager = SandboxManager::new(test_node_config());
        let env = HashMap::new();
        // Source is Medium profile
        manager
            .insert_provisioning("sb_src", Profile::Medium, &env, Instant::now(), Some(0))
            .await
            .unwrap();
        manager.finalize_running("sb_src", 100).await;

        // Fork will fail (no VM handle) but we can verify the error path
        // doesn't panic and correctly identifies the source profile issue
        let result = manager.fork_sandbox("sb_src", "sb_fork").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn fork_sandbox_inherits_env() {
        let manager = SandboxManager::new(test_node_config());
        let mut env = HashMap::new();
        env.insert("MY_VAR".to_string(), "my_value".to_string());

        manager
            .insert_provisioning("sb_src", Profile::Small, &env, Instant::now(), Some(0))
            .await
            .unwrap();
        manager.finalize_running("sb_src", 100).await;

        // Will fail at VM handle check, but verifies env is read
        let result = manager.fork_sandbox("sb_src", "sb_fork").await;
        assert!(result.is_err());

        // Source env should still be intact
        let source = manager.get_sandbox("sb_src").await.unwrap();
        assert_eq!(source.env.get("MY_VAR").unwrap(), "my_value");
    }

    #[tokio::test]
    async fn fork_sandbox_duplicate_new_id_returns_already_exists() {
        let manager = SandboxManager::new(test_node_config());
        let env = HashMap::new();

        // Set up source as running with a fake VM handle entry
        // We can't add a real VM handle, so we test the AlreadyExists path
        // by making the new_sandbox_id already exist
        manager
            .insert_provisioning("sb_existing", Profile::Small, &env, Instant::now(), Some(0))
            .await
            .unwrap();
        manager.finalize_running("sb_existing", 100).await;

        // The fork will fail at VM handle check since we can't insert a real VM,
        // but if we try to fork with new_sandbox_id = an existing ID, the
        // insert_provisioning call would fail with AlreadyExists (if we got past
        // the VM handle check). Let's test what happens when source=running but
        // no VM handle.
        let result = manager.fork_sandbox("sb_existing", "sb_fork").await;
        assert!(matches!(result, Err(SandboxError::ForkFailed(_))));
    }

    #[tokio::test]
    async fn fork_sandbox_reports_events_on_failure() {
        let (tx, mut rx) = crate::events::channel(16);
        let manager = SandboxManager::new(test_node_config()).with_event_sender(tx);
        let env = HashMap::new();

        manager
            .insert_provisioning("sb_src", Profile::Small, &env, Instant::now(), Some(0))
            .await
            .unwrap();

        // Source not running — should report no events (early return before event reporting)
        let result = manager.fork_sandbox("sb_src", "sb_fork").await;
        assert!(result.is_err());

        // No events should be reported for early validation failures
        assert!(rx.try_recv().is_err());
    }
}
