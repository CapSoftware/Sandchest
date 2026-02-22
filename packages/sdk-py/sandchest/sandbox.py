"""Sandbox — an isolated Firecracker microVM."""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import TYPE_CHECKING

from .errors import TimeoutError
from .session import Session
from .stream import ExecStream, parse_sse
from .types import (
    Artifact,
    ExecResult,
    FileEntry,
    ForkTree,
    ForkTreeNode,
    RegisterArtifactsResult,
    SandboxStatus,
)

if TYPE_CHECKING:
    from .http import HttpClient

WAIT_READY_DEFAULT_TIMEOUT_MS = 120_000
WAIT_READY_POLL_INTERVAL_S = 1.0


class Sandbox:
    """A Sandchest sandbox — an isolated Firecracker microVM.

    All operations hang off this instance. Use ``Sandchest.create()``
    or ``Sandchest.get()`` to obtain an instance.
    """

    def __init__(
        self,
        id: str,
        status: SandboxStatus,
        replay_url: str,
        http: HttpClient,
    ) -> None:
        self.id = id
        self.status: SandboxStatus = status
        self.replay_url = replay_url
        self._http = http

    # -- Context manager support -----------------------------------------------

    def __enter__(self) -> Sandbox:
        return self

    def __exit__(self, *_: object) -> None:
        if self.status == "running":
            self.stop()

    # -- Execution -------------------------------------------------------------

    def exec(
        self,
        cmd: str | list[str],
        *,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout: int | None = None,
        stream: bool = False,
        on_stdout: Callable[[str], None] | None = None,
        on_stderr: Callable[[str], None] | None = None,
    ) -> ExecResult | ExecStream:
        """Execute a command in the sandbox.

        Args:
            cmd: Command string or list of args.
            cwd: Working directory.
            env: Environment variables.
            timeout: Timeout in seconds.
            stream: If True, return an ExecStream for event-by-event iteration.
            on_stdout: Callback for each stdout chunk (triggers streaming internally).
            on_stderr: Callback for each stderr chunk (triggers streaming internally).

        Returns:
            ExecResult when stream=False (default), ExecStream when stream=True.
        """
        if stream:
            return self._exec_stream(cmd, cwd=cwd, env=env, timeout=timeout)
        if on_stdout or on_stderr:
            return self._exec_with_callbacks(
                cmd,
                cwd=cwd,
                env=env,
                timeout=timeout,
                on_stdout=on_stdout,
                on_stderr=on_stderr,
            )
        return self._exec_blocking(cmd, cwd=cwd, env=env, timeout=timeout)

    # -- Lifecycle -------------------------------------------------------------

    def fork(
        self,
        *,
        env: dict[str, str] | None = None,
        ttl_seconds: int | None = None,
    ) -> Sandbox:
        """Fork this sandbox's entire state into a new sandbox."""
        res = self._http.request(
            "POST",
            f"/v1/sandboxes/{self.id}/fork",
            body={
                "env": env,
                "ttl_seconds": ttl_seconds,
            },
        )
        return Sandbox(res["sandbox_id"], res["status"], res["replay_url"], self._http)

    def forks(self) -> ForkTree:
        """Get the fork tree rooted at this sandbox."""
        res = self._http.request(
            "GET",
            f"/v1/sandboxes/{self.id}/forks",
        )
        return ForkTree(
            root=res["root"],
            tree=[
                ForkTreeNode(
                    sandbox_id=n["sandbox_id"],
                    status=n["status"],
                    forked_from=n.get("forked_from"),
                    forked_at=n.get("forked_at"),
                    children=n.get("children", []),
                )
                for n in res["tree"]
            ],
        )

    def stop(self) -> None:
        """Gracefully stop this sandbox (collects artifacts)."""
        res = self._http.request(
            "POST",
            f"/v1/sandboxes/{self.id}/stop",
        )
        self.status = res["status"]

    def destroy(self) -> None:
        """Hard stop and clean up this sandbox."""
        self._http.request(
            "DELETE",
            f"/v1/sandboxes/{self.id}",
        )
        self.status = "deleted"

    def wait_ready(self, *, timeout: int | None = None) -> None:
        """Wait for this sandbox to reach 'running' status.

        Args:
            timeout: Max wait time in milliseconds. Defaults to 120000.
        """
        timeout_ms = timeout if timeout is not None else WAIT_READY_DEFAULT_TIMEOUT_MS
        start = time.monotonic()

        while True:
            res = self._http.request(
                "GET",
                f"/v1/sandboxes/{self.id}",
            )
            self.status = res["status"]

            if res["status"] == "running":
                return

            if res["status"] in ("failed", "deleted", "stopped"):
                raise RuntimeError(
                    f"Sandbox {self.id} reached terminal state: {res['status']}"
                )

            elapsed_ms = (time.monotonic() - start) * 1000
            if elapsed_ms >= timeout_ms:
                msg = (
                    f"Sandbox {self.id} did not become "
                    f"ready within {timeout_ms}ms"
                )
                raise TimeoutError(
                    message=msg,
                    timeout_ms=timeout_ms,
                )

            time.sleep(WAIT_READY_POLL_INTERVAL_S)

    # -- File operations -------------------------------------------------------

    def upload(self, path: str, content: bytes) -> None:
        """Upload a file to the sandbox."""
        self._http.request_raw(
            "PUT",
            f"/v1/sandboxes/{self.id}/files",
            query={"path": path},
            body=content,
            headers={"Content-Type": "application/octet-stream"},
        )

    def upload_dir(self, path: str, tarball: bytes) -> None:
        """Upload a directory (as tarball) to the sandbox."""
        self._http.request_raw(
            "PUT",
            f"/v1/sandboxes/{self.id}/files",
            query={"path": path, "batch": "true"},
            body=tarball,
            headers={"Content-Type": "application/octet-stream"},
        )

    def download(self, path: str) -> bytes:
        """Download a file from the sandbox."""
        response = self._http.request_raw(
            "GET",
            f"/v1/sandboxes/{self.id}/files",
            query={"path": path},
        )
        return response.content

    def ls(self, path: str) -> list[FileEntry]:
        """List directory contents."""
        res = self._http.request(
            "GET",
            f"/v1/sandboxes/{self.id}/files",
            query={"path": path, "list": "true"},
        )
        return [
            FileEntry(
                name=f["name"],
                path=f["path"],
                type=f["type"],
                size_bytes=f.get("size_bytes"),
            )
            for f in res["files"]
        ]

    def rm(self, path: str) -> None:
        """Delete a file from the sandbox."""
        self._http.request(
            "DELETE",
            f"/v1/sandboxes/{self.id}/files",
            query={"path": path},
        )

    # -- Artifact operations ---------------------------------------------------

    def register_artifacts(self, paths: list[str]) -> RegisterArtifactsResult:
        """Register files as artifacts for collection on stop."""
        res = self._http.request(
            "POST",
            f"/v1/sandboxes/{self.id}/artifacts",
            body={"paths": paths},
        )
        return RegisterArtifactsResult(
            registered=res["registered"], total=res["total"]
        )

    def list_artifacts(self) -> list[Artifact]:
        """List artifacts registered in this sandbox."""
        res = self._http.request(
            "GET",
            f"/v1/sandboxes/{self.id}/artifacts",
        )
        return [
            Artifact(
                id=a["id"],
                name=a["name"],
                mime=a["mime"],
                bytes=a["bytes"],
                sha256=a["sha256"],
                download_url=a["download_url"],
                exec_id=a.get("exec_id"),
                created_at=a["created_at"],
            )
            for a in res["artifacts"]
        ]

    # -- Session management ----------------------------------------------------

    def create_session(
        self,
        *,
        shell: str | None = None,
        env: dict[str, str] | None = None,
    ) -> Session:
        """Create a stateful session in this sandbox."""
        res = self._http.request(
            "POST",
            f"/v1/sandboxes/{self.id}/sessions",
            body={
                "shell": shell,
                "env": env,
            },
        )
        return Session(res["session_id"], self.id, self._http)

    # -- Private execution helpers ---------------------------------------------

    def _exec_blocking(
        self,
        cmd: str | list[str],
        *,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout: int | None = None,
    ) -> ExecResult:
        res = self._http.request(
            "POST",
            f"/v1/sandboxes/{self.id}/exec",
            body={
                "cmd": cmd,
                "cwd": cwd,
                "env": env,
                "timeout_seconds": timeout,
                "wait": True,
            },
        )
        return ExecResult(
            exec_id=res["exec_id"],
            exit_code=res["exit_code"],
            stdout=res["stdout"],
            stderr=res["stderr"],
            duration_ms=res["duration_ms"],
        )

    def _exec_with_callbacks(
        self,
        cmd: str | list[str],
        *,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout: int | None = None,
        on_stdout: Callable[[str], None] | None = None,
        on_stderr: Callable[[str], None] | None = None,
    ) -> ExecResult:
        async_res = self._http.request(
            "POST",
            f"/v1/sandboxes/{self.id}/exec",
            body={
                "cmd": cmd,
                "cwd": cwd,
                "env": env,
                "timeout_seconds": timeout,
                "wait": False,
            },
        )

        response = self._http.request_stream(
            "GET",
            f"/v1/sandboxes/{self.id}/exec/{async_res['exec_id']}/stream",
            headers={"Accept": "text/event-stream"},
        )

        stdout = ""
        stderr = ""
        exit_code = 0
        duration_ms = 0

        for event in parse_sse(response):
            if event["t"] == "stdout":
                stdout += event["data"]
                if on_stdout:
                    on_stdout(event["data"])
            elif event["t"] == "stderr":
                stderr += event["data"]
                if on_stderr:
                    on_stderr(event["data"])
            elif event["t"] == "exit":
                exit_code = event["code"]
                duration_ms = event["duration_ms"]

        return ExecResult(
            exec_id=async_res["exec_id"],
            exit_code=exit_code,
            stdout=stdout,
            stderr=stderr,
            duration_ms=duration_ms,
        )

    def _exec_stream(
        self,
        cmd: str | list[str],
        *,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout: int | None = None,
    ) -> ExecStream:
        async_res = self._http.request(
            "POST",
            f"/v1/sandboxes/{self.id}/exec",
            body={
                "cmd": cmd,
                "cwd": cwd,
                "env": env,
                "timeout_seconds": timeout,
                "wait": False,
            },
        )

        response = self._http.request_stream(
            "GET",
            f"/v1/sandboxes/{self.id}/exec/{async_res['exec_id']}/stream",
            headers={"Accept": "text/event-stream"},
        )

        return ExecStream(async_res["exec_id"], parse_sse(response))
