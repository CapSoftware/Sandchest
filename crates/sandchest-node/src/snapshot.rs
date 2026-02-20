use std::time::Duration;

use tracing::info;

/// Firecracker API client that communicates over a Unix domain socket.
pub struct FirecrackerApi {
    api_socket_path: String,
}

impl FirecrackerApi {
    pub fn new(api_socket_path: &str) -> Self {
        Self {
            api_socket_path: api_socket_path.to_string(),
        }
    }

    /// Wait for the Firecracker API socket to become available.
    pub async fn wait_for_ready(&self, timeout: Duration) -> Result<(), SnapshotError> {
        let start = tokio::time::Instant::now();
        let interval = Duration::from_millis(100);

        while start.elapsed() < timeout {
            if std::path::Path::new(&self.api_socket_path).exists() {
                return Ok(());
            }
            tokio::time::sleep(interval).await;
        }

        Err(SnapshotError::Timeout(format!(
            "Firecracker API socket {} not ready after {:?}",
            self.api_socket_path, timeout
        )))
    }

    /// Send an HTTP request to the Firecracker API via Unix socket.
    async fn send_request(
        &self,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> Result<(u16, String), SnapshotError> {
        use std::os::unix::net::UnixStream as StdUnixStream;
        use std::io::{Read, Write};

        let socket_path = self.api_socket_path.clone();
        let method = method.to_string();
        let path = path.to_string();
        let body = body.map(|s| s.to_string());

        // Firecracker's API is simple HTTP/1.1 over Unix socket.
        // Use a blocking approach in spawn_blocking since hyper-unix-socket
        // compatibility can be fragile.
        tokio::task::spawn_blocking(move || {
            let mut stream = StdUnixStream::connect(&socket_path).map_err(|e| {
                SnapshotError::Api(format!("failed to connect to {}: {}", socket_path, e))
            })?;

            let body_str = body.unwrap_or_default();
            let content_length = body_str.len();

            let request = if content_length > 0 {
                format!(
                    "{} {} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nAccept: application/json\r\n\r\n{}",
                    method, path, content_length, body_str
                )
            } else {
                format!(
                    "{} {} HTTP/1.1\r\nHost: localhost\r\nAccept: application/json\r\n\r\n",
                    method, path
                )
            };

            stream.write_all(request.as_bytes()).map_err(|e| {
                SnapshotError::Api(format!("failed to write request: {}", e))
            })?;

            stream.set_read_timeout(Some(Duration::from_secs(30))).ok();

            let mut response = String::new();
            let mut buf = [0u8; 4096];
            loop {
                match stream.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        response.push_str(&String::from_utf8_lossy(&buf[..n]));
                        // Check if we've received the full response
                        if response.contains("\r\n\r\n") {
                            // For simplicity, check if body is complete
                            // Firecracker responses are small
                            if let Some(body_start) = response.find("\r\n\r\n") {
                                let headers = &response[..body_start];
                                if let Some(cl) = parse_content_length(headers) {
                                    let body_so_far = response[body_start + 4..].len();
                                    if body_so_far >= cl {
                                        break;
                                    }
                                } else {
                                    // No content-length, assume response is complete
                                    break;
                                }
                            }
                        }
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(e) => {
                        return Err(SnapshotError::Api(format!("failed to read response: {}", e)));
                    }
                }
            }

            // Parse HTTP status code
            let status_code = parse_status_code(&response)?;
            let body = response
                .find("\r\n\r\n")
                .map(|i| response[i + 4..].to_string())
                .unwrap_or_default();

            Ok((status_code, body))
        })
        .await
        .map_err(|e| SnapshotError::Api(format!("spawn_blocking failed: {}", e)))?
    }

    /// Load a snapshot into a Firecracker VM.
    ///
    /// `PUT /snapshot/load` with snapshot_path and mem_file_path.
    pub async fn restore_snapshot(
        &self,
        snapshot_path: &str,
        mem_path: &str,
    ) -> Result<(), SnapshotError> {
        info!(
            snapshot_path = %snapshot_path,
            mem_path = %mem_path,
            "loading snapshot"
        );

        let body = format!(
            r#"{{"snapshot_path":"{}","mem_file_path":"{}","enable_diff_snapshots":false,"resume_vm":false}}"#,
            snapshot_path, mem_path
        );

        let (status, resp_body) = self.send_request("PUT", "/snapshot/load", Some(&body)).await?;
        if status >= 300 {
            return Err(SnapshotError::Api(format!(
                "PUT /snapshot/load returned {}: {}",
                status, resp_body
            )));
        }

        info!("snapshot loaded successfully");
        Ok(())
    }

    /// Resume a paused VM.
    ///
    /// `PATCH /vm` with `state: "Resumed"`.
    pub async fn resume_vm(&self) -> Result<(), SnapshotError> {
        info!("resuming VM");

        let body = r#"{"state":"Resumed"}"#;
        let (status, resp_body) = self.send_request("PATCH", "/vm", Some(body)).await?;
        if status >= 300 {
            return Err(SnapshotError::Api(format!(
                "PATCH /vm Resumed returned {}: {}",
                status, resp_body
            )));
        }

        info!("VM resumed");
        Ok(())
    }

    /// Pause a running VM.
    ///
    /// `PATCH /vm` with `state: "Paused"`.
    pub async fn pause_vm(&self) -> Result<(), SnapshotError> {
        info!("pausing VM");

        let body = r#"{"state":"Paused"}"#;
        let (status, resp_body) = self.send_request("PATCH", "/vm", Some(body)).await?;
        if status >= 300 {
            return Err(SnapshotError::Api(format!(
                "PATCH /vm Paused returned {}: {}",
                status, resp_body
            )));
        }

        info!("VM paused");
        Ok(())
    }

    /// Take a snapshot of a paused VM.
    ///
    /// `PUT /snapshot/create` with snapshot_path and mem_file_path.
    pub async fn take_snapshot(
        &self,
        snapshot_path: &str,
        mem_path: &str,
    ) -> Result<(), SnapshotError> {
        info!(
            snapshot_path = %snapshot_path,
            mem_path = %mem_path,
            "taking snapshot"
        );

        let body = format!(
            r#"{{"snapshot_type":"Full","snapshot_path":"{}","mem_file_path":"{}"}}"#,
            snapshot_path, mem_path
        );

        let (status, resp_body) = self.send_request("PUT", "/snapshot/create", Some(&body)).await?;
        if status >= 300 {
            return Err(SnapshotError::Api(format!(
                "PUT /snapshot/create returned {}: {}",
                status, resp_body
            )));
        }

        info!("snapshot taken successfully");
        Ok(())
    }
}

fn parse_status_code(response: &str) -> Result<u16, SnapshotError> {
    // Parse "HTTP/1.1 204 No Content" or similar
    let first_line = response.lines().next().unwrap_or("");
    let parts: Vec<&str> = first_line.split_whitespace().collect();
    if parts.len() < 2 {
        return Err(SnapshotError::Api(format!(
            "invalid HTTP response: {}",
            first_line
        )));
    }
    parts[1].parse::<u16>().map_err(|_| {
        SnapshotError::Api(format!("invalid status code in: {}", first_line))
    })
}

fn parse_content_length(headers: &str) -> Option<usize> {
    for line in headers.lines() {
        let lower = line.to_lowercase();
        if lower.starts_with("content-length:") {
            return lower
                .strip_prefix("content-length:")
                .and_then(|v| v.trim().parse().ok());
        }
    }
    None
}

#[derive(Debug)]
pub enum SnapshotError {
    Timeout(String),
    Api(String),
}

impl std::fmt::Display for SnapshotError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SnapshotError::Timeout(msg) => write!(f, "timeout: {}", msg),
            SnapshotError::Api(msg) => write!(f, "firecracker API error: {}", msg),
        }
    }
}

impl std::error::Error for SnapshotError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_status_code_works() {
        assert_eq!(parse_status_code("HTTP/1.1 200 OK").unwrap(), 200);
        assert_eq!(parse_status_code("HTTP/1.1 204 No Content").unwrap(), 204);
        assert_eq!(parse_status_code("HTTP/1.1 400 Bad Request").unwrap(), 400);
    }

    #[test]
    fn parse_content_length_works() {
        assert_eq!(
            parse_content_length("Content-Length: 42\r\nOther: val"),
            Some(42)
        );
        assert_eq!(
            parse_content_length("content-length: 100\r\n"),
            Some(100)
        );
        assert_eq!(parse_content_length("No-CL-Header: true"), None);
    }

    #[tokio::test]
    async fn firecracker_api_wait_for_ready_timeout() {
        let api = FirecrackerApi::new("/tmp/nonexistent-socket-xyz.sock");
        let result = api.wait_for_ready(Duration::from_millis(200)).await;
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), SnapshotError::Timeout(_)));
    }
}
