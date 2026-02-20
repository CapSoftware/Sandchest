use std::sync::Arc;

use tracing::info;

use crate::session::SessionManager;

pub async fn shutdown(session_manager: Arc<SessionManager>) {
    info!("Shutdown requested, cleaning up...");

    // Destroy all active sessions
    session_manager.destroy_all().await;

    info!("Cleanup complete, exiting");

    // Exit the process
    std::process::exit(0);
}
