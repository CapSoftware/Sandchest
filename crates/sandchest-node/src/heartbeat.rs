use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use sysinfo::{Disks, Networks, System};
use tracing::{debug, warn};

use crate::config::NodeConfig;
use crate::events::{self, EventSender};
use crate::proto;
use crate::sandbox::SandboxManager;

/// Default heartbeat interval.
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);

/// Maximum number of network slots (matches slot.rs).
const MAX_SLOTS: u32 = 256;

/// Collect system metrics using the sysinfo crate.
fn collect_metrics(sys: &mut System, networks: &mut Networks, disks: &mut Disks) -> proto::NodeMetrics {
    sys.refresh_cpu_all();
    sys.refresh_memory();
    networks.refresh(true);
    disks.refresh(true);

    let cpu_percent = sys.global_cpu_usage();
    let memory_used_bytes = sys.used_memory();
    let memory_total_bytes = sys.total_memory();

    let (mut disk_used, mut disk_total) = (0u64, 0u64);
    for disk in disks.list() {
        disk_total += disk.total_space();
        disk_used += disk.total_space() - disk.available_space();
    }

    let (mut rx_bytes, mut tx_bytes) = (0u64, 0u64);
    for (_name, data) in networks.iter() {
        rx_bytes += data.total_received();
        tx_bytes += data.total_transmitted();
    }

    let load_avg = System::load_average();

    proto::NodeMetrics {
        cpu_percent,
        memory_used_bytes,
        memory_total_bytes,
        disk_used_bytes: disk_used,
        disk_total_bytes: disk_total,
        network_rx_bytes: rx_bytes,
        network_tx_bytes: tx_bytes,
        load_avg_1: load_avg.one as f32,
        load_avg_5: load_avg.five as f32,
        load_avg_15: load_avg.fifteen as f32,
    }
}

/// Start the heartbeat loop that reports node health to the control plane.
///
/// Sends a heartbeat every 15 seconds via the event sender, including system metrics.
pub async fn start_heartbeat(
    node_config: Arc<NodeConfig>,
    sandbox_manager: Arc<SandboxManager>,
    event_sender: EventSender,
) {
    let mut interval = tokio::time::interval(HEARTBEAT_INTERVAL);
    let mut sys = System::new();
    let mut networks = Networks::new_with_refreshed_list();
    let mut disks = Disks::new_with_refreshed_list();

    loop {
        interval.tick().await;

        let active_ids = sandbox_manager.active_sandbox_ids().await;
        let slots_used = sandbox_manager.slots_used();
        let snapshot_ids = scan_snapshots(&node_config.snapshots_dir()).await;
        let metrics = collect_metrics(&mut sys, &mut networks, &mut disks);

        let msg = events::heartbeat_msg(
            &node_config.node_id,
            active_ids,
            MAX_SLOTS,
            slots_used,
            snapshot_ids,
            Some(metrics),
        );

        if let Err(e) = event_sender.try_send(msg) {
            warn!(error = %e, "failed to send heartbeat");
        } else {
            debug!("heartbeat sent");
        }
    }
}

/// Scan the snapshots directory for available snapshot IDs.
pub async fn scan_snapshots(snapshots_dir: &str) -> Vec<String> {
    let path = Path::new(snapshots_dir);
    if !path.exists() {
        return Vec::new();
    }

    let mut entries = match tokio::fs::read_dir(path).await {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };

    let mut snapshot_ids = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        if let Ok(ft) = entry.file_type().await {
            if ft.is_dir() {
                if let Some(name) = entry.file_name().to_str() {
                    snapshot_ids.push(name.to_string());
                }
            }
        }
    }
    snapshot_ids.sort();
    snapshot_ids
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn scan_snapshots_nonexistent_dir() {
        let ids = scan_snapshots("/tmp/nonexistent-sandchest-snapshots-12345").await;
        assert!(ids.is_empty());
    }

    #[tokio::test]
    async fn scan_snapshots_with_entries() {
        let dir = std::env::temp_dir().join("sandchest-test-snapshots");
        let _ = tokio::fs::remove_dir_all(&dir).await;
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::create_dir(dir.join("snap_abc")).await.unwrap();
        tokio::fs::create_dir(dir.join("snap_def")).await.unwrap();
        // Create a file (should be ignored — only directories are snapshots)
        tokio::fs::write(dir.join("not-a-snapshot"), b"").await.unwrap();

        let ids = scan_snapshots(dir.to_str().unwrap()).await;
        assert_eq!(ids, vec!["snap_abc", "snap_def"]);

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn heartbeat_sends_via_channel() {
        let (tx, mut rx) = crate::events::channel(16);
        let config = Arc::new(NodeConfig {
            node_id: "node_test".to_string(),
            grpc_port: 50051,
            data_dir: "/tmp/sandchest-hb-test".to_string(),
            kernel_path: "/tmp/vmlinux".to_string(),
            control_plane_url: None,
            jailer: crate::jailer::JailerConfig::disabled(),
            s3: None,
        });
        let manager = Arc::new(SandboxManager::new(Arc::clone(&config)));

        // Spawn heartbeat — first tick fires immediately
        let handle = tokio::spawn(start_heartbeat(config, manager, tx));

        let msg = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("heartbeat should send within interval")
            .expect("channel should not be closed");

        match msg.event {
            Some(crate::proto::node_to_control::Event::Heartbeat(hb)) => {
                assert_eq!(hb.node_id, "node_test");
                assert_eq!(hb.slots_total, 256);
                assert_eq!(hb.slots_used, 0);
                assert!(hb.active_sandbox_ids.is_empty());
            }
            _ => panic!("expected Heartbeat event"),
        }

        handle.abort();
    }

    #[tokio::test]
    async fn scan_snapshots_empty_directory() {
        let dir = std::env::temp_dir().join("sandchest-empty-snapshots");
        let _ = tokio::fs::remove_dir_all(&dir).await;
        tokio::fs::create_dir_all(&dir).await.unwrap();

        let ids = scan_snapshots(dir.to_str().unwrap()).await;
        assert!(ids.is_empty());

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn scan_snapshots_returns_sorted() {
        let dir = std::env::temp_dir().join("sandchest-sorted-snapshots");
        let _ = tokio::fs::remove_dir_all(&dir).await;
        tokio::fs::create_dir_all(&dir).await.unwrap();
        // Create in reverse order
        tokio::fs::create_dir(dir.join("snap_z")).await.unwrap();
        tokio::fs::create_dir(dir.join("snap_a")).await.unwrap();
        tokio::fs::create_dir(dir.join("snap_m")).await.unwrap();

        let ids = scan_snapshots(dir.to_str().unwrap()).await;
        assert_eq!(ids, vec!["snap_a", "snap_m", "snap_z"]);

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn scan_snapshots_ignores_files_only() {
        let dir = std::env::temp_dir().join("sandchest-files-only-snapshots");
        let _ = tokio::fs::remove_dir_all(&dir).await;
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::write(dir.join("file1.txt"), b"").await.unwrap();
        tokio::fs::write(dir.join("file2.txt"), b"").await.unwrap();

        let ids = scan_snapshots(dir.to_str().unwrap()).await;
        assert!(ids.is_empty());

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn heartbeat_sends_multiple_ticks() {
        let (tx, mut rx) = crate::events::channel(16);
        let config = Arc::new(NodeConfig {
            node_id: "node_multi_tick".to_string(),
            grpc_port: 50051,
            data_dir: "/tmp/sandchest-hb-multi".to_string(),
            kernel_path: "/tmp/vmlinux".to_string(),
            control_plane_url: None,
            jailer: crate::jailer::JailerConfig::disabled(),
            s3: None,
        });
        let manager = Arc::new(SandboxManager::new(Arc::clone(&config)));

        let handle = tokio::spawn(start_heartbeat(config, manager, tx));

        // First tick (immediate)
        let msg1 = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            msg1.event,
            Some(crate::proto::node_to_control::Event::Heartbeat(_))
        ));

        handle.abort();
    }
}
