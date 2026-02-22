"""Tests for sandchest.errors."""

from sandchest.errors import (
    AuthenticationError,
    ConnectionError,
    NotFoundError,
    RateLimitError,
    SandboxNotRunningError,
    SandchestError,
    TimeoutError,
    ValidationError,
)


class TestSandchestError:
    def test_base_error_fields(self):
        err = SandchestError(
            code="internal_error",
            message="Something broke",
            status=500,
            request_id="req_123",
        )
        assert str(err) == "Something broke"
        assert err.code == "internal_error"
        assert err.status == 500
        assert err.request_id == "req_123"

    def test_is_exception(self):
        err = SandchestError(
            code="internal_error", message="fail", status=500, request_id=""
        )
        assert isinstance(err, Exception)


class TestNotFoundError:
    def test_fields(self):
        err = NotFoundError(message="Not found", request_id="req_1")
        assert err.code == "not_found"
        assert err.status == 404
        assert isinstance(err, SandchestError)


class TestRateLimitError:
    def test_fields(self):
        err = RateLimitError(
            message="Too fast", request_id="req_2", retry_after=5.0
        )
        assert err.code == "rate_limited"
        assert err.status == 429
        assert err.retry_after == 5.0
        assert isinstance(err, SandchestError)


class TestSandboxNotRunningError:
    def test_fields(self):
        err = SandboxNotRunningError(message="Stopped", request_id="req_3")
        assert err.code == "sandbox_not_running"
        assert err.status == 409


class TestValidationError:
    def test_fields(self):
        err = ValidationError(message="Bad input", request_id="req_4")
        assert err.code == "validation_error"
        assert err.status == 400


class TestAuthenticationError:
    def test_fields(self):
        err = AuthenticationError(message="Unauthorized", request_id="req_5")
        assert err.code == "unauthorized"
        assert err.status == 401


class TestTimeoutError:
    def test_fields(self):
        err = TimeoutError(message="Timed out", timeout_ms=30000)
        assert err.code == "timeout"
        assert err.status == 0
        assert err.timeout_ms == 30000
        assert err.request_id == ""


class TestConnectionError:
    def test_fields(self):
        err = ConnectionError(message="Network failed")
        assert err.code == "connection_error"
        assert err.status == 0
        assert err.__cause__ is None

    def test_with_cause(self):
        cause = OSError("Connection refused")
        err = ConnectionError(message="Network failed", cause=cause)
        assert err.__cause__ is cause
