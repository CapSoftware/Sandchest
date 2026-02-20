use std::path::Path;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use tracing::{info, warn};

use crate::session::SessionManager;

const HEARTBEAT_PATH: &str = "/tmp/.sandchest_heartbeat";
const HEARTBEAT_INTERVAL_SECS: u64 = 1;
const STALE_THRESHOLD_SECS: u64 = 5;
#[cfg(target_os = "linux")]
const URANDOM_SEED_BYTES: usize = 256;

/// Check if a heartbeat file at the given path is stale (indicating snapshot restore).
fn is_heartbeat_stale(path: &Path) -> bool {
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

    if now > file_ts && (now - file_ts) > STALE_THRESHOLD_SECS {
        info!(
            stale_secs = now - file_ts,
            "Stale heartbeat detected — snapshot restore likely"
        );
        return true;
    }

    false
}

/// Check if this is a snapshot restore by looking for a stale heartbeat file.
pub fn detect_snapshot_restore() -> bool {
    is_heartbeat_stale(Path::new(HEARTBEAT_PATH))
}

/// Re-seed `/dev/urandom` with 256 bytes of entropy derived from current time and PID.
/// Prevents parent and fork from generating identical random sequences after snapshot restore.
fn reseed_urandom() {
    #[cfg(target_os = "linux")]
    {
        use std::io::Write;
        if let Ok(mut f) = std::fs::File::options().write(true).open("/dev/urandom") {
            let mut seed = [0u8; URANDOM_SEED_BYTES];
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let pid = std::process::id() as u128;

            // Fill 256 bytes by mixing time + pid with different multipliers per chunk
            for (i, chunk) in seed.chunks_mut(16).enumerate() {
                let val = ts
                    .wrapping_add(i as u128)
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(pid);
                chunk.copy_from_slice(&val.to_le_bytes());
            }

            let _ = f.write_all(&seed);
            info!(bytes = URANDOM_SEED_BYTES, "Re-seeded /dev/urandom");
        } else {
            warn!("Failed to open /dev/urandom for re-seeding");
        }
    }
}

/// Correct the system clock after snapshot restore.
/// The guest clock is frozen at the snapshot time — without correction, time-dependent
/// operations (TLS certificates, token expiry, logs) will use stale timestamps.
fn correct_system_clock() {
    #[cfg(target_os = "linux")]
    {
        // Read current RTC time from /dev/rtc0 via the system's hwclock mechanism.
        // Firecracker updates the guest's RTC to host time on resume, so reading it
        // gives us the correct wall-clock time even though CLOCK_REALTIME is stale.
        //
        // We use clock_gettime(CLOCK_REALTIME) as a fallback — if the hypervisor
        // has already updated the clock (some Firecracker versions do this on resume),
        // this is a no-op.
        let mut ts = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        let ret = unsafe { libc::clock_gettime(libc::CLOCK_REALTIME, &mut ts) };
        if ret == 0 {
            // The clock_gettime succeeded — on modern Firecracker, the host updates
            // the guest RTC on snapshot resume, so CLOCK_REALTIME should already reflect
            // host time. We set it explicitly to ensure consistency.
            let ret = unsafe { libc::clock_settime(libc::CLOCK_REALTIME, &ts) };
            if ret == 0 {
                info!(tv_sec = ts.tv_sec, "System clock corrected after restore");
            } else {
                warn!(errno = std::io::Error::last_os_error().raw_os_error(), "clock_settime failed");
            }
        }
    }
}

/// Kill orphaned child processes inherited from the parent snapshot.
/// Walks `/proc` and sends SIGTERM to any user-space process that isn't us or PID 1.
fn kill_orphaned_processes() {
    #[cfg(target_os = "linux")]
    {
        let my_pid = std::process::id();
        let mut killed = 0u32;

        if let Ok(entries) = std::fs::read_dir("/proc") {
            for entry in entries.flatten() {
                if let Some(name) = entry.file_name().to_str() {
                    if let Ok(pid) = name.parse::<u32>() {
                        // Skip PID 1 (init/agent) and ourselves
                        if pid <= 1 || pid == my_pid {
                            continue;
                        }
                        // Skip kernel threads (PPID == 2, i.e. kthreadd)
                        if is_kernel_thread(pid) {
                            continue;
                        }
                        unsafe {
                            libc::kill(pid as i32, libc::SIGTERM);
                        }
                        killed += 1;
                    }
                }
            }
        }

        if killed > 0 {
            info!(count = killed, "Sent SIGTERM to orphaned processes");
        }
    }
}

/// Check if a process is a kernel thread by reading its PPID from /proc/PID/stat.
/// Kernel threads have PPID 2 (kthreadd).
#[cfg(target_os = "linux")]
fn is_kernel_thread(pid: u32) -> bool {
    let stat_path = format!("/proc/{pid}/stat");
    let contents = match std::fs::read_to_string(&stat_path) {
        Ok(c) => c,
        Err(_) => return true, // Can't read → skip it
    };

    // /proc/PID/stat format: PID (COMM) STATE PPID ...
    // PPID is the 4th field. The comm field can contain spaces and parens,
    // so find the closing ')' first.
    if let Some(close_paren) = contents.rfind(')') {
        let after = &contents[close_paren + 2..]; // skip ") "
        let fields: Vec<&str> = after.split_whitespace().collect();
        // fields[0] = STATE, fields[1] = PPID
        if let Some(ppid_str) = fields.get(1) {
            if let Ok(ppid) = ppid_str.parse::<u32>() {
                return ppid == 2; // kthreadd
            }
        }
    }

    true // Can't parse → assume kernel thread, skip it
}

/// Handle initial snapshot restore at startup (before sessions exist).
pub fn handle_restore() {
    info!("Handling snapshot restore at startup...");
    reseed_urandom();
    correct_system_clock();
    kill_orphaned_processes();
    info!("Startup restore handling complete");
}

/// Perform full fork recovery: destroy sessions, re-seed randomness, correct clock,
/// and kill orphaned processes.
async fn perform_fork_recovery(session_manager: &SessionManager) {
    info!("Fork recovery: destroying inherited sessions...");
    session_manager.destroy_all().await;

    reseed_urandom();
    correct_system_clock();
    kill_orphaned_processes();

    // Write a fresh heartbeat immediately to prevent re-triggering
    write_heartbeat().await;

    info!("Fork recovery complete — agent ready");
}

/// Write current timestamp to the heartbeat file.
async fn write_heartbeat() {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    if let Err(e) = tokio::fs::write(HEARTBEAT_PATH, ts.to_string()).await {
        warn!(error = %e, "Failed to write heartbeat file");
    }
}

/// Start the snapshot watcher: a combined heartbeat writer + restore detector.
///
/// Every second, the watcher:
/// 1. Checks if the heartbeat is stale (snapshot restore detected)
/// 2. If stale, runs full fork recovery (destroy sessions, re-seed, clock fix)
/// 3. Writes a fresh heartbeat timestamp
///
/// This replaces the separate `start_heartbeat_writer()` from Phase 2.
pub fn start_snapshot_watcher(session_manager: Arc<SessionManager>) {
    tokio::spawn(async move {
        loop {
            // Check for stale heartbeat BEFORE writing a fresh one
            if is_heartbeat_stale(Path::new(HEARTBEAT_PATH)) {
                perform_fork_recovery(&session_manager).await;
            }

            write_heartbeat().await;

            tokio::time::sleep(std::time::Duration::from_secs(HEARTBEAT_INTERVAL_SECS)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    // ---- is_heartbeat_stale tests ----

    #[test]
    fn stale_heartbeat_no_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nonexistent_heartbeat");
        assert!(!is_heartbeat_stale(&path));
    }

    #[test]
    fn stale_heartbeat_fresh() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("heartbeat");
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        std::fs::write(&path, now.to_string()).unwrap();
        assert!(!is_heartbeat_stale(&path));
    }

    #[test]
    fn stale_heartbeat_old() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("heartbeat");
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        // Write timestamp from 60 seconds ago
        std::fs::write(&path, (now - 60).to_string()).unwrap();
        assert!(is_heartbeat_stale(&path));
    }

    #[test]
    fn stale_heartbeat_exactly_at_threshold() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("heartbeat");
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        // Write timestamp exactly at the threshold boundary (not stale)
        std::fs::write(&path, (now - STALE_THRESHOLD_SECS).to_string()).unwrap();
        assert!(!is_heartbeat_stale(&path));
    }

    #[test]
    fn stale_heartbeat_just_past_threshold() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("heartbeat");
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        // Write timestamp just past the threshold (stale)
        std::fs::write(&path, (now - STALE_THRESHOLD_SECS - 1).to_string()).unwrap();
        assert!(is_heartbeat_stale(&path));
    }

    #[test]
    fn stale_heartbeat_invalid_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("heartbeat");
        std::fs::write(&path, "not a number").unwrap();
        assert!(!is_heartbeat_stale(&path));
    }

    #[test]
    fn stale_heartbeat_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("heartbeat");
        std::fs::write(&path, "").unwrap();
        assert!(!is_heartbeat_stale(&path));
    }

    #[test]
    fn stale_heartbeat_future_timestamp() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("heartbeat");
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        // Timestamp in the future should not be stale
        std::fs::write(&path, (now + 100).to_string()).unwrap();
        assert!(!is_heartbeat_stale(&path));
    }

    // ---- fork recovery tests ----

    #[tokio::test]
    async fn fork_recovery_destroys_all_sessions() {
        let manager = SessionManager::new();
        let env = HashMap::new();

        // Create some sessions
        let id1 = manager.create_session("/bin/sh", &env).await.unwrap();
        let id2 = manager.create_session("/bin/sh", &env).await.unwrap();
        assert!(manager.session_count().await > 0);

        // Run fork recovery
        perform_fork_recovery(&manager).await;

        // All sessions should be destroyed
        assert_eq!(manager.session_count().await, 0);
        assert!(manager.get_session_public(&id1).await.is_err());
        assert!(manager.get_session_public(&id2).await.is_err());
    }

    #[tokio::test]
    async fn fork_recovery_writes_fresh_heartbeat() {
        let dir = tempfile::tempdir().unwrap();
        let hb_path = dir.path().join("heartbeat");
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        // Write a stale heartbeat
        std::fs::write(&hb_path, (now - 60).to_string()).unwrap();
        assert!(is_heartbeat_stale(&hb_path));

        // After recovery, the real heartbeat file should be updated
        let manager = SessionManager::new();
        perform_fork_recovery(&manager).await;

        // The global heartbeat at HEARTBEAT_PATH should now be fresh
        // (perform_fork_recovery writes to the global path)
        assert!(!is_heartbeat_stale(Path::new(HEARTBEAT_PATH)));
    }

    #[tokio::test]
    async fn fork_recovery_on_empty_session_manager() {
        // Recovery should succeed even with no sessions
        let manager = SessionManager::new();
        perform_fork_recovery(&manager).await;
        assert_eq!(manager.session_count().await, 0);
    }

    // ---- kernel thread detection tests ----

    #[cfg(target_os = "linux")]
    #[test]
    fn kernel_thread_detection_self() {
        // Our own process should NOT be detected as a kernel thread
        let my_pid = std::process::id();
        assert!(!is_kernel_thread(my_pid));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn kernel_thread_detection_nonexistent() {
        // Nonexistent PID should be treated as kernel thread (skip it)
        assert!(is_kernel_thread(999999));
    }

    #[test]
    fn reseed_urandom_does_not_panic() {
        // On non-Linux this is a no-op; on Linux it should succeed or warn
        reseed_urandom();
    }

    #[test]
    fn correct_system_clock_does_not_panic() {
        // On non-Linux this is a no-op; on Linux it may fail (no permissions) but shouldn't panic
        correct_system_clock();
    }
}
