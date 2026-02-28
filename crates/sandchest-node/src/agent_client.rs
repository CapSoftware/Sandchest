use std::time::Duration;

use tracing::{info, warn};

pub mod agent_proto {
    tonic::include_proto!("sandchest.agent.v1");
}

/// Default vsock port the guest agent listens on inside the microVM.
const DEFAULT_AGENT_VSOCK_PORT: u32 = 52;

/// Agent communication endpoint.
///
/// In dev mode (TCP), all sandboxes share a single localhost endpoint.
/// In production, each sandbox has its own Firecracker vsock UDS path.
#[derive(Debug, Clone)]
pub enum AgentEndpoint {
    /// TCP endpoint (dev mode). e.g. `http://127.0.0.1:8052`
    Tcp(String),
    /// Unix domain socket path for Firecracker vsock on the host.
    /// e.g. `/var/sandchest/sandboxes/sb_xxx/vsock.sock_52`
    Uds(String),
}

impl std::fmt::Display for AgentEndpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AgentEndpoint::Tcp(uri) => write!(f, "{}", uri),
            AgentEndpoint::Uds(path) => write!(f, "unix:{}", path),
        }
    }
}

/// Client for communicating with the guest agent inside a Firecracker microVM.
///
/// In production, connects via Firecracker's host-side vsock UDS socket.
/// In dev mode (TCP), connects to localhost.
pub struct AgentClient {
    endpoint: AgentEndpoint,
}

impl AgentClient {
    pub fn new(endpoint: AgentEndpoint) -> Self {
        Self { endpoint }
    }

    /// Construct the TCP dev-mode endpoint.
    ///
    /// In dev mode, the guest agent listens on TCP instead of vsock.
    /// Connects to localhost on the agent's dev port (default 8052).
    pub fn dev_endpoint() -> AgentEndpoint {
        let port = std::env::var("SANDCHEST_AGENT_DEV_PORT")
            .ok()
            .and_then(|s| s.parse::<u16>().ok())
            .unwrap_or(8052);
        AgentEndpoint::Tcp(format!("http://127.0.0.1:{}", port))
    }

    /// Construct a vsock UDS endpoint from the Firecracker vsock socket path.
    ///
    /// Firecracker exposes vsock as a Unix domain socket on the host. When the
    /// guest agent listens on vsock port N, the host connects to `{uds_path}_{N}`.
    pub fn vsock_endpoint(vsock_uds_path: &str) -> AgentEndpoint {
        let port: u32 = std::env::var("SANDCHEST_AGENT_VSOCK_PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(DEFAULT_AGENT_VSOCK_PORT);
        AgentEndpoint::Uds(format!("{}_{}", vsock_uds_path, port))
    }

    /// Determine the agent endpoint for a sandbox.
    ///
    /// In dev mode (`SANDCHEST_AGENT_DEV=1`), returns a shared TCP endpoint.
    /// In production, returns the per-sandbox vsock UDS endpoint.
    pub fn endpoint_for_sandbox(vsock_uds_path: &str) -> AgentEndpoint {
        if is_dev_mode() {
            Self::dev_endpoint()
        } else {
            Self::vsock_endpoint(vsock_uds_path)
        }
    }

    /// Poll the guest agent's Health RPC until it reports ready.
    ///
    /// Retries every 100ms up to `timeout`. Used after VM boot to confirm
    /// the guest agent is running and accepting requests.
    pub async fn wait_for_health(
        endpoint: &AgentEndpoint,
        timeout: Duration,
    ) -> Result<(), AgentClientError> {
        let start = tokio::time::Instant::now();
        let interval = Duration::from_millis(100);

        info!(endpoint = %endpoint, timeout_ms = timeout.as_millis(), "waiting for guest agent health");

        while start.elapsed() < timeout {
            match Self::check_health_once(endpoint).await {
                Ok(true) => {
                    let elapsed = start.elapsed().as_millis();
                    info!(endpoint = %endpoint, elapsed_ms = elapsed, "guest agent is healthy");
                    return Ok(());
                }
                Ok(false) => {
                    warn!(endpoint = %endpoint, "agent responded but not ready");
                }
                Err(_) => {
                    // Connection refused or timeout — agent not ready yet
                }
            }
            tokio::time::sleep(interval).await;
        }

        Err(AgentClientError::HealthTimeout(format!(
            "guest agent at {} did not become healthy within {:?}",
            endpoint, timeout
        )))
    }

    async fn check_health_once(endpoint: &AgentEndpoint) -> Result<bool, AgentClientError> {
        let channel =
            make_channel(endpoint, Duration::from_secs(2), Duration::from_secs(5)).await?;

        let mut client = agent_proto::guest_agent_client::GuestAgentClient::new(channel);
        let response = client.health(()).await.map_err(|e| {
            AgentClientError::Rpc(format!("health RPC failed: {}", e))
        })?;

        Ok(response.into_inner().ready)
    }

    /// Connect and return a reusable gRPC client handle.
    pub async fn connect(
        &self,
    ) -> Result<agent_proto::guest_agent_client::GuestAgentClient<tonic::transport::Channel>, AgentClientError>
    {
        let channel =
            make_channel(&self.endpoint, Duration::from_secs(5), Duration::from_secs(300)).await?;

        Ok(agent_proto::guest_agent_client::GuestAgentClient::new(channel))
    }
}

fn is_dev_mode() -> bool {
    std::env::var("SANDCHEST_AGENT_DEV").unwrap_or_default() == "1"
}

/// Create a tonic channel for the given endpoint.
///
/// For TCP endpoints, connects directly via tonic's built-in HTTP transport.
/// For UDS endpoints, uses a custom Unix socket connector to reach the
/// Firecracker vsock proxy on the host.
async fn make_channel(
    endpoint: &AgentEndpoint,
    connect_timeout: Duration,
    request_timeout: Duration,
) -> Result<tonic::transport::Channel, AgentClientError> {
    match endpoint {
        AgentEndpoint::Tcp(uri) => {
            tonic::transport::Channel::from_shared(uri.clone())
                .map_err(|e| AgentClientError::Connection(format!("invalid endpoint: {}", e)))?
                .connect_timeout(connect_timeout)
                .timeout(request_timeout)
                .connect()
                .await
                .map_err(|e| AgentClientError::Connection(format!("connect failed: {}", e)))
        }
        AgentEndpoint::Uds(path) => {
            let connector = UdsConnector {
                path: path.clone(),
            };
            // The URI is unused — the connector ignores it and connects to the
            // UDS path directly. We still need a valid URI for HTTP/2 framing.
            tonic::transport::Endpoint::from_static("http://[::1]:0")
                .connect_timeout(connect_timeout)
                .timeout(request_timeout)
                .connect_with_connector(connector)
                .await
                .map_err(|e| AgentClientError::Connection(format!("connect failed: {}", e)))
        }
    }
}

/// Tower service that connects to a Unix domain socket.
///
/// Used as a custom tonic connector to reach the Firecracker vsock UDS
/// proxy. The URI parameter is ignored — all connections go to the
/// configured socket path.
#[derive(Clone)]
struct UdsConnector {
    path: String,
}

impl tower::Service<http::Uri> for UdsConnector {
    type Response = hyper_util::rt::TokioIo<tokio::net::UnixStream>;
    type Error = std::io::Error;
    type Future =
        std::pin::Pin<Box<dyn std::future::Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(
        &mut self,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), Self::Error>> {
        std::task::Poll::Ready(Ok(()))
    }

    fn call(&mut self, _uri: http::Uri) -> Self::Future {
        let path = self.path.clone();
        Box::pin(async move {
            let stream = tokio::net::UnixStream::connect(&path).await?;
            Ok(hyper_util::rt::TokioIo::new(stream))
        })
    }
}

#[derive(Debug)]
pub enum AgentClientError {
    HealthTimeout(String),
    Connection(String),
    Rpc(String),
}

impl std::fmt::Display for AgentClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AgentClientError::HealthTimeout(msg) => write!(f, "health timeout: {}", msg),
            AgentClientError::Connection(msg) => write!(f, "connection error: {}", msg),
            AgentClientError::Rpc(msg) => write!(f, "RPC error: {}", msg),
        }
    }
}

impl std::error::Error for AgentClientError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_endpoint_returns_tcp() {
        let endpoint = AgentClient::dev_endpoint();
        assert!(matches!(endpoint, AgentEndpoint::Tcp(_)));
        assert!(endpoint.to_string().starts_with("http://127.0.0.1:"));
    }

    #[test]
    fn vsock_endpoint_returns_uds_with_port_suffix() {
        let endpoint = AgentClient::vsock_endpoint("/var/sandchest/sandboxes/sb_test/vsock.sock");
        assert!(matches!(endpoint, AgentEndpoint::Uds(_)));
        match endpoint {
            AgentEndpoint::Uds(path) => {
                assert!(path.ends_with("_52") || path.contains("vsock.sock_"));
                assert!(path.starts_with("/var/sandchest/sandboxes/sb_test/vsock.sock_"));
            }
            _ => panic!("expected Uds variant"),
        }
    }

    #[test]
    fn endpoint_for_sandbox_dev_mode() {
        std::env::set_var("SANDCHEST_AGENT_DEV", "1");
        let endpoint = AgentClient::endpoint_for_sandbox("/var/sandchest/sandboxes/sb_x/vsock.sock");
        assert!(matches!(endpoint, AgentEndpoint::Tcp(_)));
        std::env::remove_var("SANDCHEST_AGENT_DEV");
    }

    #[test]
    fn endpoint_for_sandbox_production_mode() {
        std::env::remove_var("SANDCHEST_AGENT_DEV");
        let endpoint =
            AgentClient::endpoint_for_sandbox("/var/sandchest/sandboxes/sb_x/vsock.sock");
        assert!(matches!(endpoint, AgentEndpoint::Uds(_)));
    }

    #[test]
    fn agent_endpoint_tcp_display() {
        let endpoint = AgentEndpoint::Tcp("http://127.0.0.1:8052".to_string());
        assert_eq!(endpoint.to_string(), "http://127.0.0.1:8052");
    }

    #[test]
    fn agent_endpoint_uds_display() {
        let endpoint = AgentEndpoint::Uds("/var/sandchest/sandboxes/sb_x/vsock.sock_52".to_string());
        assert_eq!(
            endpoint.to_string(),
            "unix:/var/sandchest/sandboxes/sb_x/vsock.sock_52"
        );
    }

    #[test]
    fn agent_endpoint_clone() {
        let endpoint = AgentEndpoint::Uds("/path/vsock.sock_52".to_string());
        let cloned = endpoint.clone();
        assert_eq!(endpoint.to_string(), cloned.to_string());
    }

    #[test]
    fn agent_endpoint_debug() {
        let endpoint = AgentEndpoint::Tcp("http://localhost:8052".to_string());
        let debug = format!("{:?}", endpoint);
        assert!(debug.contains("Tcp"));
        assert!(debug.contains("localhost"));
    }

    #[test]
    fn agent_client_new_stores_endpoint() {
        let endpoint = AgentEndpoint::Tcp("http://localhost:9090".to_string());
        let client = AgentClient::new(endpoint);
        assert!(matches!(client.endpoint, AgentEndpoint::Tcp(ref uri) if uri == "http://localhost:9090"));
    }

    #[test]
    fn agent_client_error_health_timeout_display() {
        let err = AgentClientError::HealthTimeout("10s elapsed".to_string());
        assert_eq!(err.to_string(), "health timeout: 10s elapsed");
    }

    #[test]
    fn agent_client_error_connection_display() {
        let err = AgentClientError::Connection("refused".to_string());
        assert_eq!(err.to_string(), "connection error: refused");
    }

    #[test]
    fn agent_client_error_rpc_display() {
        let err = AgentClientError::Rpc("deadline exceeded".to_string());
        assert_eq!(err.to_string(), "RPC error: deadline exceeded");
    }

    #[test]
    fn agent_client_error_is_std_error() {
        let err = AgentClientError::HealthTimeout("test".to_string());
        let _: &dyn std::error::Error = &err;
    }

    #[test]
    fn agent_client_error_debug() {
        let err = AgentClientError::Connection("test".to_string());
        let debug = format!("{:?}", err);
        assert!(debug.contains("Connection"));
        assert!(debug.contains("test"));
    }

    #[test]
    fn is_dev_mode_false_when_unset() {
        std::env::remove_var("SANDCHEST_AGENT_DEV");
        assert!(!is_dev_mode());
    }

    #[test]
    fn is_dev_mode_true_when_set() {
        std::env::set_var("SANDCHEST_AGENT_DEV", "1");
        assert!(is_dev_mode());
        std::env::remove_var("SANDCHEST_AGENT_DEV");
    }

    #[test]
    fn is_dev_mode_false_for_other_values() {
        std::env::set_var("SANDCHEST_AGENT_DEV", "0");
        assert!(!is_dev_mode());
        std::env::set_var("SANDCHEST_AGENT_DEV", "true");
        assert!(!is_dev_mode());
        std::env::remove_var("SANDCHEST_AGENT_DEV");
    }

    #[test]
    fn vsock_endpoint_custom_port() {
        std::env::set_var("SANDCHEST_AGENT_VSOCK_PORT", "100");
        let endpoint = AgentClient::vsock_endpoint("/path/vsock.sock");
        match endpoint {
            AgentEndpoint::Uds(path) => assert_eq!(path, "/path/vsock.sock_100"),
            _ => panic!("expected Uds variant"),
        }
        std::env::remove_var("SANDCHEST_AGENT_VSOCK_PORT");
    }

    #[tokio::test]
    async fn wait_for_health_timeout_on_unreachable_tcp() {
        let endpoint = AgentEndpoint::Tcp("http://127.0.0.1:1".to_string());
        let result =
            AgentClient::wait_for_health(&endpoint, Duration::from_millis(200)).await;
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            AgentClientError::HealthTimeout(_)
        ));
    }

    #[tokio::test]
    async fn wait_for_health_timeout_on_unreachable_uds() {
        let endpoint =
            AgentEndpoint::Uds("/tmp/sandchest-nonexistent-vsock.sock_52".to_string());
        let result =
            AgentClient::wait_for_health(&endpoint, Duration::from_millis(200)).await;
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            AgentClientError::HealthTimeout(_)
        ));
    }

    #[tokio::test]
    async fn connect_fails_on_unreachable_tcp_endpoint() {
        let client = AgentClient::new(AgentEndpoint::Tcp("http://127.0.0.1:1".to_string()));
        let result = client.connect().await;
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            AgentClientError::Connection(_)
        ));
    }

    #[tokio::test]
    async fn connect_fails_on_nonexistent_uds() {
        let client = AgentClient::new(AgentEndpoint::Uds(
            "/tmp/sandchest-nonexistent-vsock.sock_52".to_string(),
        ));
        let result = client.connect().await;
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            AgentClientError::Connection(_)
        ));
    }

    #[test]
    fn uds_connector_clone() {
        let connector = UdsConnector {
            path: "/path/vsock.sock_52".to_string(),
        };
        let cloned = connector.clone();
        assert_eq!(connector.path, cloned.path);
    }
}
