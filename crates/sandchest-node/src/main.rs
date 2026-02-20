pub mod config;
pub mod firecracker;
pub mod id;
pub mod sandbox;

pub mod proto {
    tonic::include_proto!("sandchest.node.v1");
}

use std::sync::Arc;

use tonic::{Request, Response, Status, Streaming};
use tracing::info;

use crate::config::NodeConfig;
use crate::sandbox::SandboxManager;

/// gRPC server implementing the Node service for control plane communication.
pub struct NodeService {
    sandbox_manager: Arc<SandboxManager>,
}

impl NodeService {
    pub fn new(sandbox_manager: Arc<SandboxManager>) -> Self {
        Self { sandbox_manager }
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
        _request: Request<proto::CreateSandboxFromSnapshotRequest>,
    ) -> Result<Response<proto::CreateSandboxResponse>, Status> {
        Err(Status::unimplemented(
            "snapshot-based creation implemented in Task 6",
        ))
    }

    async fn fork_sandbox(
        &self,
        _request: Request<proto::ForkSandboxRequest>,
    ) -> Result<Response<proto::ForkSandboxResponse>, Status> {
        Err(Status::unimplemented("fork implemented in Phase 3"))
    }

    type ExecStream =
        tokio_stream::wrappers::ReceiverStream<Result<proto::ExecEvent, Status>>;

    async fn exec(
        &self,
        _request: Request<proto::NodeExecRequest>,
    ) -> Result<Response<Self::ExecStream>, Status> {
        Err(Status::unimplemented(
            "exec routing implemented in Task 8",
        ))
    }

    async fn create_session(
        &self,
        _request: Request<proto::NodeCreateSessionRequest>,
    ) -> Result<Response<proto::NodeCreateSessionResponse>, Status> {
        Err(Status::unimplemented(
            "session routing implemented in Task 8",
        ))
    }

    type SessionExecStream =
        tokio_stream::wrappers::ReceiverStream<Result<proto::ExecEvent, Status>>;

    async fn session_exec(
        &self,
        _request: Request<proto::NodeSessionExecRequest>,
    ) -> Result<Response<Self::SessionExecStream>, Status> {
        Err(Status::unimplemented(
            "session exec routing implemented in Task 8",
        ))
    }

    async fn session_input(
        &self,
        _request: Request<proto::NodeSessionInputRequest>,
    ) -> Result<Response<()>, Status> {
        Err(Status::unimplemented(
            "session input routing implemented in Task 8",
        ))
    }

    async fn destroy_session(
        &self,
        _request: Request<proto::NodeDestroySessionRequest>,
    ) -> Result<Response<()>, Status> {
        Err(Status::unimplemented(
            "session destroy routing implemented in Task 8",
        ))
    }

    async fn put_file(
        &self,
        _request: Request<Streaming<proto::NodeFileChunk>>,
    ) -> Result<Response<proto::NodePutFileResponse>, Status> {
        Err(Status::unimplemented(
            "file routing implemented in Task 8",
        ))
    }

    type GetFileStream =
        tokio_stream::wrappers::ReceiverStream<Result<proto::NodeFileChunk, Status>>;

    async fn get_file(
        &self,
        _request: Request<proto::NodeGetFileRequest>,
    ) -> Result<Response<Self::GetFileStream>, Status> {
        Err(Status::unimplemented(
            "file routing implemented in Task 8",
        ))
    }

    async fn list_files(
        &self,
        _request: Request<proto::NodeListFilesRequest>,
    ) -> Result<Response<proto::NodeListFilesResponse>, Status> {
        Err(Status::unimplemented(
            "file routing implemented in Task 8",
        ))
    }

    async fn collect_artifacts(
        &self,
        _request: Request<proto::CollectArtifactsRequest>,
    ) -> Result<Response<proto::CollectArtifactsResponse>, Status> {
        Err(Status::unimplemented(
            "artifact collection implemented in Phase 3",
        ))
    }

    async fn stop_sandbox(
        &self,
        request: Request<proto::StopSandboxRequest>,
    ) -> Result<Response<proto::StopSandboxResponse>, Status> {
        let req = request.into_inner();
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
    let sandbox_manager = Arc::new(SandboxManager::new(Arc::clone(&node_config)));

    let addr = format!("0.0.0.0:{}", node_config.grpc_port)
        .parse()
        .unwrap();

    let node_service = NodeService::new(Arc::clone(&sandbox_manager));

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
