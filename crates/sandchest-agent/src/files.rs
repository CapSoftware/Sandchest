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

    let mut remaining = Vec::new();
    if !first.done {
        while let Some(chunk) = stream.message().await? {
            let done = chunk.done;
            remaining.push(chunk);
            if done {
                break;
            }
        }
    }

    write_file_chunks(first, remaining).await
}

/// Core file writing logic, separated for testability.
async fn write_file_chunks(
    first: FileChunk,
    remaining: Vec<FileChunk>,
) -> Result<PutFileResponse, Status> {
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

    // Write remaining chunks
    for chunk in &remaining {
        if !chunk.data.is_empty() {
            tokio::io::AsyncWriteExt::write_all(&mut file, &chunk.data)
                .await
                .map_err(|e| Status::internal(format!("write failed: {e}")))?;
            hasher.update(&chunk.data);
            bytes_written += chunk.data.len() as u64;
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
    use tokio_stream::StreamExt;

    #[tokio::test]
    async fn list_files_nonexistent() {
        let result = list_files(ListFilesRequest {
            path: "/nonexistent/path/that/does/not/exist".to_string(),
        })
        .await;
        assert!(result.is_err());
        let status = result.unwrap_err();
        assert_eq!(status.code(), tonic::Code::NotFound);
    }

    #[tokio::test]
    async fn list_files_on_file() {
        let result = list_files(ListFilesRequest {
            path: "/etc/hosts".to_string(),
        })
        .await;
        assert!(result.is_err());
        let status = result.unwrap_err();
        assert_eq!(status.code(), tonic::Code::InvalidArgument);
    }

    #[tokio::test]
    async fn list_files_returns_entries() {
        let dir = tempfile::tempdir().unwrap();
        let dir_path = dir.path().to_string_lossy().to_string();

        // Create files and a subdirectory
        tokio::fs::write(dir.path().join("alpha.txt"), "aaa").await.unwrap();
        tokio::fs::write(dir.path().join("beta.txt"), "bbb").await.unwrap();
        tokio::fs::create_dir(dir.path().join("subdir")).await.unwrap();

        let result = list_files(ListFilesRequest { path: dir_path }).await.unwrap();

        assert_eq!(result.files.len(), 3);
        // Sorted by path
        assert!(result.files[0].path.ends_with("alpha.txt"));
        assert!(result.files[1].path.ends_with("beta.txt"));
        assert!(result.files[2].path.ends_with("subdir"));

        // Check metadata
        assert_eq!(result.files[0].size, 3);
        assert!(!result.files[0].is_dir);
        assert!(result.files[0].modified_at > 0);

        assert!(result.files[2].is_dir);
    }

    #[tokio::test]
    async fn list_files_empty_dir() {
        let dir = tempfile::tempdir().unwrap();
        let result = list_files(ListFilesRequest {
            path: dir.path().to_string_lossy().to_string(),
        })
        .await
        .unwrap();
        assert!(result.files.is_empty());
    }

    #[tokio::test]
    async fn get_file_nonexistent() {
        let stream = spawn_get_file(GetFileRequest {
            path: "/nonexistent/file/abc123".to_string(),
        });
        let events: Vec<_> = stream.collect().await;
        assert_eq!(events.len(), 1);
        assert!(events[0].is_err());
        assert_eq!(events[0].as_ref().unwrap_err().code(), tonic::Code::NotFound);
    }

    #[tokio::test]
    async fn get_file_is_directory() {
        let dir = tempfile::tempdir().unwrap();
        let stream = spawn_get_file(GetFileRequest {
            path: dir.path().to_string_lossy().to_string(),
        });
        let events: Vec<_> = stream.collect().await;
        assert_eq!(events.len(), 1);
        assert!(events[0].is_err());
        assert_eq!(
            events[0].as_ref().unwrap_err().code(),
            tonic::Code::InvalidArgument
        );
    }

    #[tokio::test]
    async fn get_file_small_file() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("test.txt");
        let content = b"hello world";
        tokio::fs::write(&file_path, content).await.unwrap();

        let stream = spawn_get_file(GetFileRequest {
            path: file_path.to_string_lossy().to_string(),
        });
        let events: Vec<_> = stream.collect().await;

        let mut data = Vec::new();
        let mut got_done = false;
        for event in &events {
            let chunk = event.as_ref().unwrap();
            data.extend_from_slice(&chunk.data);
            if chunk.done {
                got_done = true;
            }
        }

        assert!(got_done);
        assert_eq!(data, content);
    }

    #[tokio::test]
    async fn get_file_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("empty.txt");
        tokio::fs::write(&file_path, b"").await.unwrap();

        let stream = spawn_get_file(GetFileRequest {
            path: file_path.to_string_lossy().to_string(),
        });
        let events: Vec<_> = stream.collect().await;

        // Should get a single done chunk with empty data
        assert_eq!(events.len(), 1);
        let chunk = events[0].as_ref().unwrap();
        assert!(chunk.done);
        assert!(chunk.data.is_empty());
    }

    #[tokio::test]
    async fn get_file_offsets_are_correct() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("offsets.bin");
        // Write exactly 2 chunks worth of data to verify offsets
        let data = vec![0xABu8; GET_FILE_CHUNK_SIZE + 100];
        tokio::fs::write(&file_path, &data).await.unwrap();

        let stream = spawn_get_file(GetFileRequest {
            path: file_path.to_string_lossy().to_string(),
        });
        let events: Vec<_> = stream.collect().await;

        let mut prev_offset = 0u64;
        for (i, event) in events.iter().enumerate() {
            let chunk = event.as_ref().unwrap();
            if i == 0 {
                assert_eq!(chunk.offset, 0);
            } else {
                assert_eq!(chunk.offset, prev_offset);
            }
            prev_offset = chunk.offset + chunk.data.len() as u64;
        }
    }

    #[tokio::test]
    async fn write_chunks_creates_file_and_parents() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("a/b/c/test.txt");
        let content = b"put file content";

        let first = FileChunk {
            path: file_path.to_string_lossy().to_string(),
            data: content.to_vec(),
            offset: 0,
            done: true,
        };

        let response = write_file_chunks(first, Vec::new()).await.unwrap();

        assert_eq!(response.bytes_written, content.len() as u64);
        let written = tokio::fs::read(&file_path).await.unwrap();
        assert_eq!(written, content);
    }

    #[tokio::test]
    async fn write_chunks_multi_chunk() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("multi.bin");

        let first = FileChunk {
            path: file_path.to_string_lossy().to_string(),
            data: vec![1, 2, 3],
            offset: 0,
            done: false,
        };

        let remaining = vec![FileChunk {
            path: String::new(),
            data: vec![4, 5, 6],
            offset: 3,
            done: true,
        }];

        let response = write_file_chunks(first, remaining).await.unwrap();

        assert_eq!(response.bytes_written, 6);
        let written = tokio::fs::read(&file_path).await.unwrap();
        assert_eq!(written, vec![1, 2, 3, 4, 5, 6]);
    }

    #[tokio::test]
    async fn write_chunks_missing_path() {
        let first = FileChunk {
            path: String::new(),
            data: vec![1],
            offset: 0,
            done: true,
        };

        let result = write_file_chunks(first, Vec::new()).await;
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().code(), tonic::Code::InvalidArgument);
    }

    #[tokio::test]
    async fn write_chunks_empty_data() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("empty.bin");

        let first = FileChunk {
            path: file_path.to_string_lossy().to_string(),
            data: Vec::new(),
            offset: 0,
            done: true,
        };

        let response = write_file_chunks(first, Vec::new()).await.unwrap();
        assert_eq!(response.bytes_written, 0);

        let written = tokio::fs::read(&file_path).await.unwrap();
        assert!(written.is_empty());
    }

    #[tokio::test]
    async fn write_then_get_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("roundtrip.dat");
        let original = vec![42u8; 1024];

        let first = FileChunk {
            path: file_path.to_string_lossy().to_string(),
            data: original.clone(),
            offset: 0,
            done: true,
        };
        write_file_chunks(first, Vec::new()).await.unwrap();

        // Get
        let stream = spawn_get_file(GetFileRequest {
            path: file_path.to_string_lossy().to_string(),
        });
        let events: Vec<_> = stream.collect().await;

        let mut data = Vec::new();
        for event in &events {
            let chunk = event.as_ref().unwrap();
            data.extend_from_slice(&chunk.data);
        }

        assert_eq!(data, original);
    }
}
