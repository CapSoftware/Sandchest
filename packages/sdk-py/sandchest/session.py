"""Session — a stateful shell session inside a sandbox."""

from __future__ import annotations

from typing import TYPE_CHECKING

from .types import ExecResult

if TYPE_CHECKING:
    from .http import HttpClient


class Session:
    """A stateful session inside a sandbox.

    Sessions persist shell state (working directory, env vars) between commands.
    """

    def __init__(self, id: str, sandbox_id: str, http: HttpClient) -> None:
        self.id = id
        self._sandbox_id = sandbox_id
        self._http = http

    def exec(
        self,
        cmd: str,
        *,
        timeout: int | None = None,
    ) -> ExecResult:
        """Execute a command in this session. State persists between calls."""
        res = self._http.request(
            "POST",
            f"/v1/sandboxes/{self._sandbox_id}/sessions/{self.id}/exec",
            body={
                "cmd": cmd,
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

    def destroy(self) -> None:
        """Destroy this session."""
        self._http.request(
            "DELETE",
            f"/v1/sandboxes/{self._sandbox_id}/sessions/{self.id}",
        )
