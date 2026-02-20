use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use tracing::{info, warn};

const HEARTBEAT_PATH: &str = "/tmp/.sandchest_heartbeat";
const HEARTBEAT_INTERVAL_SECS: u64 = 1;
const STALE_THRESHOLD_SECS: u64 = 5;

/// Check if this is a snapshot restore by looking for a stale heartbeat file.
/// Returns true if a restore was detected.
pub fn detect_snapshot_restore() -> bool {
    let path = Path::new(HEARTBEAT_PATH);
    if !path.exists() {
        return false;
    }

    let contents = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return false,
    };

    let file_ts: u64 = match contents.trim().parse() {
        Ok(ts) => ts,
        Err(_) => return false,
    };

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    // If the heartbeat is older than the threshold, this is likely a snapshot restore
    if now > file_ts && (now - file_ts) > STALE_THRESHOLD_SECS {
        info!(
            stale_secs = now - file_ts,
            "Stale heartbeat detected — snapshot restore likely"
        );
        return true;
    }

    false
}

/// Handle post-snapshot-restore tasks.
pub fn handle_restore() {
    info!("Handling snapshot restore...");

    // Re-seed /dev/urandom to avoid duplicate random sequences across forks
    #[cfg(target_os = "linux")]
    {
        use std::io::Write;
        if let Ok(mut f) = std::fs::File::options().write(true).open("/dev/urandom") {
            let seed: [u8; 32] = {
                let mut buf = [0u8; 32];
                // Use current time + pid as entropy source
                let ts = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos();
                let pid = std::process::id() as u128;
                let combined = ts ^ pid;
                buf[..16].copy_from_slice(&combined.to_le_bytes());
                buf[16..].copy_from_slice(&combined.wrapping_mul(6364136223846793005).to_le_bytes());
                buf
            };
            let _ = f.write_all(&seed);
            info!("Re-seeded /dev/urandom");
        } else {
            warn!("Failed to re-seed /dev/urandom");
        }
    }
}

/// Start the periodic heartbeat file writer.
/// Writes the current unix timestamp to HEARTBEAT_PATH every second.
pub fn start_heartbeat_writer() {
    tokio::spawn(async {
        loop {
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();

            if let Err(e) = tokio::fs::write(HEARTBEAT_PATH, ts.to_string()).await {
                warn!(error = %e, "Failed to write heartbeat file");
            }

            tokio::time::sleep(std::time::Duration::from_secs(HEARTBEAT_INTERVAL_SECS)).await;
        }
    });
}
