use std::time::Duration;

use tracing::{info, warn};

pub mod agent_proto {
    tonic::include_proto!("sandchest.agent.v1");
}

/// Client for communicating with the guest agent inside a Firecracker microVM.
///
/// In production, connects via vsock. In dev mode (TCP), connects to localhost.
pub struct AgentClient {
    endpoint: String,
}

impl AgentClient {
    /// Create a new agent client.
    ///
    /// `endpoint` is a gRPC endpoint URI, e.g. `http://127.0.0.1:8052` for TCP dev mode.
    /// Vsock connections will be added when vsock support is wired up.
    pub fn new(endpoint: &str) -> Self {
        Self {
            endpoint: endpoint.to_string(),
        }
    }

    /// Construct the TCP dev-mode endpoint from a vsock path.
    ///
    /// In dev mode, the guest agent listens on TCP instead of vsock. We connect
    /// to localhost on the agent's dev port (default 8052).
    pub fn dev_endpoint() -> String {
        let port = std::env::var("SANDCHEST_AGENT_DEV_PORT")
            .ok()
            .and_then(|s| s.parse::<u16>().ok())
            .unwrap_or(8052);
        format!("http://127.0.0.1:{}", port)
    }

    /// Poll the guest agent's Health RPC until it reports ready.
    ///
    /// Retries every 100ms up to `timeout`. Used after VM boot to confirm
    /// the guest agent is running and accepting requests.
    pub async fn wait_for_health(
        endpoint: &str,
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

    async fn check_health_once(endpoint: &str) -> Result<bool, AgentClientError> {
        let channel = tonic::transport::Channel::from_shared(endpoint.to_string())
            .map_err(|e| AgentClientError::Connection(format!("invalid endpoint: {}", e)))?
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(5))
            .connect()
            .await
            .map_err(|e| AgentClientError::Connection(format!("connect failed: {}", e)))?;

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
        let channel = tonic::transport::Channel::from_shared(self.endpoint.clone())
            .map_err(|e| AgentClientError::Connection(format!("invalid endpoint: {}", e)))?
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(300))
            .connect()
            .await
            .map_err(|e| {
                AgentClientError::Connection(format!(
                    "failed to connect to agent at {}: {}",
                    self.endpoint, e
                ))
            })?;

        Ok(agent_proto::guest_agent_client::GuestAgentClient::new(channel))
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
    fn agent_client_new_stores_endpoint() {
        let client = AgentClient::new("http://localhost:9090");
        assert_eq!(client.endpoint, "http://localhost:9090");
    }

    #[test]
    fn dev_endpoint_default_port() {
        // Without env var set, should use 8052
        let endpoint = AgentClient::dev_endpoint();
        assert!(endpoint.starts_with("http://127.0.0.1:"));
        // Can't assert exact port since env var might be set in test env
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

    #[tokio::test]
    async fn wait_for_health_timeout_on_unreachable() {
        let result =
            AgentClient::wait_for_health("http://127.0.0.1:1", Duration::from_millis(200)).await;
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            AgentClientError::HealthTimeout(_)
        ));
    }

    #[tokio::test]
    async fn connect_fails_on_unreachable_endpoint() {
        let client = AgentClient::new("http://127.0.0.1:1");
        let result = client.connect().await;
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            AgentClientError::Connection(_)
        ));
    }
}
