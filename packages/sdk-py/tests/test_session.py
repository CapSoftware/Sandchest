"""Tests for sandchest.session — Session class."""

from unittest.mock import MagicMock

from sandchest.http import HttpClient
from sandchest.session import Session
from sandchest.types import ExecResult


def make_session() -> Session:
    http = MagicMock(spec=HttpClient)
    return Session("sess_1", "sb_test", http)


class TestExec:
    def test_exec_returns_result(self):
        sess = make_session()
        sess._http.request.return_value = {
            "exec_id": "ex_1",
            "exit_code": 0,
            "stdout": "ok\n",
            "stderr": "",
            "duration_ms": 10,
            "status": "done",
            "resource_usage": {},
        }
        result = sess.exec("echo ok")
        assert isinstance(result, ExecResult)
        assert result.stdout == "ok\n"
        assert result.exit_code == 0

    def test_exec_sends_body(self):
        sess = make_session()
        sess._http.request.return_value = {
            "exec_id": "ex_1",
            "exit_code": 0,
            "stdout": "",
            "stderr": "",
            "duration_ms": 0,
            "status": "done",
            "resource_usage": {},
        }
        sess.exec("ls", timeout=10)
        call_args = sess._http.request.call_args
        assert call_args.args == (
            "POST",
            "/v1/sandboxes/sb_test/sessions/sess_1/exec",
        )
        body = call_args.kwargs["body"]
        assert body["cmd"] == "ls"
        assert body["timeout_seconds"] == 10
        assert body["wait"] is True

    def test_exec_without_timeout(self):
        sess = make_session()
        sess._http.request.return_value = {
            "exec_id": "ex_1",
            "exit_code": 0,
            "stdout": "",
            "stderr": "",
            "duration_ms": 0,
            "status": "done",
            "resource_usage": {},
        }
        sess.exec("pwd")
        body = sess._http.request.call_args.kwargs["body"]
        assert body["timeout_seconds"] is None


class TestDestroy:
    def test_destroy_calls_delete(self):
        sess = make_session()
        sess._http.request.return_value = {"ok": True}
        sess.destroy()
        call_args = sess._http.request.call_args
        assert call_args.args == (
            "DELETE",
            "/v1/sandboxes/sb_test/sessions/sess_1",
        )
