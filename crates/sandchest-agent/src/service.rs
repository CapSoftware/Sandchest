use std::sync::Arc;

use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request, Response, Status, Streaming};

use crate::proto::guest_agent_server::GuestAgent;
use crate::proto::{
    CreateSessionRequest, DestroySessionRequest, ExecEvent, ExecRequest, FileChunk,
    GetFileRequest, HealthResponse, ListFilesRequest, ListFilesResponse, PutFileResponse,
    SessionExecRequest, SessionInputRequest, SessionResponse,
};
use crate::session::SessionManager;

pub struct GuestAgentService {
    session_manager: Arc<SessionManager>,
}

impl GuestAgentService {
    pub fn new() -> Self {
        Self {
            session_manager: Arc::new(SessionManager::new()),
        }
    }
}

#[tonic::async_trait]
impl GuestAgent for GuestAgentService {
    async fn health(
        &self,
        _request: Request<()>,
    ) -> Result<Response<HealthResponse>, Status> {
        Ok(Response::new(HealthResponse {
            ready: true,
            version: env!("CARGO_PKG_VERSION").to_string(),
        }))
    }

    type ExecStream = ReceiverStream<Result<ExecEvent, Status>>;

    async fn exec(
        &self,
        request: Request<ExecRequest>,
    ) -> Result<Response<Self::ExecStream>, Status> {
        let stream = crate::exec::spawn_exec(request.into_inner());
        Ok(Response::new(stream))
    }

    async fn create_session(
        &self,
        request: Request<CreateSessionRequest>,
    ) -> Result<Response<SessionResponse>, Status> {
        let req = request.into_inner();
        let session_id = self
            .session_manager
            .create_session(&req.shell, &req.env)
            .await?;
        Ok(Response::new(SessionResponse { session_id }))
    }

    type SessionExecStream = ReceiverStream<Result<ExecEvent, Status>>;

    async fn session_exec(
        &self,
        request: Request<SessionExecRequest>,
    ) -> Result<Response<Self::SessionExecStream>, Status> {
        let req = request.into_inner();
        let stream = self
            .session_manager
            .spawn_session_exec(&req.session_id, req.cmd, req.timeout_seconds)
            .await?;
        Ok(Response::new(stream))
    }

    async fn session_input(
        &self,
        request: Request<SessionInputRequest>,
    ) -> Result<Response<()>, Status> {
        let req = request.into_inner();
        self.session_manager
            .session_input(&req.session_id, &req.data)
            .await?;
        Ok(Response::new(()))
    }

    async fn destroy_session(
        &self,
        request: Request<DestroySessionRequest>,
    ) -> Result<Response<()>, Status> {
        let req = request.into_inner();
        self.session_manager
            .destroy_session(&req.session_id)
            .await?;
        Ok(Response::new(()))
    }

    async fn put_file(
        &self,
        _request: Request<Streaming<FileChunk>>,
    ) -> Result<Response<PutFileResponse>, Status> {
        Err(Status::unimplemented("put_file not yet implemented"))
    }

    type GetFileStream = ReceiverStream<Result<FileChunk, Status>>;

    async fn get_file(
        &self,
        _request: Request<GetFileRequest>,
    ) -> Result<Response<Self::GetFileStream>, Status> {
        Err(Status::unimplemented("get_file not yet implemented"))
    }

    async fn list_files(
        &self,
        _request: Request<ListFilesRequest>,
    ) -> Result<Response<ListFilesResponse>, Status> {
        Err(Status::unimplemented("list_files not yet implemented"))
    }

    async fn shutdown(
        &self,
        _request: Request<()>,
    ) -> Result<Response<()>, Status> {
        Err(Status::unimplemented("shutdown not yet implemented"))
    }
}
