mod exec;
mod files;
mod proc;
mod service;
mod session;
mod shutdown;
mod snapshot;
mod vsock;

pub mod proto {
    tonic::include_proto!("sandchest.agent.v1");
}

use tracing::info;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    // Create service first so we have access to the session manager
    let service = service::GuestAgentService::new();
    let session_manager = service.session_manager();

    // Check for snapshot restore at startup (warm boot from snapshot)
    if snapshot::detect_snapshot_restore() {
        snapshot::handle_restore();
    }

    // Start snapshot watcher: combines heartbeat writing + continuous restore detection.
    // On fork, the watcher detects the stale heartbeat and runs full recovery
    // (destroy sessions, re-seed randomness, correct clock, kill orphaned processes).
    snapshot::start_snapshot_watcher(session_manager);

    let tcp_port: u16 = std::env::var("SANDCHEST_AGENT_TCP_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(50052);

    let vsock_port: u32 = std::env::var("SANDCHEST_AGENT_VSOCK_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(52);

    let use_tcp = std::env::var("SANDCHEST_AGENT_DEV").is_ok() || !vsock::is_available();

    if use_tcp {
        let addr = format!("0.0.0.0:{tcp_port}");
        info!("Guest agent ready on TCP {addr} (dev mode)");
        vsock::serve_tcp(&addr, service).await?;
    } else {
        info!("Guest agent ready on vsock CID=3 port={vsock_port}");
        vsock::serve_vsock(3, vsock_port, service).await?;
    }

    Ok(())
}
