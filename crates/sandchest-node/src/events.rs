use std::collections::VecDeque;
use std::time::Duration;

use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::transport::{Certificate, ClientTlsConfig, Identity};
use tracing::{info, warn};

use crate::config::TlsConfig;
use crate::proto;

/// Maximum number of events to buffer when disconnected from the control plane.
const MAX_BUFFER_SIZE: usize = 1000;

/// Sender handle for reporting events to the control plane.
/// Clone-safe — distribute to any component that needs to report events.
pub type EventSender = mpsc::Sender<proto::NodeToControl>;

/// Create an event channel and return the sender and receiver.
///
/// The sender is distributed to components that report events.
/// The receiver is consumed by the background stream loop.
pub fn channel(buffer_size: usize) -> (EventSender, mpsc::Receiver<proto::NodeToControl>) {
    mpsc::channel(buffer_size)
}

// --- Convenience constructors for NodeToControl event messages ---

pub fn sandbox_event(
    sandbox_id: &str,
    event_type: proto::SandboxEventType,
    message: &str,
) -> proto::NodeToControl {
    proto::NodeToControl {
        event: Some(proto::node_to_control::Event::SandboxEvent(
            proto::SandboxEvent {
                sandbox_id: sandbox_id.to_string(),
                event_type: event_type as i32,
                message: message.to_string(),
            },
        )),
    }
}

pub fn heartbeat_msg(
    node_id: &str,
    active_sandbox_ids: Vec<String>,
    slots_total: u32,
    slots_used: u32,
    snapshot_ids: Vec<String>,
    metrics: Option<proto::NodeMetrics>,
) -> proto::NodeToControl {
    proto::NodeToControl {
        event: Some(proto::node_to_control::Event::Heartbeat(
            proto::Heartbeat {
                node_id: node_id.to_string(),
                active_sandbox_ids,
                slots_total,
                slots_used,
                snapshot_ids,
                metrics,
            },
        )),
    }
}

pub fn exec_output(
    exec_id: &str,
    seq: u64,
    stdout: Option<Vec<u8>>,
    stderr: Option<Vec<u8>>,
) -> proto::NodeToControl {
    let output = if let Some(data) = stdout {
        Some(proto::exec_output::Output::Stdout(data))
    } else {
        stderr.map(proto::exec_output::Output::Stderr)
    };
    proto::NodeToControl {
        event: Some(proto::node_to_control::Event::ExecOutput(
            proto::ExecOutput {
                exec_id: exec_id.to_string(),
                seq,
                output,
            },
        )),
    }
}

pub fn exec_completed(
    exec_id: &str,
    exit_code: i32,
    cpu_ms: u64,
    peak_memory_bytes: u64,
    duration_ms: u64,
) -> proto::NodeToControl {
    proto::NodeToControl {
        event: Some(proto::node_to_control::Event::ExecCompleted(
            proto::ExecCompleted {
                exec_id: exec_id.to_string(),
                exit_code,
                cpu_ms,
                peak_memory_bytes,
                duration_ms,
            },
        )),
    }
}

pub fn session_output(
    session_id: &str,
    seq: u64,
    stdout: Option<Vec<u8>>,
    stderr: Option<Vec<u8>>,
) -> proto::NodeToControl {
    let output = if let Some(data) = stdout {
        Some(proto::session_output::Output::Stdout(data))
    } else {
        stderr.map(proto::session_output::Output::Stderr)
    };
    proto::NodeToControl {
        event: Some(proto::node_to_control::Event::SessionOutput(
            proto::SessionOutput {
                session_id: session_id.to_string(),
                seq,
                output,
            },
        )),
    }
}

/// Add an event to the buffer, dropping the oldest if at capacity.
fn buffer_event(buffer: &mut VecDeque<proto::NodeToControl>, event: proto::NodeToControl) {
    if buffer.len() >= MAX_BUFFER_SIZE {
        buffer.pop_front();
    }
    buffer.push_back(event);
}

/// Drain events from rx into the buffer during a sleep period.
async fn drain_during_sleep(
    rx: &mut mpsc::Receiver<proto::NodeToControl>,
    buffer: &mut VecDeque<proto::NodeToControl>,
    duration: Duration,
) {
    let sleep = tokio::time::sleep(duration);
    tokio::pin!(sleep);
    loop {
        tokio::select! {
            event = rx.recv() => {
                match event {
                    Some(ev) => buffer_event(buffer, ev),
                    None => return,
                }
            }
            _ = &mut sleep => return,
        }
    }
}

/// Background task: consumes events from the channel and streams them
/// to the control plane via the `Control.StreamEvents` bidirectional gRPC stream.
///
/// Buffers events during disconnections and replays on reconnect.
pub async fn run_event_stream(
    mut rx: mpsc::Receiver<proto::NodeToControl>,
    control_plane_url: String,
    tls: Option<TlsConfig>,
) {
    let mut buffer: VecDeque<proto::NodeToControl> = VecDeque::new();

    loop {
        match connect_and_stream(&mut rx, &mut buffer, &control_plane_url, tls.as_ref()).await {
            StreamResult::Disconnected(reason) => {
                warn!(
                    reason = %reason,
                    buffered = buffer.len(),
                    "control plane stream disconnected, reconnecting in 5s"
                );
            }
            StreamResult::ConnectFailed(e) => {
                // Drain any immediately available events into buffer
                while let Ok(event) = rx.try_recv() {
                    buffer_event(&mut buffer, event);
                }
                warn!(
                    error = %e,
                    buffered = buffer.len(),
                    "cannot connect to control plane, retrying in 5s"
                );
            }
            StreamResult::Shutdown => return,
        }

        drain_during_sleep(&mut rx, &mut buffer, Duration::from_secs(5)).await;
    }
}

enum StreamResult {
    Disconnected(String),
    ConnectFailed(String),
    Shutdown,
}

async fn connect_and_stream(
    rx: &mut mpsc::Receiver<proto::NodeToControl>,
    buffer: &mut VecDeque<proto::NodeToControl>,
    control_plane_url: &str,
    tls: Option<&TlsConfig>,
) -> StreamResult {
    let endpoint = match tonic::transport::Channel::from_shared(control_plane_url.to_string()) {
        Ok(ep) => ep,
        Err(e) => return StreamResult::ConnectFailed(e.to_string()),
    };

    let endpoint = if let Some(tls_config) = tls {
        let cert = match std::fs::read(&tls_config.cert_path) {
            Ok(c) => c,
            Err(e) => return StreamResult::ConnectFailed(format!("read cert: {}", e)),
        };
        let key = match std::fs::read(&tls_config.key_path) {
            Ok(k) => k,
            Err(e) => return StreamResult::ConnectFailed(format!("read key: {}", e)),
        };
        let ca = match std::fs::read(&tls_config.ca_cert_path) {
            Ok(c) => c,
            Err(e) => return StreamResult::ConnectFailed(format!("read CA cert: {}", e)),
        };

        let client_tls = ClientTlsConfig::new()
            .identity(Identity::from_pem(cert, key))
            .ca_certificate(Certificate::from_pem(ca));

        match endpoint.tls_config(client_tls) {
            Ok(ep) => ep,
            Err(e) => return StreamResult::ConnectFailed(format!("TLS config: {}", e)),
        }
    } else {
        endpoint
    };

    let channel = match endpoint.connect().await {
        Ok(ch) => ch,
        Err(e) => return StreamResult::ConnectFailed(e.to_string()),
    };

    let mut client = proto::control_client::ControlClient::new(channel);
    info!(url = %control_plane_url, "connected to control plane");

    // Create outbound stream channel
    let (stream_tx, stream_rx) = mpsc::channel::<proto::NodeToControl>(256);

    // Replay buffered events
    while let Some(event) = buffer.pop_front() {
        if stream_tx.send(event).await.is_err() {
            return StreamResult::Disconnected("stream closed during replay".to_string());
        }
    }

    // Start the bidirectional stream
    let outbound = ReceiverStream::new(stream_rx);
    let response = match client.stream_events(outbound).await {
        Ok(resp) => resp,
        Err(e) => {
            return StreamResult::ConnectFailed(format!("stream_events failed: {}", e));
        }
    };
    let mut inbound = response.into_inner();

    // Forward events from rx to the outbound stream
    loop {
        tokio::select! {
            event = rx.recv() => {
                match event {
                    Some(ev) => {
                        if stream_tx.send(ev).await.is_err() {
                            return StreamResult::Disconnected("outbound stream closed".to_string());
                        }
                    }
                    None => return StreamResult::Shutdown,
                }
            }
            msg = inbound.message() => {
                match msg {
                    Ok(Some(_)) => {} // ControlToNode — currently noop
                    Ok(None) => {
                        return StreamResult::Disconnected("server closed stream".to_string());
                    }
                    Err(e) => {
                        return StreamResult::Disconnected(e.to_string());
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sandbox_event_creates_correct_message() {
        let msg = sandbox_event(
            "sb_test",
            proto::SandboxEventType::Created,
            "sandbox created",
        );
        match msg.event {
            Some(proto::node_to_control::Event::SandboxEvent(ev)) => {
                assert_eq!(ev.sandbox_id, "sb_test");
                assert_eq!(ev.event_type, proto::SandboxEventType::Created as i32);
                assert_eq!(ev.message, "sandbox created");
            }
            _ => panic!("expected SandboxEvent"),
        }
    }

    #[test]
    fn sandbox_event_types_map_correctly() {
        let types = [
            (proto::SandboxEventType::Created, 1),
            (proto::SandboxEventType::Ready, 2),
            (proto::SandboxEventType::Stopped, 3),
            (proto::SandboxEventType::Failed, 4),
            (proto::SandboxEventType::Forked, 5),
        ];
        for (event_type, expected_value) in types {
            let msg = sandbox_event("sb_x", event_type, "");
            match msg.event {
                Some(proto::node_to_control::Event::SandboxEvent(ev)) => {
                    assert_eq!(ev.event_type, expected_value);
                }
                _ => panic!("expected SandboxEvent"),
            }
        }
    }

    #[test]
    fn heartbeat_msg_creates_correct_message() {
        let msg = heartbeat_msg(
            "node_abc",
            vec!["sb_1".to_string(), "sb_2".to_string()],
            256,
            2,
            vec!["snap_a".to_string()],
            None,
        );
        match msg.event {
            Some(proto::node_to_control::Event::Heartbeat(hb)) => {
                assert_eq!(hb.node_id, "node_abc");
                assert_eq!(hb.active_sandbox_ids, vec!["sb_1", "sb_2"]);
                assert_eq!(hb.slots_total, 256);
                assert_eq!(hb.slots_used, 2);
                assert_eq!(hb.snapshot_ids, vec!["snap_a"]);
            }
            _ => panic!("expected Heartbeat"),
        }
    }

    #[test]
    fn exec_output_stdout() {
        let msg = exec_output("ex_1", 5, Some(b"hello".to_vec()), None);
        match msg.event {
            Some(proto::node_to_control::Event::ExecOutput(eo)) => {
                assert_eq!(eo.exec_id, "ex_1");
                assert_eq!(eo.seq, 5);
                assert!(matches!(
                    eo.output,
                    Some(proto::exec_output::Output::Stdout(ref d)) if d == b"hello"
                ));
            }
            _ => panic!("expected ExecOutput"),
        }
    }

    #[test]
    fn exec_output_stderr() {
        let msg = exec_output("ex_2", 3, None, Some(b"error".to_vec()));
        match msg.event {
            Some(proto::node_to_control::Event::ExecOutput(eo)) => {
                assert_eq!(eo.exec_id, "ex_2");
                assert_eq!(eo.seq, 3);
                assert!(matches!(
                    eo.output,
                    Some(proto::exec_output::Output::Stderr(ref d)) if d == b"error"
                ));
            }
            _ => panic!("expected ExecOutput"),
        }
    }

    #[test]
    fn exec_completed_creates_correct_message() {
        let msg = exec_completed("ex_3", 0, 150, 1024 * 1024, 200);
        match msg.event {
            Some(proto::node_to_control::Event::ExecCompleted(ec)) => {
                assert_eq!(ec.exec_id, "ex_3");
                assert_eq!(ec.exit_code, 0);
                assert_eq!(ec.cpu_ms, 150);
                assert_eq!(ec.peak_memory_bytes, 1024 * 1024);
                assert_eq!(ec.duration_ms, 200);
            }
            _ => panic!("expected ExecCompleted"),
        }
    }

    #[test]
    fn session_output_stdout() {
        let msg = session_output("sess_1", 1, Some(b"output".to_vec()), None);
        match msg.event {
            Some(proto::node_to_control::Event::SessionOutput(so)) => {
                assert_eq!(so.session_id, "sess_1");
                assert_eq!(so.seq, 1);
                assert!(matches!(
                    so.output,
                    Some(proto::session_output::Output::Stdout(ref d)) if d == b"output"
                ));
            }
            _ => panic!("expected SessionOutput"),
        }
    }

    #[test]
    fn session_output_stderr() {
        let msg = session_output("sess_2", 4, None, Some(b"err".to_vec()));
        match msg.event {
            Some(proto::node_to_control::Event::SessionOutput(so)) => {
                assert_eq!(so.session_id, "sess_2");
                assert_eq!(so.seq, 4);
                assert!(matches!(
                    so.output,
                    Some(proto::session_output::Output::Stderr(ref d)) if d == b"err"
                ));
            }
            _ => panic!("expected SessionOutput"),
        }
    }

    #[test]
    fn buffer_event_caps_at_max_size() {
        let mut buffer = VecDeque::new();
        for i in 0..MAX_BUFFER_SIZE + 10 {
            buffer_event(
                &mut buffer,
                heartbeat_msg(&format!("node_{}", i), vec![], 256, 0, vec![], None),
            );
        }
        assert_eq!(buffer.len(), MAX_BUFFER_SIZE);
        // Oldest events should have been dropped (0..9 dropped, 10 is first)
        match &buffer.front().unwrap().event {
            Some(proto::node_to_control::Event::Heartbeat(hb)) => {
                assert_eq!(hb.node_id, "node_10");
            }
            _ => panic!("expected Heartbeat"),
        }
    }

    #[tokio::test]
    async fn event_channel_sends_and_receives() {
        let (tx, mut rx) = channel(16);
        let event = sandbox_event("sb_test", proto::SandboxEventType::Ready, "ready");
        tx.send(event).await.unwrap();

        let received = rx.recv().await.unwrap();
        assert!(matches!(
            received.event,
            Some(proto::node_to_control::Event::SandboxEvent(_))
        ));
    }

    #[tokio::test]
    async fn drain_during_sleep_collects_events() {
        let (tx, mut rx) = channel(16);
        let mut buffer = VecDeque::new();

        tx.send(sandbox_event("sb_1", proto::SandboxEventType::Created, ""))
            .await
            .unwrap();
        tx.send(sandbox_event("sb_2", proto::SandboxEventType::Ready, ""))
            .await
            .unwrap();

        drain_during_sleep(&mut rx, &mut buffer, Duration::from_millis(50)).await;
        assert_eq!(buffer.len(), 2);
    }

    #[test]
    fn exec_output_with_no_data() {
        let msg = exec_output("ex_none", 0, None, None);
        match msg.event {
            Some(proto::node_to_control::Event::ExecOutput(eo)) => {
                assert_eq!(eo.exec_id, "ex_none");
                assert!(eo.output.is_none());
            }
            _ => panic!("expected ExecOutput"),
        }
    }

    #[test]
    fn exec_output_stdout_takes_priority_over_stderr() {
        // When both are provided, stdout wins
        let msg = exec_output(
            "ex_both",
            1,
            Some(b"out".to_vec()),
            Some(b"err".to_vec()),
        );
        match msg.event {
            Some(proto::node_to_control::Event::ExecOutput(eo)) => {
                assert!(matches!(
                    eo.output,
                    Some(proto::exec_output::Output::Stdout(_))
                ));
            }
            _ => panic!("expected ExecOutput"),
        }
    }

    #[test]
    fn session_output_with_no_data() {
        let msg = session_output("sess_none", 0, None, None);
        match msg.event {
            Some(proto::node_to_control::Event::SessionOutput(so)) => {
                assert_eq!(so.session_id, "sess_none");
                assert!(so.output.is_none());
            }
            _ => panic!("expected SessionOutput"),
        }
    }

    #[test]
    fn exec_completed_with_nonzero_exit_code() {
        let msg = exec_completed("ex_fail", 1, 50, 512, 100);
        match msg.event {
            Some(proto::node_to_control::Event::ExecCompleted(ec)) => {
                assert_eq!(ec.exit_code, 1);
                assert_eq!(ec.cpu_ms, 50);
            }
            _ => panic!("expected ExecCompleted"),
        }
    }

    #[test]
    fn heartbeat_msg_with_empty_fields() {
        let msg = heartbeat_msg("node_empty", vec![], 0, 0, vec![], None);
        match msg.event {
            Some(proto::node_to_control::Event::Heartbeat(hb)) => {
                assert_eq!(hb.node_id, "node_empty");
                assert!(hb.active_sandbox_ids.is_empty());
                assert_eq!(hb.slots_total, 0);
                assert_eq!(hb.slots_used, 0);
                assert!(hb.snapshot_ids.is_empty());
            }
            _ => panic!("expected Heartbeat"),
        }
    }

    #[test]
    fn buffer_event_single_item() {
        let mut buffer = VecDeque::new();
        buffer_event(
            &mut buffer,
            sandbox_event("sb_1", proto::SandboxEventType::Created, ""),
        );
        assert_eq!(buffer.len(), 1);
    }

    #[test]
    fn buffer_event_drops_oldest_at_capacity() {
        let mut buffer = VecDeque::new();
        // Fill to MAX_BUFFER_SIZE
        for i in 0..MAX_BUFFER_SIZE {
            buffer_event(
                &mut buffer,
                heartbeat_msg(&format!("node_{}", i), vec![], 0, 0, vec![], None),
            );
        }
        assert_eq!(buffer.len(), MAX_BUFFER_SIZE);

        // Add one more — should drop node_0
        buffer_event(
            &mut buffer,
            heartbeat_msg("node_new", vec![], 0, 0, vec![], None),
        );
        assert_eq!(buffer.len(), MAX_BUFFER_SIZE);

        // First should be node_1 (node_0 was dropped)
        match &buffer.front().unwrap().event {
            Some(proto::node_to_control::Event::Heartbeat(hb)) => {
                assert_eq!(hb.node_id, "node_1");
            }
            _ => panic!("expected Heartbeat"),
        }

        // Last should be node_new
        match &buffer.back().unwrap().event {
            Some(proto::node_to_control::Event::Heartbeat(hb)) => {
                assert_eq!(hb.node_id, "node_new");
            }
            _ => panic!("expected Heartbeat"),
        }
    }

    #[tokio::test]
    async fn channel_with_size_1() {
        let (tx, mut rx) = channel(1);
        tx.send(sandbox_event("sb_1", proto::SandboxEventType::Created, ""))
            .await
            .unwrap();

        let received = rx.recv().await.unwrap();
        assert!(matches!(
            received.event,
            Some(proto::node_to_control::Event::SandboxEvent(_))
        ));
    }

    #[tokio::test]
    async fn drain_during_sleep_empty_channel() {
        let (_tx, mut rx) = channel(16);
        let mut buffer = VecDeque::new();

        // No events sent — drain should just wait for the sleep duration
        drain_during_sleep(&mut rx, &mut buffer, Duration::from_millis(50)).await;
        assert_eq!(buffer.len(), 0);
    }

    #[tokio::test]
    async fn drain_during_sleep_stops_on_channel_close() {
        let (tx, mut rx) = channel(16);
        let mut buffer = VecDeque::new();

        tx.send(sandbox_event("sb_1", proto::SandboxEventType::Created, ""))
            .await
            .unwrap();
        drop(tx); // Close the channel

        drain_during_sleep(&mut rx, &mut buffer, Duration::from_secs(10)).await;
        // Should return quickly after draining the one event + seeing channel closed
        assert_eq!(buffer.len(), 1);
    }
}
