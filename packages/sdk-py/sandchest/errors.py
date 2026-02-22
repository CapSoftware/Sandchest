"""Typed error hierarchy for the Sandchest Python SDK."""

from __future__ import annotations

from typing import Literal

SdkErrorCode = Literal[
    "bad_request",
    "unauthorized",
    "forbidden",
    "not_found",
    "conflict",
    "rate_limited",
    "sandbox_not_running",
    "validation_error",
    "internal_error",
    "service_unavailable",
    "timeout",
    "connection_error",
]


class SandchestError(Exception):
    """Base error for all Sandchest SDK errors."""

    def __init__(
        self,
        *,
        code: SdkErrorCode,
        message: str,
        status: int,
        request_id: str,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.request_id = request_id


class NotFoundError(SandchestError):
    """Resource not found (HTTP 404)."""

    def __init__(self, *, message: str, request_id: str) -> None:
        super().__init__(
            code="not_found", message=message, status=404, request_id=request_id
        )


class RateLimitError(SandchestError):
    """Rate limited (HTTP 429)."""

    def __init__(
        self, *, message: str, request_id: str, retry_after: float
    ) -> None:
        super().__init__(
            code="rate_limited", message=message, status=429, request_id=request_id
        )
        self.retry_after = retry_after


class SandboxNotRunningError(SandchestError):
    """Sandbox is not in a valid state for the requested operation (HTTP 409)."""

    def __init__(self, *, message: str, request_id: str) -> None:
        super().__init__(
            code="sandbox_not_running",
            message=message,
            status=409,
            request_id=request_id,
        )


class ValidationError(SandchestError):
    """Validation error — bad request body or parameters (HTTP 400)."""

    def __init__(self, *, message: str, request_id: str) -> None:
        super().__init__(
            code="validation_error",
            message=message,
            status=400,
            request_id=request_id,
        )


class AuthenticationError(SandchestError):
    """Authentication failed — missing or invalid API key (HTTP 401)."""

    def __init__(self, *, message: str, request_id: str) -> None:
        super().__init__(
            code="unauthorized", message=message, status=401, request_id=request_id
        )


class TimeoutError(SandchestError):
    """Request timed out before receiving a response."""

    def __init__(self, *, message: str, timeout_ms: int) -> None:
        super().__init__(
            code="timeout", message=message, status=0, request_id=""
        )
        self.timeout_ms = timeout_ms


class ConnectionError(SandchestError):
    """Network-level failure — could not connect to the server."""

    def __init__(
        self, *, message: str, cause: Exception | None = None
    ) -> None:
        super().__init__(
            code="connection_error", message=message, status=0, request_id=""
        )
        self.__cause__ = cause
