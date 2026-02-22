"""Tests for sandchest.http — HTTP client with retry, backoff, error parsing."""

import json
from unittest.mock import patch

import httpx
import pytest

from sandchest.errors import (
    AuthenticationError,
    NotFoundError,
    RateLimitError,
    SandboxNotRunningError,
    SandchestError,
    TimeoutError,
    ValidationError,
)
from sandchest.http import HttpClient


def make_client(**kwargs) -> HttpClient:
    defaults = {
        "api_key": "sk_test",
        "base_url": "https://api.test.com",
        "timeout": 5.0,
        "retries": 0,
    }
    defaults.update(kwargs)
    return HttpClient(**defaults)


def mock_response(
    status_code: int = 200,
    json_data: dict | None = None,
    headers: dict | None = None,
) -> httpx.Response:
    content = json.dumps(json_data).encode() if json_data else b""
    return httpx.Response(
        status_code=status_code,
        content=content,
        headers=headers or {},
    )


class TestHeaders:
    def test_authorization_header(self):
        client = make_client()
        with patch.object(client._client, "request") as mock_req:
            mock_req.return_value = mock_response(200, {"ok": True})
            client.request("GET", "/test")
            call_kwargs = mock_req.call_args
            assert call_kwargs.kwargs["headers"]["Authorization"] == "Bearer sk_test"

    def test_content_type_json(self):
        client = make_client()
        with patch.object(client._client, "request") as mock_req:
            mock_req.return_value = mock_response(200, {"ok": True})
            client.request("GET", "/test")
            assert (
                mock_req.call_args.kwargs["headers"]["Content-Type"]
                == "application/json"
            )

    def test_idempotency_key_on_mutation(self):
        client = make_client()
        with patch.object(client._client, "request") as mock_req:
            mock_req.return_value = mock_response(200, {"id": "1"})
            client.request("POST", "/test", body={"name": "foo"})
            headers = mock_req.call_args.kwargs["headers"]
            assert "Idempotency-Key" in headers
            assert len(headers["Idempotency-Key"]) == 32  # 16 bytes hex

    def test_no_idempotency_key_on_get(self):
        client = make_client()
        with patch.object(client._client, "request") as mock_req:
            mock_req.return_value = mock_response(200, {"ok": True})
            client.request("GET", "/test")
            headers = mock_req.call_args.kwargs["headers"]
            assert "Idempotency-Key" not in headers

    def test_custom_idempotency_key(self):
        client = make_client()
        with patch.object(client._client, "request") as mock_req:
            mock_req.return_value = mock_response(200, {"id": "1"})
            client.request("POST", "/test", body={}, idempotency_key="my-key")
            headers = mock_req.call_args.kwargs["headers"]
            assert headers["Idempotency-Key"] == "my-key"


class TestJsonParsing:
    def test_returns_json(self):
        client = make_client()
        with patch.object(client._client, "request") as mock_req:
            mock_req.return_value = mock_response(200, {"sandbox_id": "sb_1"})
            result = client.request("GET", "/test")
            assert result == {"sandbox_id": "sb_1"}

    def test_204_returns_none(self):
        client = make_client()
        with patch.object(client._client, "request") as mock_req:
            mock_req.return_value = mock_response(204)
            result = client.request("DELETE", "/test")
            assert result is None


class TestQueryParams:
    def test_filters_none_values(self):
        client = make_client()
        with patch.object(client._client, "request") as mock_req:
            mock_req.return_value = mock_response(200, {"items": []})
            client.request(
                "GET", "/test", query={"status": "running", "cursor": None}
            )
            params = mock_req.call_args.kwargs["params"]
            assert params == {"status": "running"}


class TestErrorParsing:
    def test_400_raises_validation(self):
        client = make_client()
        with patch.object(client._client, "request") as mock_req:
            mock_req.return_value = mock_response(
                400,
                {
                    "error": "validation_error",
                    "message": "Bad field",
                    "request_id": "req_1",
                    "retry_after": None,
                },
            )
            with pytest.raises(ValidationError) as exc:
                client.request("POST", "/test", body={})
            assert exc.value.status == 400
            assert exc.value.request_id == "req_1"

    def test_401_raises_authentication(self):
        client = make_client()
        with patch.object(client._client, "request") as mock_req:
            mock_req.return_value = mock_response(
                401,
                {
                    "error": "unauthorized",
                    "message": "Bad key",
                    "request_id": "req_2",
                    "retry_after": None,
                },
            )
            with pytest.raises(AuthenticationError):
                client.request("GET", "/test")

    def test_404_raises_not_found(self):
        client = make_client()
        with patch.object(client._client, "request") as mock_req:
            mock_req.return_value = mock_response(
                404,
                {
                    "error": "not_found",
                    "message": "Not found",
                    "request_id": "req_3",
                    "retry_after": None,
                },
            )
            with pytest.raises(NotFoundError):
                client.request("GET", "/test")

    def test_409_raises_sandbox_not_running(self):
        client = make_client()
        with patch.object(client._client, "request") as mock_req:
            mock_req.return_value = mock_response(
                409,
                {
                    "error": "sandbox_not_running",
                    "message": "Not running",
                    "request_id": "req_4",
                    "retry_after": None,
                },
            )
            with pytest.raises(SandboxNotRunningError):
                client.request("POST", "/test", body={})

    def test_429_raises_rate_limit(self):
        client = make_client()
        with patch.object(client._client, "request") as mock_req:
            mock_req.return_value = mock_response(
                429,
                {
                    "error": "rate_limited",
                    "message": "Slow down",
                    "request_id": "req_5",
                    "retry_after": 10,
                },
            )
            with pytest.raises(RateLimitError) as exc:
                client.request("GET", "/test")
            assert exc.value.retry_after == 10

    def test_500_raises_generic_error(self):
        client = make_client()
        with patch.object(client._client, "request") as mock_req:
            mock_req.return_value = mock_response(
                500,
                {
                    "error": "internal_error",
                    "message": "Server broke",
                    "request_id": "req_6",
                    "retry_after": None,
                },
            )
            with pytest.raises(SandchestError) as exc:
                client.request("GET", "/test")
            assert exc.value.status == 500


class TestRetries:
    def test_retries_on_429(self):
        client = make_client(retries=2)
        with patch.object(client._client, "request") as mock_req:
            mock_req.side_effect = [
                mock_response(
                    429,
                    {
                        "error": "rate_limited",
                        "message": "Slow down",
                        "request_id": "req_1",
                        "retry_after": 0,
                    },
                ),
                mock_response(200, {"ok": True}),
            ]
            with patch("sandchest.http.time.sleep"):
                result = client.request("GET", "/test")
            assert result == {"ok": True}
            assert mock_req.call_count == 2

    def test_retries_on_500(self):
        client = make_client(retries=1)
        with patch.object(client._client, "request") as mock_req:
            mock_req.side_effect = [
                mock_response(
                    500,
                    {
                        "error": "internal_error",
                        "message": "Oops",
                        "request_id": "req_1",
                        "retry_after": None,
                    },
                ),
                mock_response(200, {"ok": True}),
            ]
            with patch("sandchest.http.time.sleep"):
                result = client.request("GET", "/test")
            assert result == {"ok": True}

    def test_no_retry_on_400(self):
        client = make_client(retries=2)
        with patch.object(client._client, "request") as mock_req:
            mock_req.return_value = mock_response(
                400,
                {
                    "error": "validation_error",
                    "message": "Bad",
                    "request_id": "req_1",
                    "retry_after": None,
                },
            )
            with pytest.raises(ValidationError):
                client.request("POST", "/test", body={})
            assert mock_req.call_count == 1

    def test_retries_on_network_error(self):
        client = make_client(retries=1)
        with patch.object(client._client, "request") as mock_req:
            mock_req.side_effect = [
                httpx.ConnectError("Connection refused"),
                mock_response(200, {"ok": True}),
            ]
            with patch("sandchest.http.time.sleep"):
                result = client.request("GET", "/test")
            assert result == {"ok": True}

    def test_exhausted_retries_raises(self):
        client = make_client(retries=1)
        with patch.object(client._client, "request") as mock_req:
            mock_req.side_effect = [
                mock_response(
                    500,
                    {
                        "error": "internal_error",
                        "message": "Oops",
                        "request_id": "req_1",
                        "retry_after": None,
                    },
                ),
                mock_response(
                    500,
                    {
                        "error": "internal_error",
                        "message": "Oops again",
                        "request_id": "req_2",
                        "retry_after": None,
                    },
                ),
            ]
            with patch("sandchest.http.time.sleep"):
                with pytest.raises(SandchestError) as exc:
                    client.request("GET", "/test")
                assert exc.value.status == 500


class TestTimeout:
    def test_timeout_raises_timeout_error(self):
        client = make_client(timeout=1.0)
        with patch.object(client._client, "request") as mock_req:
            mock_req.side_effect = httpx.ReadTimeout("timed out")
            with pytest.raises(TimeoutError) as exc:
                client.request("GET", "/test")
            assert exc.value.timeout_ms == 1000


class TestRequestRaw:
    def test_returns_response(self):
        client = make_client()
        with patch.object(client._client, "request") as mock_req:
            mock_req.return_value = mock_response(200)
            response = client.request_raw("GET", "/test")
            assert response.status_code == 200

    def test_error_on_failure(self):
        client = make_client()
        with patch.object(client._client, "request") as mock_req:
            mock_req.return_value = mock_response(
                404,
                {
                    "error": "not_found",
                    "message": "Gone",
                    "request_id": "req_1",
                    "retry_after": None,
                },
            )
            with pytest.raises(NotFoundError):
                client.request_raw("GET", "/test")

    def test_auth_header(self):
        client = make_client()
        with patch.object(client._client, "request") as mock_req:
            mock_req.return_value = mock_response(200)
            client.request_raw(
                "PUT",
                "/test",
                body=b"hello",
                headers={"Content-Type": "application/octet-stream"},
            )
            headers = mock_req.call_args.kwargs["headers"]
            assert headers["Authorization"] == "Bearer sk_test"
            assert headers["Content-Type"] == "application/octet-stream"
