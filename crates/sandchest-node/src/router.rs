use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::RwLock;
use tonic::Status;
use tracing::info;

use crate::agent_client::agent_proto;
use crate::agent_client::AgentClient;
use crate::proto;
use crate::sandbox::{SandboxManager, SandboxStatus};

type AgentGrpcClient = agent_proto::guest_agent_client::GuestAgentClient<tonic::transport::Channel>;

/// Routes control plane requests to the correct sandbox's guest agent.
///
/// Caches gRPC client connections per sandbox to avoid reconnecting
/// on every request.
pub struct Router {
    sandbox_manager: Arc<SandboxManager>,
    clients: RwLock<HashMap<String, AgentGrpcClient>>,
}

impl Router {
    pub fn new(sandbox_manager: Arc<SandboxManager>) -> Self {
        Self {
            sandbox_manager,
            clients: RwLock::new(HashMap::new()),
        }
    }

    /// Get a gRPC client for the guest agent in the given sandbox.
    ///
    /// Verifies the sandbox exists and is running, then returns a cached
    /// or newly created connection.
    pub async fn get_agent(&self, sandbox_id: &str) -> Result<AgentGrpcClient, Status> {
        let info = self
            .sandbox_manager
            .get_sandbox(sandbox_id)
            .await
            .ok_or_else(|| Status::not_found(format!("sandbox not found: {}", sandbox_id)))?;

        if info.status != SandboxStatus::Running {
            return Err(Status::failed_precondition(format!(
                "sandbox {} is not running (status: {})",
                sandbox_id, info.status
            )));
        }

        // Return cached client if available
        {
            let clients = self.clients.read().await;
            if let Some(client) = clients.get(sandbox_id) {
                return Ok(client.clone());
            }
        }

        // Create new connection
        let endpoint = agent_endpoint();
        let agent = AgentClient::new(&endpoint);
        let client = agent.connect().await.map_err(|e| {
            Status::unavailable(format!(
                "agent unreachable for sandbox {}: {}",
                sandbox_id, e
            ))
        })?;

        info!(sandbox_id = %sandbox_id, endpoint = %endpoint, "connected to guest agent");
        self.clients
            .write()
            .await
            .insert(sandbox_id.to_string(), client.clone());

        Ok(client)
    }

    /// Remove a cached client when a sandbox is destroyed.
    pub async fn remove_client(&self, sandbox_id: &str) {
        self.clients.write().await.remove(sandbox_id);
    }
}

/// Determine the agent gRPC endpoint.
///
/// In dev mode (TCP), all sandboxes share the same localhost endpoint.
/// In production (bare-metal Linux), this would derive the vsock path
/// from the sandbox's UDS socket.
fn agent_endpoint() -> String {
    AgentClient::dev_endpoint()
}

// --- Type conversions: node proto -> agent proto ---

pub fn to_agent_exec_request(req: proto::NodeExecRequest) -> agent_proto::ExecRequest {
    agent_proto::ExecRequest {
        cmd: req.cmd,
        shell_cmd: req.shell_cmd,
        cwd: req.cwd,
        env: req.env,
        timeout_seconds: req.timeout_seconds,
    }
}

pub fn to_agent_create_session(req: proto::NodeCreateSessionRequest) -> agent_proto::CreateSessionRequest {
    agent_proto::CreateSessionRequest {
        shell: req.shell,
        env: req.env,
    }
}

pub fn to_agent_session_exec(req: proto::NodeSessionExecRequest) -> agent_proto::SessionExecRequest {
    agent_proto::SessionExecRequest {
        session_id: req.session_id,
        cmd: req.cmd,
        timeout_seconds: req.timeout_seconds,
    }
}

pub fn to_agent_session_input(req: proto::NodeSessionInputRequest) -> agent_proto::SessionInputRequest {
    agent_proto::SessionInputRequest {
        session_id: req.session_id,
        data: req.data,
    }
}

pub fn to_agent_destroy_session(
    req: proto::NodeDestroySessionRequest,
) -> agent_proto::DestroySessionRequest {
    agent_proto::DestroySessionRequest {
        session_id: req.session_id,
    }
}

pub fn to_agent_file_chunk(chunk: proto::NodeFileChunk) -> agent_proto::FileChunk {
    agent_proto::FileChunk {
        path: chunk.path,
        data: chunk.data,
        offset: chunk.offset,
        done: chunk.done,
    }
}

pub fn to_agent_get_file(req: proto::NodeGetFileRequest) -> agent_proto::GetFileRequest {
    agent_proto::GetFileRequest { path: req.path }
}

pub fn to_agent_list_files(req: proto::NodeListFilesRequest) -> agent_proto::ListFilesRequest {
    agent_proto::ListFilesRequest { path: req.path }
}

// --- Type conversions: agent proto -> node proto ---

pub fn to_node_exec_event(event: agent_proto::ExecEvent) -> proto::ExecEvent {
    proto::ExecEvent {
        seq: event.seq,
        event: event.event.map(|e| match e {
            agent_proto::exec_event::Event::Stdout(data) => {
                proto::exec_event::Event::Stdout(data)
            }
            agent_proto::exec_event::Event::Stderr(data) => {
                proto::exec_event::Event::Stderr(data)
            }
            agent_proto::exec_event::Event::Exit(exit) => {
                proto::exec_event::Event::Exit(proto::ExitEvent {
                    exit_code: exit.exit_code,
                    cpu_ms: exit.cpu_ms,
                    peak_memory_bytes: exit.peak_memory_bytes,
                    duration_ms: exit.duration_ms,
                })
            }
        }),
    }
}

pub fn to_node_file_chunk(chunk: agent_proto::FileChunk, sandbox_id: &str) -> proto::NodeFileChunk {
    proto::NodeFileChunk {
        sandbox_id: sandbox_id.to_string(),
        path: chunk.path,
        data: chunk.data,
        offset: chunk.offset,
        done: chunk.done,
    }
}

pub fn to_node_list_files_response(
    resp: agent_proto::ListFilesResponse,
) -> proto::NodeListFilesResponse {
    proto::NodeListFilesResponse {
        files: resp
            .files
            .into_iter()
            .map(|f| proto::NodeFileInfo {
                path: f.path,
                size: f.size,
                is_dir: f.is_dir,
                modified_at: f.modified_at,
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exec_request_conversion_strips_sandbox_fields() {
        let node_req = proto::NodeExecRequest {
            sandbox_id: "sb_test123".to_string(),
            exec_id: "ex_abc".to_string(),
            cmd: vec!["echo".to_string(), "hello".to_string()],
            shell_cmd: String::new(),
            cwd: "/workspace".to_string(),
            env: [("KEY".to_string(), "val".to_string())].into(),
            timeout_seconds: 30,
        };

        let agent_req = to_agent_exec_request(node_req);
        assert_eq!(agent_req.cmd, vec!["echo", "hello"]);
        assert_eq!(agent_req.cwd, "/workspace");
        assert_eq!(agent_req.env.get("KEY").unwrap(), "val");
        assert_eq!(agent_req.timeout_seconds, 30);
    }

    #[test]
    fn exec_event_stdout_conversion() {
        let agent_event = agent_proto::ExecEvent {
            seq: 1,
            event: Some(agent_proto::exec_event::Event::Stdout(b"hello".to_vec())),
        };

        let node_event = to_node_exec_event(agent_event);
        assert_eq!(node_event.seq, 1);
        assert!(matches!(
            node_event.event,
            Some(proto::exec_event::Event::Stdout(ref d)) if d == b"hello"
        ));
    }

    #[test]
    fn exec_event_stderr_conversion() {
        let agent_event = agent_proto::ExecEvent {
            seq: 2,
            event: Some(agent_proto::exec_event::Event::Stderr(b"error".to_vec())),
        };

        let node_event = to_node_exec_event(agent_event);
        assert_eq!(node_event.seq, 2);
        assert!(matches!(
            node_event.event,
            Some(proto::exec_event::Event::Stderr(ref d)) if d == b"error"
        ));
    }

    #[test]
    fn exec_event_exit_conversion() {
        let agent_event = agent_proto::ExecEvent {
            seq: 3,
            event: Some(agent_proto::exec_event::Event::Exit(
                agent_proto::ExitEvent {
                    exit_code: 0,
                    cpu_ms: 150,
                    peak_memory_bytes: 1024 * 1024,
                    duration_ms: 200,
                },
            )),
        };

        let node_event = to_node_exec_event(agent_event);
        assert_eq!(node_event.seq, 3);
        match node_event.event {
            Some(proto::exec_event::Event::Exit(exit)) => {
                assert_eq!(exit.exit_code, 0);
                assert_eq!(exit.cpu_ms, 150);
                assert_eq!(exit.peak_memory_bytes, 1024 * 1024);
                assert_eq!(exit.duration_ms, 200);
            }
            _ => panic!("expected Exit event"),
        }
    }

    #[test]
    fn create_session_conversion() {
        let node_req = proto::NodeCreateSessionRequest {
            sandbox_id: "sb_test".to_string(),
            session_id: "sess_abc".to_string(),
            shell: "/bin/bash".to_string(),
            env: [("TERM".to_string(), "xterm".to_string())].into(),
        };

        let agent_req = to_agent_create_session(node_req);
        assert_eq!(agent_req.shell, "/bin/bash");
        assert_eq!(agent_req.env.get("TERM").unwrap(), "xterm");
    }

    #[test]
    fn session_exec_conversion() {
        let node_req = proto::NodeSessionExecRequest {
            sandbox_id: "sb_test".to_string(),
            session_id: "sess_abc".to_string(),
            exec_id: "ex_123".to_string(),
            cmd: "ls -la".to_string(),
            timeout_seconds: 10,
        };

        let agent_req = to_agent_session_exec(node_req);
        assert_eq!(agent_req.session_id, "sess_abc");
        assert_eq!(agent_req.cmd, "ls -la");
        assert_eq!(agent_req.timeout_seconds, 10);
    }

    #[test]
    fn session_input_conversion() {
        let node_req = proto::NodeSessionInputRequest {
            sandbox_id: "sb_test".to_string(),
            session_id: "sess_abc".to_string(),
            data: b"input data".to_vec(),
        };

        let agent_req = to_agent_session_input(node_req);
        assert_eq!(agent_req.session_id, "sess_abc");
        assert_eq!(agent_req.data, b"input data");
    }

    #[test]
    fn destroy_session_conversion() {
        let node_req = proto::NodeDestroySessionRequest {
            sandbox_id: "sb_test".to_string(),
            session_id: "sess_abc".to_string(),
        };

        let agent_req = to_agent_destroy_session(node_req);
        assert_eq!(agent_req.session_id, "sess_abc");
    }

    #[test]
    fn file_chunk_to_agent_strips_sandbox_id() {
        let node_chunk = proto::NodeFileChunk {
            sandbox_id: "sb_test".to_string(),
            path: "/workspace/file.txt".to_string(),
            data: b"content".to_vec(),
            offset: 0,
            done: true,
        };

        let agent_chunk = to_agent_file_chunk(node_chunk);
        assert_eq!(agent_chunk.path, "/workspace/file.txt");
        assert_eq!(agent_chunk.data, b"content");
        assert_eq!(agent_chunk.offset, 0);
        assert!(agent_chunk.done);
    }

    #[test]
    fn file_chunk_to_node_adds_sandbox_id() {
        let agent_chunk = agent_proto::FileChunk {
            path: "/workspace/file.txt".to_string(),
            data: b"content".to_vec(),
            offset: 0,
            done: false,
        };

        let node_chunk = to_node_file_chunk(agent_chunk, "sb_test");
        assert_eq!(node_chunk.sandbox_id, "sb_test");
        assert_eq!(node_chunk.path, "/workspace/file.txt");
        assert_eq!(node_chunk.data, b"content");
        assert!(!node_chunk.done);
    }

    #[test]
    fn get_file_request_conversion() {
        let node_req = proto::NodeGetFileRequest {
            sandbox_id: "sb_test".to_string(),
            path: "/workspace/out.txt".to_string(),
        };

        let agent_req = to_agent_get_file(node_req);
        assert_eq!(agent_req.path, "/workspace/out.txt");
    }

    #[test]
    fn list_files_request_conversion() {
        let node_req = proto::NodeListFilesRequest {
            sandbox_id: "sb_test".to_string(),
            path: "/workspace".to_string(),
        };

        let agent_req = to_agent_list_files(node_req);
        assert_eq!(agent_req.path, "/workspace");
    }

    #[test]
    fn list_files_response_conversion() {
        let agent_resp = agent_proto::ListFilesResponse {
            files: vec![
                agent_proto::FileInfo {
                    path: "/workspace/a.txt".to_string(),
                    size: 100,
                    is_dir: false,
                    modified_at: 1700000000,
                },
                agent_proto::FileInfo {
                    path: "/workspace/src".to_string(),
                    size: 0,
                    is_dir: true,
                    modified_at: 1700000001,
                },
            ],
        };

        let node_resp = to_node_list_files_response(agent_resp);
        assert_eq!(node_resp.files.len(), 2);
        assert_eq!(node_resp.files[0].path, "/workspace/a.txt");
        assert_eq!(node_resp.files[0].size, 100);
        assert!(!node_resp.files[0].is_dir);
        assert_eq!(node_resp.files[1].path, "/workspace/src");
        assert!(node_resp.files[1].is_dir);
    }

    #[tokio::test]
    async fn router_rejects_unknown_sandbox() {
        let config = Arc::new(crate::config::NodeConfig {
            node_id: "node_test".to_string(),
            grpc_port: 50051,
            data_dir: "/tmp/sandchest-test".to_string(),
            kernel_path: "/var/sandchest/images/vmlinux-5.10".to_string(),
            control_plane_url: None,
            jailer: crate::jailer::JailerConfig::disabled(),
            s3: None,
            tls: None,
        });
        let manager = Arc::new(SandboxManager::new(config));
        let router = Router::new(manager);

        let result = router.get_agent("sb_nonexistent").await;
        assert!(result.is_err());
        let status = result.unwrap_err();
        assert_eq!(status.code(), tonic::Code::NotFound);
    }

    #[tokio::test]
    async fn router_not_found_error_contains_sandbox_id() {
        let config = Arc::new(crate::config::NodeConfig {
            node_id: "node_test".to_string(),
            grpc_port: 50051,
            data_dir: "/tmp/sandchest-test".to_string(),
            kernel_path: "/var/sandchest/images/vmlinux-5.10".to_string(),
            control_plane_url: None,
            jailer: crate::jailer::JailerConfig::disabled(),
            s3: None,
            tls: None,
        });
        let manager = Arc::new(SandboxManager::new(config));
        let router = Router::new(manager);

        let result = router.get_agent("sb_specific_id").await;
        let status = result.unwrap_err();
        assert_eq!(status.code(), tonic::Code::NotFound);
        assert!(status.message().contains("sb_specific_id"));
    }

    #[tokio::test]
    async fn router_remove_client_noop_for_unknown() {
        let config = Arc::new(crate::config::NodeConfig {
            node_id: "node_test".to_string(),
            grpc_port: 50051,
            data_dir: "/tmp/sandchest-test".to_string(),
            kernel_path: "/var/sandchest/images/vmlinux-5.10".to_string(),
            control_plane_url: None,
            jailer: crate::jailer::JailerConfig::disabled(),
            s3: None,
            tls: None,
        });
        let manager = Arc::new(SandboxManager::new(config));
        let router = Router::new(manager);

        // Should not panic
        router.remove_client("sb_unknown").await;
    }

    #[test]
    fn exec_event_none_event_conversion() {
        let agent_event = agent_proto::ExecEvent {
            seq: 99,
            event: None,
        };
        let node_event = to_node_exec_event(agent_event);
        assert_eq!(node_event.seq, 99);
        assert!(node_event.event.is_none());
    }

    #[test]
    fn exec_request_shell_cmd_preserved() {
        let node_req = proto::NodeExecRequest {
            sandbox_id: "sb_test".to_string(),
            exec_id: "ex_1".to_string(),
            cmd: vec![],
            shell_cmd: "echo hello && echo world".to_string(),
            cwd: String::new(),
            env: Default::default(),
            timeout_seconds: 0,
        };
        let agent_req = to_agent_exec_request(node_req);
        assert_eq!(agent_req.shell_cmd, "echo hello && echo world");
        assert!(agent_req.cmd.is_empty());
    }

    #[test]
    fn file_chunk_preserves_offset() {
        let node_chunk = proto::NodeFileChunk {
            sandbox_id: "sb_test".to_string(),
            path: "/file.txt".to_string(),
            data: b"data".to_vec(),
            offset: 1024,
            done: false,
        };
        let agent_chunk = to_agent_file_chunk(node_chunk);
        assert_eq!(agent_chunk.offset, 1024);
        assert!(!agent_chunk.done);
    }

    #[test]
    fn list_files_response_empty() {
        let agent_resp = agent_proto::ListFilesResponse { files: vec![] };
        let node_resp = to_node_list_files_response(agent_resp);
        assert!(node_resp.files.is_empty());
    }

    #[test]
    fn exit_event_negative_exit_code() {
        let agent_event = agent_proto::ExecEvent {
            seq: 1,
            event: Some(agent_proto::exec_event::Event::Exit(
                agent_proto::ExitEvent {
                    exit_code: -1,
                    cpu_ms: 0,
                    peak_memory_bytes: 0,
                    duration_ms: 0,
                },
            )),
        };
        let node_event = to_node_exec_event(agent_event);
        match node_event.event {
            Some(proto::exec_event::Event::Exit(exit)) => {
                assert_eq!(exit.exit_code, -1);
            }
            _ => panic!("expected Exit event"),
        }
    }
}
