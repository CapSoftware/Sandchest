"""Tests for sandchest.sandbox — Sandbox resource class."""

from unittest.mock import MagicMock, patch

import pytest

from sandchest.errors import TimeoutError
from sandchest.http import HttpClient
from sandchest.sandbox import Sandbox
from sandchest.stream import ExecStream
from sandchest.types import ExecResult


def make_sandbox(**kwargs) -> Sandbox:
    http = MagicMock(spec=HttpClient)
    defaults = {
        "id": "sb_test",
        "status": "running",
        "replay_url": "https://replay.test.com/sb_test",
        "http": http,
    }
    defaults.update(kwargs)
    return Sandbox(
        defaults["id"], defaults["status"], defaults["replay_url"], defaults["http"]
    )


class TestExecBlocking:
    def test_exec_returns_result(self):
        sb = make_sandbox()
        sb._http.request.return_value = {
            "exec_id": "ex_1",
            "exit_code": 0,
            "stdout": "hello\n",
            "stderr": "",
            "duration_ms": 42,
            "status": "done",
            "resource_usage": {},
        }
        result = sb.exec("echo hello")
        assert isinstance(result, ExecResult)
        assert result.exec_id == "ex_1"
        assert result.exit_code == 0
        assert result.stdout == "hello\n"
        assert result.duration_ms == 42

    def test_exec_sends_options(self):
        sb = make_sandbox()
        sb._http.request.return_value = {
            "exec_id": "ex_1",
            "exit_code": 0,
            "stdout": "",
            "stderr": "",
            "duration_ms": 0,
            "status": "done",
            "resource_usage": {},
        }
        sb.exec("ls -la", cwd="/tmp", env={"X": "1"}, timeout=30)
        body = sb._http.request.call_args.kwargs["body"]
        assert body["cmd"] == "ls -la"
        assert body["cwd"] == "/tmp"
        assert body["env"] == {"X": "1"}
        assert body["timeout_seconds"] == 30
        assert body["wait"] is True

    def test_exec_list_cmd(self):
        sb = make_sandbox()
        sb._http.request.return_value = {
            "exec_id": "ex_1",
            "exit_code": 0,
            "stdout": "",
            "stderr": "",
            "duration_ms": 0,
            "status": "done",
            "resource_usage": {},
        }
        sb.exec(["python", "-c", "print('hi')"])
        body = sb._http.request.call_args.kwargs["body"]
        assert body["cmd"] == ["python", "-c", "print('hi')"]


class TestExecStream:
    def test_exec_stream_returns_exec_stream(self):
        sb = make_sandbox()
        sb._http.request.return_value = {
            "exec_id": "ex_2",
            "status": "running",
        }
        mock_response = MagicMock()
        sb._http.request_stream.return_value = mock_response

        with patch("sandchest.sandbox.parse_sse") as mock_parse:
            mock_parse.return_value = iter([])
            result = sb.exec("echo hi", stream=True)
            assert isinstance(result, ExecStream)
            assert result.exec_id == "ex_2"


class TestExecWithCallbacks:
    def test_callbacks_invoked(self):
        sb = make_sandbox()
        sb._http.request.return_value = {
            "exec_id": "ex_3",
            "status": "running",
        }

        mock_response = MagicMock()
        sb._http.request_stream.return_value = mock_response

        events = [
            {"seq": 0, "t": "stdout", "data": "line1\n"},
            {"seq": 1, "t": "stderr", "data": "warn\n"},
            {
                "seq": 2, "t": "exit", "code": 0,
                "duration_ms": 100, "resource_usage": {},
            },
        ]

        stdout_chunks = []
        stderr_chunks = []

        with patch("sandchest.sandbox.parse_sse") as mock_parse:
            mock_parse.return_value = iter(events)
            result = sb.exec(
                "cmd",
                on_stdout=stdout_chunks.append,
                on_stderr=stderr_chunks.append,
            )

        assert result.stdout == "line1\n"
        assert result.stderr == "warn\n"
        assert result.exit_code == 0
        assert result.duration_ms == 100
        assert stdout_chunks == ["line1\n"]
        assert stderr_chunks == ["warn\n"]


class TestFork:
    def test_fork_returns_sandbox(self):
        sb = make_sandbox()
        sb._http.request.return_value = {
            "sandbox_id": "sb_fork",
            "forked_from": "sb_test",
            "status": "running",
            "replay_url": "https://replay.test.com/sb_fork",
            "created_at": "2024-01-01",
        }
        fork = sb.fork(env={"EXTRA": "val"}, ttl_seconds=300)
        assert isinstance(fork, Sandbox)
        assert fork.id == "sb_fork"
        assert fork.status == "running"

    def test_fork_sends_body(self):
        sb = make_sandbox()
        sb._http.request.return_value = {
            "sandbox_id": "sb_f",
            "forked_from": "sb_test",
            "status": "queued",
            "replay_url": "https://r.test.com/sb_f",
            "created_at": "2024-01-01",
        }
        sb.fork(env={"A": "B"}, ttl_seconds=120)
        body = sb._http.request.call_args.kwargs["body"]
        assert body["env"] == {"A": "B"}
        assert body["ttl_seconds"] == 120


class TestForks:
    def test_returns_fork_tree(self):
        sb = make_sandbox()
        sb._http.request.return_value = {
            "root": "sb_test",
            "tree": [
                {
                    "sandbox_id": "sb_test",
                    "status": "running",
                    "forked_from": None,
                    "forked_at": None,
                    "children": ["sb_child"],
                },
                {
                    "sandbox_id": "sb_child",
                    "status": "running",
                    "forked_from": "sb_test",
                    "forked_at": "2024-01-01",
                    "children": [],
                },
            ],
        }
        tree = sb.forks()
        assert tree.root == "sb_test"
        assert len(tree.tree) == 2
        assert tree.tree[0].children == ["sb_child"]
        assert tree.tree[1].forked_from == "sb_test"


class TestStop:
    def test_stop_updates_status(self):
        sb = make_sandbox()
        sb._http.request.return_value = {
            "sandbox_id": "sb_test",
            "status": "stopping",
        }
        sb.stop()
        assert sb.status == "stopping"


class TestDestroy:
    def test_destroy_sets_deleted(self):
        sb = make_sandbox()
        sb._http.request.return_value = {
            "sandbox_id": "sb_test",
            "status": "deleted",
        }
        sb.destroy()
        assert sb.status == "deleted"


class TestWaitReady:
    def test_wait_ready_returns_on_running(self):
        sb = make_sandbox(status="queued")
        sb._http.request.return_value = {
            "sandbox_id": "sb_test",
            "status": "running",
            "image": "ubuntu",
            "profile": "small",
            "env": {},
            "forked_from": None,
            "fork_count": 0,
            "created_at": "2024-01-01",
            "started_at": "2024-01-01",
            "ended_at": None,
            "failure_reason": None,
            "replay_url": "https://r.test.com/sb_test",
            "replay_public": False,
        }
        sb.wait_ready()
        assert sb.status == "running"

    def test_wait_ready_raises_on_terminal(self):
        sb = make_sandbox(status="queued")
        sb._http.request.return_value = {
            "sandbox_id": "sb_test",
            "status": "failed",
            "image": "ubuntu",
            "profile": "small",
            "env": {},
            "forked_from": None,
            "fork_count": 0,
            "created_at": "2024-01-01",
            "started_at": None,
            "ended_at": "2024-01-01",
            "failure_reason": "provision_failed",
            "replay_url": "https://r.test.com/sb_test",
            "replay_public": False,
        }
        with pytest.raises(RuntimeError, match="terminal state"):
            sb.wait_ready()

    def test_wait_ready_timeout(self):
        sb = make_sandbox(status="queued")
        sb._http.request.return_value = {
            "sandbox_id": "sb_test",
            "status": "queued",
            "image": "ubuntu",
            "profile": "small",
            "env": {},
            "forked_from": None,
            "fork_count": 0,
            "created_at": "2024-01-01",
            "started_at": None,
            "ended_at": None,
            "failure_reason": None,
            "replay_url": "https://r.test.com/sb_test",
            "replay_public": False,
        }
        with (
            patch("sandchest.sandbox.time.sleep"),
            patch("sandchest.sandbox.time.monotonic") as mock_time,
        ):
            # First call returns 0, subsequent calls return past timeout
            mock_time.side_effect = [0.0, 0.0, 200.0]
            with pytest.raises(TimeoutError):
                    sb.wait_ready(timeout=1000)


class TestContextManager:
    def test_stops_running_sandbox(self):
        sb = make_sandbox()
        sb._http.request.return_value = {
            "sandbox_id": "sb_test",
            "status": "stopping",
        }
        with sb:
            pass
        sb._http.request.assert_called_once()

    def test_no_stop_if_not_running(self):
        sb = make_sandbox(status="stopped")
        with sb:
            pass
        sb._http.request.assert_not_called()


class TestFileOperations:
    def test_upload(self):
        sb = make_sandbox()
        sb.upload("/tmp/test.txt", b"hello")
        sb._http.request_raw.assert_called_once()
        call_kwargs = sb._http.request_raw.call_args
        assert call_kwargs.args == ("PUT", "/v1/sandboxes/sb_test/files")
        assert call_kwargs.kwargs["body"] == b"hello"
        assert call_kwargs.kwargs["query"]["path"] == "/tmp/test.txt"

    def test_upload_dir(self):
        sb = make_sandbox()
        sb.upload_dir("/tmp/dir", b"tarball-data")
        call_kwargs = sb._http.request_raw.call_args
        assert call_kwargs.kwargs["query"]["batch"] == "true"

    def test_download(self):
        sb = make_sandbox()
        mock_response = MagicMock()
        mock_response.content = b"file-content"
        sb._http.request_raw.return_value = mock_response
        data = sb.download("/tmp/test.txt")
        assert data == b"file-content"

    def test_ls(self):
        sb = make_sandbox()
        sb._http.request.return_value = {
            "files": [
                {
                    "name": "test.py",
                    "path": "/home/test.py",
                    "type": "file",
                    "size_bytes": 100,
                },
                {
                    "name": "src",
                    "path": "/home/src",
                    "type": "directory",
                    "size_bytes": None,
                },
            ],
            "next_cursor": None,
        }
        entries = sb.ls("/home")
        assert len(entries) == 2
        assert entries[0].name == "test.py"
        assert entries[0].type == "file"
        assert entries[1].type == "directory"

    def test_rm(self):
        sb = make_sandbox()
        sb._http.request.return_value = {"ok": True}
        sb.rm("/tmp/test.txt")
        sb._http.request.assert_called_once()


class TestArtifactOperations:
    def test_register_artifacts(self):
        sb = make_sandbox()
        sb._http.request.return_value = {"registered": 2, "total": 5}
        result = sb.register_artifacts(["/out/a.txt", "/out/b.txt"])
        assert result.registered == 2
        assert result.total == 5

    def test_list_artifacts(self):
        sb = make_sandbox()
        sb._http.request.return_value = {
            "artifacts": [
                {
                    "id": "art_1",
                    "name": "output.txt",
                    "mime": "text/plain",
                    "bytes": 42,
                    "sha256": "abc",
                    "download_url": "https://dl.test.com/art_1",
                    "exec_id": "ex_1",
                    "created_at": "2024-01-01",
                }
            ],
            "next_cursor": None,
        }
        artifacts = sb.list_artifacts()
        assert len(artifacts) == 1
        assert artifacts[0].id == "art_1"
        assert artifacts[0].name == "output.txt"


class TestSessionManager:
    def test_create_session(self):
        sb = make_sandbox()
        sb._http.request.return_value = {
            "session_id": "sess_1",
            "status": "running",
        }
        session = sb.create_session(shell="/bin/zsh", env={"TERM": "xterm"})
        assert session.id == "sess_1"
        body = sb._http.request.call_args.kwargs["body"]
        assert body["shell"] == "/bin/zsh"
        assert body["env"] == {"TERM": "xterm"}
