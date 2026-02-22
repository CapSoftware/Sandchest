pub mod agent_client;
pub mod artifacts;
pub mod config;
pub mod disk;
pub mod events;
pub mod firecracker;
pub mod heartbeat;
pub mod id;
pub mod jailer;
pub mod network;
pub mod router;
pub mod sandbox;
pub mod slot;
pub mod snapshot;

pub mod proto {
    tonic::include_proto!("sandchest.node.v1");
}

use std::sync::Arc;

use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::StreamExt;
use tonic::{Request, Response, Status, Streaming};
use tracing::info;

use crate::config::NodeConfig;
use crate::router::Router;
use crate::sandbox::SandboxManager;

/// gRPC server implementing the Node service for control plane communication.
pub struct NodeService {
    sandbox_manager: Arc<SandboxManager>,
    router: Arc<Router>,
    node_config: Arc<NodeConfig>,
}

impl NodeService {
    pub fn new(sandbox_manager: Arc<SandboxManager>, node_config: Arc<NodeConfig>) -> Self {
        let router = Arc::new(Router::new(Arc::clone(&sandbox_manager)));
        Self {
            sandbox_manager,
            router,
            node_config,
        }
    }
}

#[tonic::async_trait]
impl proto::node_server::Node for NodeService {
    async fn create_sandbox(
        &self,
        request: Request<proto::CreateSandboxRequest>,
    ) -> Result<Response<proto::CreateSandboxResponse>, Status> {
        let req = request.into_inner();

        let _info = self
            .sandbox_manager
            .create_sandbox(
                &req.sandbox_id,
                &req.kernel_ref,
                &req.rootfs_ref,
                req.cpu_cores,
                req.memory_mb,
                req.env,
            )
            .await
            .map_err(|e| Status::internal(e.to_string()))?;

        Ok(Response::new(proto::CreateSandboxResponse {
            sandbox_id: req.sandbox_id,
        }))
    }

    async fn create_sandbox_from_snapshot(
        &self,
        request: Request<proto::CreateSandboxFromSnapshotRequest>,
    ) -> Result<Response<proto::CreateSandboxResponse>, Status> {
        let req = request.into_inner();

        let _info = self
            .sandbox_manager
            .create_sandbox_from_snapshot(
                &req.sandbox_id,
                &req.snapshot_ref,
                req.env,
            )
            .await
            .map_err(|e| Status::internal(e.to_string()))?;

        Ok(Response::new(proto::CreateSandboxResponse {
            sandbox_id: req.sandbox_id,
        }))
    }

    async fn fork_sandbox(
        &self,
        request: Request<proto::ForkSandboxRequest>,
    ) -> Result<Response<proto::ForkSandboxResponse>, Status> {
        let req = request.into_inner();

        let _info = self
            .sandbox_manager
            .fork_sandbox(&req.source_sandbox_id, &req.new_sandbox_id)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;

        Ok(Response::new(proto::ForkSandboxResponse {
            sandbox_id: req.new_sandbox_id,
        }))
    }

    type ExecStream = ReceiverStream<Result<proto::ExecEvent, Status>>;

    async fn exec(
        &self,
        request: Request<proto::NodeExecRequest>,
    ) -> Result<Response<Self::ExecStream>, Status> {
        let req = request.into_inner();
        let sandbox_id = req.sandbox_id.clone();
        let mut client = self.router.get_agent(&sandbox_id).await?;

        let agent_req = router::to_agent_exec_request(req);
        let response = client.exec(agent_req).await.map_err(|e| {
            Status::internal(format!("agent exec failed: {}", e))
        })?;

        let mut agent_stream = response.into_inner();
        let (tx, rx) = tokio::sync::mpsc::channel(32);

        tokio::spawn(async move {
            while let Some(result) = agent_stream.next().await {
                let item = match result {
                    Ok(event) => Ok(router::to_node_exec_event(event)),
                    Err(e) => Err(e),
                };
                if tx.send(item).await.is_err() {
                    break;
                }
            }
        });

        Ok(Response::new(ReceiverStream::new(rx)))
    }

    async fn create_session(
        &self,
        request: Request<proto::NodeCreateSessionRequest>,
    ) -> Result<Response<proto::NodeCreateSessionResponse>, Status> {
        let req = request.into_inner();
        let mut client = self.router.get_agent(&req.sandbox_id).await?;

        let agent_req = router::to_agent_create_session(req);
        let response = client.create_session(agent_req).await.map_err(|e| {
            Status::internal(format!("agent create_session failed: {}", e))
        })?;

        let resp = response.into_inner();
        Ok(Response::new(proto::NodeCreateSessionResponse {
            session_id: resp.session_id,
        }))
    }

    type SessionExecStream = ReceiverStream<Result<proto::ExecEvent, Status>>;

    async fn session_exec(
        &self,
        request: Request<proto::NodeSessionExecRequest>,
    ) -> Result<Response<Self::SessionExecStream>, Status> {
        let req = request.into_inner();
        let mut client = self.router.get_agent(&req.sandbox_id).await?;

        let agent_req = router::to_agent_session_exec(req);
        let response = client.session_exec(agent_req).await.map_err(|e| {
            Status::internal(format!("agent session_exec failed: {}", e))
        })?;

        let mut agent_stream = response.into_inner();
        let (tx, rx) = tokio::sync::mpsc::channel(32);

        tokio::spawn(async move {
            while let Some(result) = agent_stream.next().await {
                let item = match result {
                    Ok(event) => Ok(router::to_node_exec_event(event)),
                    Err(e) => Err(e),
                };
                if tx.send(item).await.is_err() {
                    break;
                }
            }
        });

        Ok(Response::new(ReceiverStream::new(rx)))
    }

    async fn session_input(
        &self,
        request: Request<proto::NodeSessionInputRequest>,
    ) -> Result<Response<()>, Status> {
        let req = request.into_inner();
        let mut client = self.router.get_agent(&req.sandbox_id).await?;

        let agent_req = router::to_agent_session_input(req);
        client.session_input(agent_req).await.map_err(|e| {
            Status::internal(format!("agent session_input failed: {}", e))
        })?;

        Ok(Response::new(()))
    }

    async fn destroy_session(
        &self,
        request: Request<proto::NodeDestroySessionRequest>,
    ) -> Result<Response<()>, Status> {
        let req = request.into_inner();
        let mut client = self.router.get_agent(&req.sandbox_id).await?;

        let agent_req = router::to_agent_destroy_session(req);
        client.destroy_session(agent_req).await.map_err(|e| {
            Status::internal(format!("agent destroy_session failed: {}", e))
        })?;

        Ok(Response::new(()))
    }

    async fn put_file(
        &self,
        request: Request<Streaming<proto::NodeFileChunk>>,
    ) -> Result<Response<proto::NodePutFileResponse>, Status> {
        let mut incoming = request.into_inner();

        // Peek the first chunk to get sandbox_id
        let first_chunk = incoming
            .message()
            .await?
            .ok_or_else(|| Status::invalid_argument("empty file stream"))?;

        let sandbox_id = first_chunk.sandbox_id.clone();
        let mut client = self.router.get_agent(&sandbox_id).await?;

        // Channel to forward converted chunks to the agent
        let (tx, rx) = tokio::sync::mpsc::channel(32);

        // Send the converted first chunk
        let _ = tx.send(router::to_agent_file_chunk(first_chunk)).await;

        // Forward remaining chunks in background
        tokio::spawn(async move {
            while let Ok(Some(chunk)) = incoming.message().await {
                if tx.send(router::to_agent_file_chunk(chunk)).await.is_err() {
                    break;
                }
            }
            // tx drops here, signaling end-of-stream
        });

        let response = client
            .put_file(ReceiverStream::new(rx))
            .await
            .map_err(|e| {
                Status::internal(format!("agent put_file failed: {}", e))
            })?;

        let resp = response.into_inner();
        Ok(Response::new(proto::NodePutFileResponse {
            bytes_written: resp.bytes_written,
        }))
    }

    type GetFileStream = ReceiverStream<Result<proto::NodeFileChunk, Status>>;

    async fn get_file(
        &self,
        request: Request<proto::NodeGetFileRequest>,
    ) -> Result<Response<Self::GetFileStream>, Status> {
        let req = request.into_inner();
        let sandbox_id = req.sandbox_id.clone();
        let mut client = self.router.get_agent(&sandbox_id).await?;

        let agent_req = router::to_agent_get_file(req);
        let response = client.get_file(agent_req).await.map_err(|e| {
            Status::internal(format!("agent get_file failed: {}", e))
        })?;

        let mut agent_stream = response.into_inner();
        let (tx, rx) = tokio::sync::mpsc::channel(32);

        tokio::spawn(async move {
            while let Some(result) = agent_stream.next().await {
                let item = match result {
                    Ok(chunk) => Ok(router::to_node_file_chunk(chunk, &sandbox_id)),
                    Err(e) => Err(e),
                };
                if tx.send(item).await.is_err() {
                    break;
                }
            }
        });

        Ok(Response::new(ReceiverStream::new(rx)))
    }

    async fn list_files(
        &self,
        request: Request<proto::NodeListFilesRequest>,
    ) -> Result<Response<proto::NodeListFilesResponse>, Status> {
        let req = request.into_inner();
        let mut client = self.router.get_agent(&req.sandbox_id).await?;

        let agent_req = router::to_agent_list_files(req);
        let response = client.list_files(agent_req).await.map_err(|e| {
            Status::internal(format!("agent list_files failed: {}", e))
        })?;

        Ok(Response::new(router::to_node_list_files_response(
            response.into_inner(),
        )))
    }

    async fn collect_artifacts(
        &self,
        request: Request<proto::CollectArtifactsRequest>,
    ) -> Result<Response<proto::CollectArtifactsResponse>, Status> {
        let req = request.into_inner();
        let mut client = self.router.get_agent(&req.sandbox_id).await?;

        let s3_config = self.node_config.s3.as_ref();
        let artifacts =
            artifacts::collect(&mut client, &req.sandbox_id, &req.paths, s3_config).await?;

        Ok(Response::new(proto::CollectArtifactsResponse { artifacts }))
    }

    async fn stop_sandbox(
        &self,
        request: Request<proto::StopSandboxRequest>,
    ) -> Result<Response<proto::StopSandboxResponse>, Status> {
        let req = request.into_inner();
        self.router.remove_client(&req.sandbox_id).await;
        self.sandbox_manager
            .destroy_sandbox(&req.sandbox_id)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;

        Ok(Response::new(proto::StopSandboxResponse {
            sandbox_id: req.sandbox_id,
        }))
    }

    async fn destroy_sandbox(
        &self,
        request: Request<proto::DestroySandboxRequest>,
    ) -> Result<Response<()>, Status> {
        let req = request.into_inner();
        self.router.remove_client(&req.sandbox_id).await;
        self.sandbox_manager
            .destroy_sandbox(&req.sandbox_id)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;

        Ok(Response::new(()))
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let node_config = Arc::new(NodeConfig::from_env());

    // Create event channel for heartbeat and lifecycle events
    let (event_sender, event_rx) = events::channel(256);

    let sandbox_manager = Arc::new(
        SandboxManager::new(Arc::clone(&node_config)).with_event_sender(event_sender.clone()),
    );

    // Spawn heartbeat loop
    tokio::spawn(heartbeat::start_heartbeat(
        Arc::clone(&node_config),
        Arc::clone(&sandbox_manager),
        event_sender,
    ));

    // Spawn event stream to control plane (if URL configured)
    if let Some(ref url) = node_config.control_plane_url {
        info!(url = %url, "starting event stream to control plane");
        tokio::spawn(events::run_event_stream(event_rx, url.clone()));
    } else {
        info!("no control plane URL configured, event stream disabled");
        // Spawn a drain task so events don't pile up
        tokio::spawn(async move {
            let mut rx = event_rx;
            while rx.recv().await.is_some() {}
        });
    }

    let addr = format!("0.0.0.0:{}", node_config.grpc_port)
        .parse()
        .unwrap();

    let node_service = NodeService::new(Arc::clone(&sandbox_manager), Arc::clone(&node_config));

    info!(
        node_id = %node_config.node_id,
        grpc_port = node_config.grpc_port,
        data_dir = %node_config.data_dir,
        "Sandchest node daemon ready"
    );

    tonic::transport::Server::builder()
        .add_service(proto::node_server::NodeServer::new(node_service))
        .serve(addr)
        .await?;

    Ok(())
}
