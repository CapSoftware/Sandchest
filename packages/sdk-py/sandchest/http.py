"""Internal HTTP client with retry, backoff, idempotency, and error parsing."""

from __future__ import annotations

import os
import random
import time
from typing import Any

import httpx

from .errors import (
    AuthenticationError,
    ConnectionError,
    NotFoundError,
    RateLimitError,
    SandboxNotRunningError,
    SandchestError,
    TimeoutError,
    ValidationError,
)

MAX_RATE_LIMIT_WAIT_S = 60.0


def _backoff_delay(attempt: int) -> float:
    """Exponential backoff with jitter."""
    base = min(1.0 * (2**attempt), 30.0)
    jitter = random.random() * base * 0.5  # noqa: S311
    return base + jitter


def _generate_idempotency_key() -> str:
    return os.urandom(16).hex()


class HttpClient:
    """Internal HTTP client for the Sandchest SDK."""

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        timeout: float,
        retries: int,
    ) -> None:
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._retries = retries
        self._client = httpx.Client(
            base_url=self._base_url,
            timeout=httpx.Timeout(timeout),
        )

    def close(self) -> None:
        self._client.close()

    def request(
        self,
        method: str,
        path: str,
        *,
        body: Any | None = None,
        query: dict[str, Any] | None = None,
        timeout: float | None = None,
        idempotency_key: str | None = None,
    ) -> Any:
        """Make a JSON API request with retry logic."""
        is_mutation = method != "GET"
        idem_key = (
            idempotency_key or _generate_idempotency_key()
            if is_mutation
            else None
        )

        headers: dict[str, str] = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        if idem_key:
            headers["Idempotency-Key"] = idem_key

        params = _build_params(query) if query else None
        effective_timeout = timeout if timeout is not None else self._timeout

        last_error: Exception | None = None

        for attempt in range(self._retries + 1):
            if attempt > 0 and last_error is not None:
                if isinstance(last_error, RateLimitError):
                    delay = min(last_error.retry_after, MAX_RATE_LIMIT_WAIT_S)
                else:
                    delay = _backoff_delay(attempt - 1)
                time.sleep(delay)

            try:
                response = self._client.request(
                    method,
                    path,
                    headers=headers,
                    json=body,
                    params=params,
                    timeout=effective_timeout,
                )

                if response.is_success:
                    if response.status_code == 204:
                        return None
                    return response.json()

                error_body = _try_parse_json(response)
                request_id = (
                    (error_body or {}).get("request_id", "")
                    or response.headers.get("x-request-id", "")
                )
                message = (error_body or {}).get(
                    "message", f"HTTP {response.status_code}"
                )

                if response.status_code == 429 and attempt < self._retries:
                    last_error = RateLimitError(
                        message=message,
                        request_id=request_id,
                        retry_after=(error_body or {}).get("retry_after", 1)
                        or 1,
                    )
                    continue

                if (
                    response.status_code >= 500
                    and attempt < self._retries
                ):
                    last_error = SandchestError(
                        code="internal_error",
                        message=message,
                        status=response.status_code,
                        request_id=request_id,
                    )
                    continue

                raise _parse_error_response(
                    response.status_code, message, request_id, error_body
                )

            except SandchestError as exc:
                if isinstance(exc, RateLimitError) and attempt < self._retries:
                    last_error = exc
                    continue
                raise

            except httpx.TimeoutException as exc:
                if attempt < self._retries:
                    last_error = exc
                    continue
                raise TimeoutError(
                    message=f"Request timed out after {effective_timeout}s",
                    timeout_ms=int(effective_timeout * 1000),
                ) from exc

            except (httpx.ConnectError, httpx.NetworkError, OSError) as exc:
                if attempt < self._retries:
                    last_error = exc
                    continue
                raise ConnectionError(
                    message=str(exc) or "Network request failed",
                    cause=exc,
                ) from exc

        # Exhausted retries
        if last_error is not None:
            if isinstance(last_error, SandchestError):
                raise last_error
            raise _wrap_raw_error(last_error, effective_timeout)
        raise ConnectionError(  # pragma: no cover
            message="Request failed after retries"
        )

    def request_raw(
        self,
        method: str,
        path: str,
        *,
        query: dict[str, Any] | None = None,
        body: bytes | str | None = None,
        headers: dict[str, str] | None = None,
        timeout: float | None = None,
    ) -> httpx.Response:
        """Make a raw HTTP request, returning the httpx.Response directly."""
        effective_timeout = timeout if timeout is not None else self._timeout

        merged_headers: dict[str, str] = {
            "Authorization": f"Bearer {self._api_key}",
        }
        if headers:
            merged_headers.update(headers)

        params = _build_params(query) if query else None

        try:
            response = self._client.request(
                method,
                path,
                headers=merged_headers,
                content=body,
                params=params,
                timeout=effective_timeout,
            )

            if not response.is_success:
                error_body = _try_parse_json(response)
                request_id = (
                    (error_body or {}).get("request_id", "")
                    or response.headers.get("x-request-id", "")
                )
                message = (error_body or {}).get(
                    "message", f"HTTP {response.status_code}"
                )
                raise _parse_error_response(
                    response.status_code, message, request_id, error_body
                )

            return response

        except SandchestError:
            raise

        except httpx.TimeoutException as exc:
            raise TimeoutError(
                message=f"Request timed out after {effective_timeout}s",
                timeout_ms=int(effective_timeout * 1000),
            ) from exc

        except (httpx.ConnectError, httpx.NetworkError, OSError) as exc:
            raise ConnectionError(
                message=str(exc) or "Network request failed",
                cause=exc,
            ) from exc

    def request_stream(
        self,
        method: str,
        path: str,
        *,
        query: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        timeout: float | None = None,
    ) -> httpx.Response:
        """Make a streaming HTTP request, returning an httpx.Response with stream."""
        effective_timeout = timeout if timeout is not None else self._timeout

        merged_headers: dict[str, str] = {
            "Authorization": f"Bearer {self._api_key}",
        }
        if headers:
            merged_headers.update(headers)

        params = _build_params(query) if query else None

        try:
            request = self._client.build_request(
                method,
                path,
                headers=merged_headers,
                params=params,
            )
            response = self._client.send(
                request,
                stream=True,
                timeout=effective_timeout,
            )

            if not response.is_success:
                body_text = response.read()
                error_body = _try_parse_json_bytes(body_text)
                request_id = (
                    (error_body or {}).get("request_id", "")
                    or response.headers.get("x-request-id", "")
                )
                message = (error_body or {}).get(
                    "message", f"HTTP {response.status_code}"
                )
                response.close()
                raise _parse_error_response(
                    response.status_code, message, request_id, error_body
                )

            return response

        except SandchestError:
            raise

        except httpx.TimeoutException as exc:
            raise TimeoutError(
                message=f"Request timed out after {effective_timeout}s",
                timeout_ms=int(effective_timeout * 1000),
            ) from exc

        except (httpx.ConnectError, httpx.NetworkError, OSError) as exc:
            raise ConnectionError(
                message=str(exc) or "Network request failed",
                cause=exc,
            ) from exc


def _build_params(
    query: dict[str, Any],
) -> dict[str, str]:
    """Build query params, filtering out None values."""
    return {k: str(v) for k, v in query.items() if v is not None}


def _try_parse_json(response: httpx.Response) -> dict[str, Any] | None:
    try:
        return response.json()
    except Exception:
        return None


def _try_parse_json_bytes(data: bytes) -> dict[str, Any] | None:
    import json

    try:
        return json.loads(data)
    except Exception:
        return None


def _parse_error_response(
    status: int,
    message: str,
    request_id: str,
    error_body: dict[str, Any] | None,
) -> SandchestError:
    if status == 400:
        return ValidationError(message=message, request_id=request_id)
    if status == 401:
        return AuthenticationError(message=message, request_id=request_id)
    if status == 404:
        return NotFoundError(message=message, request_id=request_id)
    if status == 409:
        return SandboxNotRunningError(message=message, request_id=request_id)
    if status == 429:
        return RateLimitError(
            message=message,
            request_id=request_id,
            retry_after=(error_body or {}).get("retry_after", 1) or 1,
        )
    return SandchestError(
        code=(error_body or {}).get("error", "internal_error"),
        message=message,
        status=status,
        request_id=request_id,
    )


def _wrap_raw_error(error: Exception, timeout: float) -> SandchestError:
    if isinstance(error, SandchestError):
        return error
    if isinstance(error, httpx.TimeoutException):
        return TimeoutError(
            message=f"Request timed out after {timeout}s",
            timeout_ms=int(timeout * 1000),
        )
    return ConnectionError(
        message=str(error) or "Network request failed",
        cause=error,
    )
