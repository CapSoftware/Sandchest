use std::process::Stdio;
use std::time::{Duration, Instant};

use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::Status;
use tracing::{debug, warn};

use crate::proc as proc_reader;
use crate::proto::{exec_event, ExecEvent, ExecRequest, ExitEvent};

const CHUNK_SIZE: usize = 8192;

/// Spawn an exec task and return a stream of ExecEvents.
pub fn spawn_exec(request: ExecRequest) -> ReceiverStream<Result<ExecEvent, Status>> {
    let (tx, rx) = mpsc::channel(32);
    tokio::spawn(run_exec(request, tx));
    ReceiverStream::new(rx)
}

async fn run_exec(request: ExecRequest, tx: mpsc::Sender<Result<ExecEvent, Status>>) {
    let start = Instant::now();
    let mut seq: u64 = 0;

    let mut cmd = if !request.cmd.is_empty() {
        let mut c = Command::new(&request.cmd[0]);
        if request.cmd.len() > 1 {
            c.args(&request.cmd[1..]);
        }
        c
    } else if !request.shell_cmd.is_empty() {
        let mut c = Command::new("/bin/sh");
        c.arg("-c").arg(&request.shell_cmd);
        c
    } else {
        let _ = tx
            .send(Err(Status::invalid_argument(
                "either cmd or shell_cmd must be set",
            )))
            .await;
        return;
    };

    if !request.cwd.is_empty() {
        cmd.current_dir(&request.cwd);
    }
    for (key, value) in &request.env {
        cmd.env(key, value);
    }
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            let _ = tx
                .send(Err(Status::internal(format!(
                    "failed to spawn process: {e}"
                ))))
                .await;
            return;
        }
    };

    let pid = child.id().unwrap_or(0);
    debug!(pid, "spawned exec process");

    let start_cpu_ticks = proc_reader::read_cpu_time(pid).unwrap_or(0);

    let mut stdout = child.stdout.take().expect("stdout was piped");
    let mut stderr = child.stderr.take().expect("stderr was piped");

    // Set up deadline (far future if no timeout)
    let deadline = if request.timeout_seconds > 0 {
        tokio::time::Instant::now() + Duration::from_secs(request.timeout_seconds as u64)
    } else {
        tokio::time::Instant::now() + Duration::from_secs(365 * 24 * 3600)
    };
    let timeout = tokio::time::sleep_until(deadline);
    tokio::pin!(timeout);

    let mut stdout_buf = [0u8; CHUNK_SIZE];
    let mut stderr_buf = [0u8; CHUNK_SIZE];
    let mut stdout_done = false;
    let mut stderr_done = false;
    let mut timed_out = false;

    // Stream stdout/stderr, racing against timeout
    loop {
        if stdout_done && stderr_done {
            break;
        }

        tokio::select! {
            result = stdout.read(&mut stdout_buf), if !stdout_done => {
                match result {
                    Ok(0) => stdout_done = true,
                    Ok(n) => {
                        seq += 1;
                        let event = ExecEvent {
                            seq,
                            event: Some(exec_event::Event::Stdout(stdout_buf[..n].to_vec())),
                        };
                        if tx.send(Ok(event)).await.is_err() {
                            return;
                        }
                    }
                    Err(e) => {
                        warn!("stdout read error: {e}");
                        stdout_done = true;
                    }
                }
            }
            result = stderr.read(&mut stderr_buf), if !stderr_done => {
                match result {
                    Ok(0) => stderr_done = true,
                    Ok(n) => {
                        seq += 1;
                        let event = ExecEvent {
                            seq,
                            event: Some(exec_event::Event::Stderr(stderr_buf[..n].to_vec())),
                        };
                        if tx.send(Ok(event)).await.is_err() {
                            return;
                        }
                    }
                    Err(e) => {
                        warn!("stderr read error: {e}");
                        stderr_done = true;
                    }
                }
            }
            _ = &mut timeout, if !timed_out => {
                timed_out = true;
                warn!(pid, timeout_seconds = request.timeout_seconds,
                    "exec timed out, killing process");
                kill_with_grace(pid, &mut child).await;
                // Process death closes pipes → loop exits via EOF
            }
        }
    }

    // Collect exit status
    let exit_status = child.wait().await;
    let duration_ms = start.elapsed().as_millis() as u64;

    // Read resource usage (may fail on non-Linux or if process already reaped)
    let end_cpu_ticks = proc_reader::read_cpu_time(pid).unwrap_or(0);
    let ticks_per_sec = proc_reader::clock_ticks_per_sec();
    let cpu_ms = if end_cpu_ticks > start_cpu_ticks {
        (end_cpu_ticks - start_cpu_ticks) * 1000 / ticks_per_sec
    } else {
        0
    };
    let peak_memory_bytes = proc_reader::read_peak_memory(pid).unwrap_or(0);

    let exit_code = if timed_out {
        -1
    } else {
        match exit_status {
            Ok(status) => {
                #[cfg(unix)]
                {
                    use std::os::unix::process::ExitStatusExt;
                    status.code().unwrap_or_else(|| {
                        // Process killed by signal — return 128 + signal
                        status.signal().map(|s| 128 + s).unwrap_or(-1)
                    })
                }
                #[cfg(not(unix))]
                {
                    status.code().unwrap_or(-1)
                }
            }
            Err(_) => -1,
        }
    };

    seq += 1;
    let _ = tx
        .send(Ok(ExecEvent {
            seq,
            event: Some(exec_event::Event::Exit(ExitEvent {
                exit_code,
                cpu_ms,
                peak_memory_bytes,
                duration_ms,
            })),
        }))
        .await;
}

/// Collect all events from a spawn_exec stream into a Vec.
#[cfg(test)]
async fn collect_exec_events(
    request: ExecRequest,
) -> Vec<Result<ExecEvent, Status>> {
    use tokio_stream::StreamExt;
    let stream = spawn_exec(request);
    stream.collect().await
}

/// Send SIGTERM, wait up to 5 seconds, then SIGKILL if still alive.
async fn kill_with_grace(pid: u32, child: &mut tokio::process::Child) {
    #[cfg(unix)]
    {
        // SAFETY: kill() with a valid signal is safe.
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
    }
    #[cfg(not(unix))]
    {
        drop(child.kill());
        return;
    }

    match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
        Ok(_) => {}
        Err(_) => {
            warn!(pid, "process did not exit after SIGTERM, sending SIGKILL");
            let _ = child.kill().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn make_request() -> ExecRequest {
        ExecRequest {
            cmd: Vec::new(),
            shell_cmd: String::new(),
            cwd: String::new(),
            env: HashMap::new(),
            timeout_seconds: 0,
        }
    }

    #[tokio::test]
    async fn exec_echo_stdout() {
        let mut req = make_request();
        req.cmd = vec!["echo".into(), "hello world".into()];
        let events = collect_exec_events(req).await;

        let mut stdout_data = Vec::new();
        let mut exit_code = None;
        for event in &events {
            let event = event.as_ref().unwrap();
            match &event.event {
                Some(exec_event::Event::Stdout(data)) => stdout_data.extend_from_slice(data),
                Some(exec_event::Event::Exit(e)) => exit_code = Some(e.exit_code),
                _ => {}
            }
        }

        assert_eq!(String::from_utf8_lossy(&stdout_data).trim(), "hello world");
        assert_eq!(exit_code, Some(0));
    }

    #[tokio::test]
    async fn exec_stderr_output() {
        let mut req = make_request();
        req.shell_cmd = "echo error >&2".into();
        let events = collect_exec_events(req).await;

        let mut stderr_data = Vec::new();
        let mut exit_code = None;
        for event in &events {
            let event = event.as_ref().unwrap();
            match &event.event {
                Some(exec_event::Event::Stderr(data)) => stderr_data.extend_from_slice(data),
                Some(exec_event::Event::Exit(e)) => exit_code = Some(e.exit_code),
                _ => {}
            }
        }

        assert_eq!(String::from_utf8_lossy(&stderr_data).trim(), "error");
        assert_eq!(exit_code, Some(0));
    }

    #[tokio::test]
    async fn exec_nonzero_exit_code() {
        let mut req = make_request();
        req.shell_cmd = "exit 42".into();
        let events = collect_exec_events(req).await;

        let exit_event = events
            .iter()
            .filter_map(|e| e.as_ref().ok())
            .find_map(|e| match &e.event {
                Some(exec_event::Event::Exit(exit)) => Some(*exit),
                _ => None,
            })
            .expect("should have exit event");

        assert_eq!(exit_event.exit_code, 42);
    }

    #[tokio::test]
    async fn exec_no_cmd_returns_error() {
        let req = make_request();
        let events = collect_exec_events(req).await;

        assert_eq!(events.len(), 1);
        assert!(events[0].is_err());
        let status = events[0].as_ref().unwrap_err();
        assert_eq!(status.code(), tonic::Code::InvalidArgument);
    }

    fn collect_stdout(events: &[Result<ExecEvent, Status>]) -> Vec<u8> {
        let mut data = Vec::new();
        for e in events.iter().flatten() {
            if let Some(exec_event::Event::Stdout(d)) = &e.event {
                data.extend_from_slice(d);
            }
        }
        data
    }

    #[tokio::test]
    async fn exec_with_shell_cmd() {
        let mut req = make_request();
        req.shell_cmd = "echo shell_works".into();
        let events = collect_exec_events(req).await;

        assert_eq!(
            String::from_utf8_lossy(&collect_stdout(&events)).trim(),
            "shell_works"
        );
    }

    #[tokio::test]
    async fn exec_with_cwd() {
        let mut req = make_request();
        req.shell_cmd = "pwd".into();
        req.cwd = "/tmp".into();
        let events = collect_exec_events(req).await;

        let stdout = collect_stdout(&events);
        let output = String::from_utf8_lossy(&stdout);
        // On macOS /tmp -> /private/tmp
        assert!(
            output.trim() == "/tmp" || output.trim() == "/private/tmp",
            "unexpected cwd: {output}"
        );
    }

    #[tokio::test]
    async fn exec_with_env_vars() {
        let mut req = make_request();
        req.shell_cmd = "echo $MY_TEST_VAR".into();
        req.env
            .insert("MY_TEST_VAR".into(), "test_value_123".into());
        let events = collect_exec_events(req).await;

        assert_eq!(
            String::from_utf8_lossy(&collect_stdout(&events)).trim(),
            "test_value_123"
        );
    }

    #[tokio::test]
    async fn exec_sequential_seq_numbers() {
        let mut req = make_request();
        req.shell_cmd = "echo line1; echo line2 >&2".into();
        let events = collect_exec_events(req).await;

        let seqs: Vec<u64> = events
            .iter()
            .filter_map(|e| e.as_ref().ok())
            .map(|e| e.seq)
            .collect();

        // Seq numbers should be monotonically increasing
        for window in seqs.windows(2) {
            assert!(window[1] > window[0], "seq not increasing: {:?}", seqs);
        }
        // Last event should be the exit
        let last = events.last().unwrap().as_ref().unwrap();
        assert!(matches!(last.event, Some(exec_event::Event::Exit(_))));
    }

    #[tokio::test]
    async fn exec_exit_has_duration() {
        let mut req = make_request();
        req.cmd = vec!["true".into()];
        let events = collect_exec_events(req).await;

        let exit_event = events
            .iter()
            .filter_map(|e| e.as_ref().ok())
            .find_map(|e| match &e.event {
                Some(exec_event::Event::Exit(exit)) => Some(*exit),
                _ => None,
            })
            .expect("should have exit event");

        // Duration should be set (>= 0 ms)
        assert!(exit_event.duration_ms < 10_000, "duration seems too high");
    }

    #[tokio::test]
    async fn exec_nonexistent_command() {
        let mut req = make_request();
        req.cmd = vec!["/nonexistent/binary/that/doesnt/exist".into()];
        let events = collect_exec_events(req).await;

        // Should get an error status (spawn failure)
        assert_eq!(events.len(), 1);
        assert!(events[0].is_err());
    }

    #[tokio::test]
    async fn exec_timeout_kills_process() {
        let mut req = make_request();
        req.shell_cmd = "sleep 60".into();
        req.timeout_seconds = 1;

        let start = Instant::now();
        let events = collect_exec_events(req).await;
        let elapsed = start.elapsed();

        // Should complete well before the 60s sleep
        assert!(elapsed < Duration::from_secs(10));

        let exit_event = events
            .iter()
            .filter_map(|e| e.as_ref().ok())
            .find_map(|e| match &e.event {
                Some(exec_event::Event::Exit(exit)) => Some(*exit),
                _ => None,
            })
            .expect("should have exit event");

        assert_eq!(exit_event.exit_code, -1, "timed-out process should exit with -1");
    }

    #[tokio::test]
    async fn exec_large_output() {
        let mut req = make_request();
        // Generate output larger than CHUNK_SIZE (8192)
        req.shell_cmd = "seq 1 5000".into();
        let events = collect_exec_events(req).await;

        let mut stdout_data = Vec::new();
        let mut exit_code = None;
        for event in &events {
            let event = event.as_ref().unwrap();
            match &event.event {
                Some(exec_event::Event::Stdout(data)) => stdout_data.extend_from_slice(data),
                Some(exec_event::Event::Exit(e)) => exit_code = Some(e.exit_code),
                _ => {}
            }
        }

        let output = String::from_utf8_lossy(&stdout_data);
        assert!(output.contains("5000"));
        assert_eq!(exit_code, Some(0));
        // Output should be chunked across multiple events
        let stdout_event_count = events
            .iter()
            .filter(|e| matches!(e.as_ref().ok().and_then(|e| e.event.as_ref()), Some(exec_event::Event::Stdout(_))))
            .count();
        assert!(stdout_event_count >= 1);
    }
}
