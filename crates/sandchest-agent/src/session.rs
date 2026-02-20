use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::{mpsc, Mutex, RwLock};
use tokio_stream::wrappers::ReceiverStream;
use tonic::Status;
use tracing::{debug, warn};

use crate::proto::{exec_event, ExecEvent, ExitEvent};

const CHUNK_SIZE: usize = 8192;
const MAX_SESSIONS: usize = 5;
const SENTINEL_PREFIX: &str = "__SC_SENTINEL_";
const SENTINEL_SUFFIX: &str = "__";

/// Manages active shell sessions.
pub struct SessionManager {
    sessions: RwLock<HashMap<String, Arc<Session>>>,
    next_id: AtomicU64,
}

struct Session {
    master_fd: RawFdWrapper,
    child_pid: u32,
    /// Only one exec at a time per session.
    exec_lock: Mutex<()>,
}

/// Wrapper around OwnedFd that implements Send + Sync for use with tokio.
struct RawFdWrapper {
    fd: OwnedFd,
}

// SAFETY: The OwnedFd is only accessed through controlled read/write calls
// and is protected by the session exec_lock mutex during command execution.
unsafe impl Send for RawFdWrapper {}
unsafe impl Sync for RawFdWrapper {}

impl AsRawFd for RawFdWrapper {
    fn as_raw_fd(&self) -> std::os::fd::RawFd {
        self.fd.as_raw_fd()
    }
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        }
    }

    pub async fn create_session(
        &self,
        shell: &str,
        env: &HashMap<String, String>,
    ) -> Result<String, Status> {
        let sessions = self.sessions.read().await;
        if sessions.len() >= MAX_SESSIONS {
            return Err(Status::resource_exhausted(format!(
                "maximum {MAX_SESSIONS} concurrent sessions reached"
            )));
        }
        drop(sessions);

        let shell = if shell.is_empty() { "/bin/bash" } else { shell };
        let (master_fd, child_pid) = spawn_shell(shell, env)?;

        let id_num = self.next_id.fetch_add(1, Ordering::Relaxed);
        let session_id = format!("sess_{id_num:04}");

        let session = Arc::new(Session {
            master_fd: RawFdWrapper { fd: master_fd },
            child_pid,
            exec_lock: Mutex::new(()),
        });

        self.sessions
            .write()
            .await
            .insert(session_id.clone(), session);

        debug!(session_id, child_pid, shell, "created session");
        Ok(session_id)
    }

    pub async fn spawn_session_exec(
        &self,
        session_id: &str,
        cmd: String,
        timeout_seconds: u32,
    ) -> Result<ReceiverStream<Result<ExecEvent, Status>>, Status> {
        let session = self.get_session(session_id).await?;
        let (tx, rx) = mpsc::channel(32);
        tokio::spawn(run_session_exec(session, cmd, timeout_seconds, tx));
        Ok(ReceiverStream::new(rx))
    }

    pub async fn session_input(&self, session_id: &str, data: &[u8]) -> Result<(), Status> {
        let session = self.get_session(session_id).await?;
        let fd = session.master_fd.as_raw_fd();

        let data = data.to_vec();
        tokio::task::spawn_blocking(move || {
            let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
            let result = file.write_all(&data);
            // Prevent File from closing the fd on drop — we don't own it here.
            std::mem::forget(file);
            result.map_err(|e| Status::internal(format!("failed to write to session: {e}")))
        })
        .await
        .map_err(|e| Status::internal(format!("spawn_blocking failed: {e}")))?
    }

    pub async fn destroy_session(&self, session_id: &str) -> Result<(), Status> {
        let session = self
            .sessions
            .write()
            .await
            .remove(session_id)
            .ok_or_else(|| Status::not_found(format!("session {session_id} not found")))?;

        let pid = session.child_pid as i32;
        debug!(session_id, pid, "destroying session");

        // SIGHUP to process group
        #[cfg(unix)]
        unsafe {
            // Send SIGHUP to the process group (negative pid)
            libc::kill(-pid, libc::SIGHUP);
        }

        // Wait up to 5 seconds for exit, then SIGKILL
        let kill_pid = pid;
        tokio::task::spawn_blocking(move || {
            let start = Instant::now();
            loop {
                #[cfg(unix)]
                {
                    let ret = unsafe { libc::waitpid(kill_pid, std::ptr::null_mut(), libc::WNOHANG) };
                    if ret != 0 {
                        return;
                    }
                }
                if start.elapsed() > Duration::from_secs(5) {
                    warn!(pid = kill_pid, "session shell did not exit after SIGHUP, sending SIGKILL");
                    #[cfg(unix)]
                    unsafe {
                        libc::kill(-kill_pid, libc::SIGKILL);
                        libc::waitpid(kill_pid, std::ptr::null_mut(), 0);
                    }
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        })
        .await
        .map_err(|e| Status::internal(format!("spawn_blocking failed: {e}")))?;

        Ok(())
    }

    /// Destroy all active sessions. Used during shutdown.
    pub async fn destroy_all(&self) {
        let ids: Vec<String> = self.sessions.read().await.keys().cloned().collect();
        for id in ids {
            if let Err(e) = self.destroy_session(&id).await {
                warn!(session_id = %id, error = %e, "failed to destroy session during shutdown");
            }
        }
    }

    async fn get_session(&self, session_id: &str) -> Result<Arc<Session>, Status> {
        self.sessions
            .read()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| Status::not_found(format!("session {session_id} not found")))
    }
}

/// Spawn a shell process attached to a PTY. Returns (master_fd, child_pid).
#[allow(clippy::result_large_err)]
fn spawn_shell(
    shell: &str,
    env: &HashMap<String, String>,
) -> Result<(OwnedFd, u32), Status> {
    // Open a PTY pair
    let pty = nix::pty::openpty(None, None)
        .map_err(|e| Status::internal(format!("openpty failed: {e}")))?;

    let slave_raw = pty.slave.as_raw_fd();

    let mut cmd = Command::new(shell);
    cmd.arg("--norc").arg("--noprofile"); // Clean shell, avoid rc files interfering with sentinel

    for (key, value) in env {
        cmd.env(key, value);
    }
    // Set a basic prompt to avoid interference
    cmd.env("PS1", "");
    cmd.env("PS2", "");
    cmd.env("TERM", "dumb");

    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(move || {
            // Create new session and set controlling terminal
            libc::setsid();
            libc::ioctl(slave_raw, libc::TIOCSCTTY as _, 0);

            // Redirect stdio to the slave PTY
            libc::dup2(slave_raw, 0);
            libc::dup2(slave_raw, 1);
            libc::dup2(slave_raw, 2);
            if slave_raw > 2 {
                libc::close(slave_raw);
            }
            Ok(())
        });
    }

    let child = cmd
        .spawn()
        .map_err(|e| Status::internal(format!("failed to spawn shell: {e}")))?;

    let child_pid = child.id();

    // Close slave in parent — child has its own copy
    drop(pty.slave);

    // Set master to non-blocking for async reads
    #[cfg(unix)]
    {
        use nix::fcntl::{fcntl, FcntlArg, OFlag};
        let flags = fcntl(pty.master.as_raw_fd(), FcntlArg::F_GETFL)
            .map_err(|e| Status::internal(format!("fcntl F_GETFL failed: {e}")))?;
        fcntl(
            pty.master.as_raw_fd(),
            FcntlArg::F_SETFL(OFlag::from_bits_truncate(flags) | OFlag::O_NONBLOCK),
        )
        .map_err(|e| Status::internal(format!("fcntl F_SETFL failed: {e}")))?;
    }

    // Forget the child handle — we manage the process via pid/signals directly.
    std::mem::forget(child);

    Ok((pty.master, child_pid))
}

/// Execute a command in an existing session, streaming output until the sentinel.
async fn run_session_exec(
    session: Arc<Session>,
    cmd: String,
    timeout_seconds: u32,
    tx: mpsc::Sender<Result<ExecEvent, Status>>,
) {
    // Try to acquire exec lock (only one exec at a time)
    let _exec_guard = match session.exec_lock.try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            let _ = tx
                .send(Err(Status::already_exists(
                    "another exec is already running on this session",
                )))
                .await;
            return;
        }
    };

    let start = Instant::now();
    let mut seq: u64 = 0;

    // Build the sentinel-wrapped command
    let sentinel_seq = start.elapsed().as_nanos(); // unique per exec
    let sentinel_marker = format!("{SENTINEL_PREFIX}{sentinel_seq}_");
    let wrapped_cmd = format!(
        "{cmd}; __sc_exit=$?; echo \"{sentinel_marker}${{__sc_exit}}{SENTINEL_SUFFIX}\"\n"
    );

    // Write command to session
    let fd = session.master_fd.as_raw_fd();
    let write_data = wrapped_cmd.into_bytes();
    let write_result = tokio::task::spawn_blocking(move || {
        let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
        let result = file.write_all(&write_data);
        std::mem::forget(file);
        result
    })
    .await;

    match write_result {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            let _ = tx
                .send(Err(Status::internal(format!(
                    "failed to write command to session: {e}"
                ))))
                .await;
            return;
        }
        Err(e) => {
            let _ = tx
                .send(Err(Status::internal(format!("spawn_blocking failed: {e}"))))
                .await;
            return;
        }
    }

    // Read output until we find the sentinel
    let deadline = if timeout_seconds > 0 {
        Some(Instant::now() + Duration::from_secs(timeout_seconds as u64))
    } else {
        None
    };

    let mut pending_buf = Vec::new();
    let master_raw = session.master_fd.as_raw_fd();

    loop {
        // Check timeout
        if let Some(dl) = deadline {
            if Instant::now() > dl {
                warn!(sentinel_seq, "session exec timed out");
                seq += 1;
                let _ = tx
                    .send(Ok(ExecEvent {
                        seq,
                        event: Some(exec_event::Event::Exit(ExitEvent {
                            exit_code: -1,
                            cpu_ms: 0,
                            peak_memory_bytes: 0,
                            duration_ms: start.elapsed().as_millis() as u64,
                        })),
                    }))
                    .await;
                return;
            }
        }

        // Read from master fd (non-blocking via spawn_blocking with short timeout)
        let read_result = tokio::task::spawn_blocking(move || {
            let mut buf = [0u8; CHUNK_SIZE];
            let mut file = unsafe { std::fs::File::from_raw_fd(master_raw) };
            let result = file.read(&mut buf);
            std::mem::forget(file);
            match result {
                Ok(n) => Ok(buf[..n].to_vec()),
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => Ok(Vec::new()),
                Err(e) => Err(e),
            }
        })
        .await;

        let data = match read_result {
            Ok(Ok(data)) => data,
            Ok(Err(e)) => {
                // EIO typically means the child process exited and the pty slave is closed
                if e.raw_os_error() == Some(libc::EIO) {
                    seq += 1;
                    let _ = tx
                        .send(Ok(ExecEvent {
                            seq,
                            event: Some(exec_event::Event::Exit(ExitEvent {
                                exit_code: -1,
                                cpu_ms: 0,
                                peak_memory_bytes: 0,
                                duration_ms: start.elapsed().as_millis() as u64,
                            })),
                        }))
                        .await;
                    return;
                }
                warn!("session read error: {e}");
                let _ = tx
                    .send(Err(Status::internal(format!("read error: {e}"))))
                    .await;
                return;
            }
            Err(e) => {
                let _ = tx
                    .send(Err(Status::internal(format!("spawn_blocking failed: {e}"))))
                    .await;
                return;
            }
        };

        if data.is_empty() {
            // No data available yet, wait briefly before retrying
            tokio::time::sleep(Duration::from_millis(10)).await;
            continue;
        }

        pending_buf.extend_from_slice(&data);

        // Check for sentinel in the accumulated buffer
        if let Some((output, exit_code)) = extract_sentinel(&pending_buf, &sentinel_marker) {
            // Send any remaining output before the sentinel
            if !output.is_empty() {
                // Strip the echoed command from the beginning of output
                let clean_output = strip_command_echo(&output, &cmd);
                if !clean_output.is_empty() {
                    seq += 1;
                    let _ = tx
                        .send(Ok(ExecEvent {
                            seq,
                            event: Some(exec_event::Event::Stdout(clean_output)),
                        }))
                        .await;
                }
            }

            // Send exit event
            seq += 1;
            let _ = tx
                .send(Ok(ExecEvent {
                    seq,
                    event: Some(exec_event::Event::Exit(ExitEvent {
                        exit_code,
                        cpu_ms: 0,
                        peak_memory_bytes: 0,
                        duration_ms: start.elapsed().as_millis() as u64,
                    })),
                }))
                .await;
            return;
        }

        // Send output accumulated so far (but keep potential partial sentinel)
        let safe_len = if pending_buf.len() > 256 {
            // Keep last 256 bytes in case sentinel spans chunks
            pending_buf.len() - 256
        } else {
            0
        };

        if safe_len > 0 {
            let to_send = pending_buf[..safe_len].to_vec();
            pending_buf.drain(..safe_len);

            // Strip command echo from first chunk
            let clean = strip_command_echo(&to_send, &cmd);
            if !clean.is_empty() {
                seq += 1;
                if tx
                    .send(Ok(ExecEvent {
                        seq,
                        event: Some(exec_event::Event::Stdout(clean)),
                    }))
                    .await
                    .is_err()
                {
                    return;
                }
            }
        }
    }
}

/// Look for the sentinel pattern in the buffer. Returns (output_before_sentinel, exit_code).
fn extract_sentinel(buf: &[u8], sentinel_marker: &str) -> Option<(Vec<u8>, i32)> {
    let buf_str = String::from_utf8_lossy(buf);
    let marker_pos = buf_str.find(sentinel_marker)?;

    let after_marker = &buf_str[marker_pos + sentinel_marker.len()..];
    let suffix_pos = after_marker.find(SENTINEL_SUFFIX)?;
    let exit_code_str = &after_marker[..suffix_pos];
    let exit_code: i32 = exit_code_str.parse().unwrap_or(-1);

    let output = buf[..marker_pos].to_vec();
    Some((output, exit_code))
}

/// Strip the echoed command line from PTY output.
/// PTYs echo input back, so the first line(s) of output contain the command we typed.
fn strip_command_echo(output: &[u8], cmd: &str) -> Vec<u8> {
    let output_str = String::from_utf8_lossy(output);

    // The PTY echoes the full wrapped command. Try to find and skip past it.
    // Look for the first newline after the command echo.
    if let Some(pos) = output_str.find("__sc_exit=$?;") {
        // Find the end of the echo line
        if let Some(nl) = output_str[pos..].find('\n') {
            let after = &output[pos + nl + 1..];
            return after.to_vec();
        }
    }

    // Fallback: if the output starts with the command, strip the first line
    if output_str.trim_start().starts_with(cmd.trim()) {
        if let Some(nl) = output_str.find('\n') {
            return output[nl + 1..].to_vec();
        }
    }

    output.to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_sentinel_found() {
        let marker = "__SC_SENTINEL_123_";
        let buf = b"hello world\n__SC_SENTINEL_123_0__\n";
        let (output, code) = extract_sentinel(buf, marker).unwrap();
        assert_eq!(String::from_utf8_lossy(&output), "hello world\n");
        assert_eq!(code, 0);
    }

    #[test]
    fn test_extract_sentinel_nonzero_exit() {
        let marker = "__SC_SENTINEL_456_";
        let buf = b"error output\n__SC_SENTINEL_456_42__\n";
        let (output, code) = extract_sentinel(buf, marker).unwrap();
        assert_eq!(String::from_utf8_lossy(&output), "error output\n");
        assert_eq!(code, 42);
    }

    #[test]
    fn test_extract_sentinel_not_found() {
        let marker = "__SC_SENTINEL_123_";
        let buf = b"hello world\nstill going...";
        assert!(extract_sentinel(buf, marker).is_none());
    }

    #[test]
    fn test_extract_sentinel_partial() {
        let marker = "__SC_SENTINEL_123_";
        let buf = b"output\n__SC_SENTINEL_123_";
        // Sentinel suffix not yet received
        assert!(extract_sentinel(buf, marker).is_none());
    }
}
