"""Type definitions for the Sandchest Python SDK."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, TypedDict

# ---------------------------------------------------------------------------
# Enums / Literal unions
# ---------------------------------------------------------------------------

SandboxStatus = Literal[
    "queued",
    "provisioning",
    "running",
    "stopping",
    "stopped",
    "failed",
    "deleted",
]

ProfileName = Literal["small", "medium", "large"]

# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ExecResult:
    """Result of a blocking exec or stream collect."""

    exec_id: str
    exit_code: int
    stdout: str
    stderr: str
    duration_ms: int


@dataclass(frozen=True)
class ForkTreeNode:
    """A node in the fork tree."""

    sandbox_id: str
    status: SandboxStatus
    forked_from: str | None
    forked_at: str | None
    children: list[str]


@dataclass(frozen=True)
class ForkTree:
    """Fork tree rooted at a sandbox."""

    root: str
    tree: list[ForkTreeNode]


@dataclass(frozen=True)
class FileEntry:
    """Directory listing entry."""

    name: str
    path: str
    type: Literal["file", "directory"]
    size_bytes: int | None


@dataclass(frozen=True)
class Artifact:
    """Artifact resource."""

    id: str
    name: str
    mime: str
    bytes: int
    sha256: str
    download_url: str
    exec_id: str | None
    created_at: str


@dataclass(frozen=True)
class RegisterArtifactsResult:
    """Result of registering artifacts."""

    registered: int
    total: int


# ---------------------------------------------------------------------------
# SSE stream event types
# ---------------------------------------------------------------------------


class ExecStreamStdout(TypedDict):
    seq: int
    t: Literal["stdout"]
    data: str


class ExecStreamStderr(TypedDict):
    seq: int
    t: Literal["stderr"]
    data: str


class ExecStreamExit(TypedDict):
    seq: int
    t: Literal["exit"]
    code: int
    duration_ms: int


ExecStreamEvent = ExecStreamStdout | ExecStreamStderr | ExecStreamExit
