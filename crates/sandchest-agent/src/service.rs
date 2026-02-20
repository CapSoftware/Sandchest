use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request, Response, Status, Streaming};

use crate::proto::guest_agent_server::GuestAgent;
use crate::proto::{
    CreateSessionRequest, DestroySessionRequest, ExecEvent, ExecRequest, FileChunk,
    GetFileRequest, HealthResponse, ListFilesRequest, ListFilesResponse, PutFileResponse,
    SessionExecRequest, SessionInputRequest, SessionResponse,
};

pub struct GuestAgentService;

impl GuestAgentService {
    pub fn new() -> Self {
        Self
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
        _request: Request<ExecRequest>,
    ) -> Result<Response<Self::ExecStream>, Status> {
        Err(Status::unimplemented("exec not yet implemented"))
    }

    async fn create_session(
        &self,
        _request: Request<CreateSessionRequest>,
    ) -> Result<Response<SessionResponse>, Status> {
        Err(Status::unimplemented("create_session not yet implemented"))
    }

    type SessionExecStream = ReceiverStream<Result<ExecEvent, Status>>;

    async fn session_exec(
        &self,
        _request: Request<SessionExecRequest>,
    ) -> Result<Response<Self::SessionExecStream>, Status> {
        Err(Status::unimplemented("session_exec not yet implemented"))
    }

    async fn session_input(
        &self,
        _request: Request<SessionInputRequest>,
    ) -> Result<Response<()>, Status> {
        Err(Status::unimplemented("session_input not yet implemented"))
    }

    async fn destroy_session(
        &self,
        _request: Request<DestroySessionRequest>,
    ) -> Result<Response<()>, Status> {
        Err(Status::unimplemented(
            "destroy_session not yet implemented",
        ))
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
