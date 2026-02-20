use tonic::transport::Server;

use crate::proto::guest_agent_server::GuestAgentServer;
use crate::service::GuestAgentService;

/// Returns whether vsock is available on this platform.
pub fn is_available() -> bool {
    #[cfg(all(target_os = "linux", feature = "vsock"))]
    {
        true
    }
    #[cfg(not(all(target_os = "linux", feature = "vsock")))]
    {
        false
    }
}

/// Serve the guest agent over TCP (for local development).
pub async fn serve_tcp(
    addr: &str,
    service: GuestAgentService,
) -> Result<(), Box<dyn std::error::Error>> {
    let addr = addr.parse()?;
    Server::builder()
        .add_service(GuestAgentServer::new(service))
        .serve(addr)
        .await?;
    Ok(())
}

/// Serve the guest agent over vsock (production, inside Firecracker microVM).
///
/// Only available on Linux with the `vsock` feature enabled.
#[cfg(all(target_os = "linux", feature = "vsock"))]
pub async fn serve_vsock(
    _cid: u32,
    port: u32,
    service: GuestAgentService,
) -> Result<(), Box<dyn std::error::Error>> {
    use std::pin::Pin;
    use std::task::{Context, Poll};

    use pin_project_lite::pin_project;
    use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
    use tokio_vsock::VsockListener;
    use tonic::transport::server::Connected;

    // Wrapper around VsockStream to implement Connected for tonic.
    pin_project! {
        struct VsockIo {
            #[pin]
            inner: tokio_vsock::VsockStream,
        }
    }

    impl Connected for VsockIo {
        type ConnectInfo = ();
        fn connect_info(&self) -> Self::ConnectInfo {}
    }

    impl AsyncRead for VsockIo {
        fn poll_read(
            self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            self.project().inner.poll_read(cx, buf)
        }
    }

    impl AsyncWrite for VsockIo {
        fn poll_write(
            self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            self.project().inner.poll_write(cx, buf)
        }

        fn poll_flush(
            self: Pin<&mut Self>,
            cx: &mut Context<'_>,
        ) -> Poll<std::io::Result<()>> {
            self.project().inner.poll_flush(cx)
        }

        fn poll_shutdown(
            self: Pin<&mut Self>,
            cx: &mut Context<'_>,
        ) -> Poll<std::io::Result<()>> {
            self.project().inner.poll_shutdown(cx)
        }
    }

    // Create incoming stream from VsockListener.
    let mut listener = VsockListener::bind(port as u64, port)?;
    let incoming = async_stream::stream! {
        loop {
            match listener.accept().await {
                Ok((stream, _addr)) => yield Ok::<_, std::io::Error>(VsockIo { inner: stream }),
                Err(e) => yield Err(e),
            }
        }
    };

    // Pin the stream for serve_with_incoming.
    tokio::pin!(incoming);

    Server::builder()
        .add_service(GuestAgentServer::new(service))
        .serve_with_incoming(incoming)
        .await?;

    Ok(())
}

/// Fallback when vsock is not available.
#[cfg(not(all(target_os = "linux", feature = "vsock")))]
pub async fn serve_vsock(
    _cid: u32,
    _port: u32,
    _service: GuestAgentService,
) -> Result<(), Box<dyn std::error::Error>> {
    Err("vsock is not available on this platform — set SANDCHEST_AGENT_DEV=1 to use TCP".into())
}
