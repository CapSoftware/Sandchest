use std::path::Path;

use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use tonic::{Status, Streaming};

use crate::proto::{FileChunk, FileInfo, GetFileRequest, ListFilesRequest, ListFilesResponse, PutFileResponse};

const GET_FILE_CHUNK_SIZE: usize = 64 * 1024; // 64 KB

pub async fn put_file(mut stream: Streaming<FileChunk>) -> Result<PutFileResponse, Status> {
    let first = stream
        .message()
        .await?
        .ok_or_else(|| Status::invalid_argument("empty file stream"))?;

    if first.path.is_empty() {
        return Err(Status::invalid_argument("first chunk must include path"));
    }

    let dest = Path::new(&first.path);

    // Create parent directories
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| Status::internal(format!("failed to create directories: {e}")))?;
    }

    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| Status::internal(format!("failed to create file: {e}")))?;

    let mut hasher = Sha256::new();
    let mut bytes_written: u64 = 0;

    // Write first chunk
    if !first.data.is_empty() {
        tokio::io::AsyncWriteExt::write_all(&mut file, &first.data)
            .await
            .map_err(|e| Status::internal(format!("write failed: {e}")))?;
        hasher.update(&first.data);
        bytes_written += first.data.len() as u64;
    }

    if !first.done {
        // Read remaining chunks
        while let Some(chunk) = stream.message().await? {
            if !chunk.data.is_empty() {
                tokio::io::AsyncWriteExt::write_all(&mut file, &chunk.data)
                    .await
                    .map_err(|e| Status::internal(format!("write failed: {e}")))?;
                hasher.update(&chunk.data);
                bytes_written += chunk.data.len() as u64;
            }
            if chunk.done {
                break;
            }
        }
    }

    tokio::io::AsyncWriteExt::flush(&mut file)
        .await
        .map_err(|e| Status::internal(format!("flush failed: {e}")))?;

    let _checksum = format!("{:x}", hasher.finalize());

    Ok(PutFileResponse { bytes_written })
}

pub fn spawn_get_file(
    request: GetFileRequest,
) -> tokio_stream::wrappers::ReceiverStream<Result<FileChunk, Status>> {
    let (tx, rx) = tokio::sync::mpsc::channel(32);

    tokio::spawn(async move {
        if let Err(e) = run_get_file(request, &tx).await {
            let _ = tx.send(Err(e)).await;
        }
    });

    tokio_stream::wrappers::ReceiverStream::new(rx)
}

async fn run_get_file(
    request: GetFileRequest,
    tx: &tokio::sync::mpsc::Sender<Result<FileChunk, Status>>,
) -> Result<(), Status> {
    let path = Path::new(&request.path);

    if !path.exists() {
        return Err(Status::not_found(format!(
            "file not found: {}",
            request.path
        )));
    }

    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|e| Status::internal(format!("failed to read metadata: {e}")))?;

    if metadata.is_dir() {
        return Err(Status::invalid_argument(format!(
            "path is a directory: {}",
            request.path
        )));
    }

    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| Status::internal(format!("failed to open file: {e}")))?;

    let mut buf = vec![0u8; GET_FILE_CHUNK_SIZE];
    let mut offset: u64 = 0;

    loop {
        let n = file
            .read(&mut buf)
            .await
            .map_err(|e| Status::internal(format!("read failed: {e}")))?;

        if n == 0 {
            // Send final empty chunk with done=true
            let chunk = FileChunk {
                path: request.path.clone(),
                data: Vec::new(),
                offset,
                done: true,
            };
            tx.send(Ok(chunk))
                .await
                .map_err(|_| Status::cancelled("client disconnected"))?;
            break;
        }

        let done = n < GET_FILE_CHUNK_SIZE;
        let chunk = FileChunk {
            path: request.path.clone(),
            data: buf[..n].to_vec(),
            offset,
            done,
        };
        offset += n as u64;

        tx.send(Ok(chunk))
            .await
            .map_err(|_| Status::cancelled("client disconnected"))?;

        if done {
            break;
        }
    }

    Ok(())
}

pub async fn list_files(request: ListFilesRequest) -> Result<ListFilesResponse, Status> {
    let path = Path::new(&request.path);

    if !path.exists() {
        return Err(Status::not_found(format!(
            "path not found: {}",
            request.path
        )));
    }

    if !path.is_dir() {
        return Err(Status::invalid_argument(format!(
            "path is not a directory: {}",
            request.path
        )));
    }

    let mut entries = tokio::fs::read_dir(path)
        .await
        .map_err(|e| Status::internal(format!("failed to read directory: {e}")))?;

    let mut files = Vec::new();

    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| Status::internal(format!("failed to read entry: {e}")))?
    {
        let metadata = match entry.metadata().await {
            Ok(m) => m,
            Err(_) => continue, // skip entries we can't stat
        };

        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        files.push(FileInfo {
            path: entry.path().to_string_lossy().to_string(),
            size: metadata.len(),
            is_dir: metadata.is_dir(),
            modified_at,
        });
    }

    // Sort by name for deterministic output
    files.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(ListFilesResponse { files })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_list_files_nonexistent() {
        let result = list_files(ListFilesRequest {
            path: "/nonexistent/path/that/does/not/exist".to_string(),
        })
        .await;
        assert!(result.is_err());
        let status = result.unwrap_err();
        assert_eq!(status.code(), tonic::Code::NotFound);
    }

    #[tokio::test]
    async fn test_list_files_on_file() {
        // /etc/hosts is a file, not a directory
        let result = list_files(ListFilesRequest {
            path: "/etc/hosts".to_string(),
        })
        .await;
        // On macOS/Linux this should be InvalidArgument (not a directory)
        // or NotFound if it doesn't exist
        assert!(result.is_err());
    }
}
