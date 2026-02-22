"""Tests for sandchest.stream — SSE parsing and ExecStream."""

import json
from unittest.mock import MagicMock

from sandchest.stream import ExecStream, parse_sse
from sandchest.types import ExecResult


def make_sse_response(events: list[dict]) -> MagicMock:
    """Create a mock httpx.Response that yields SSE text chunks."""
    text = ""
    for event in events:
        text += f"data: {json.dumps(event)}\n\n"

    mock = MagicMock()
    mock.iter_text.return_value = [text]
    mock.close = MagicMock()
    return mock


def make_chunked_sse_response(chunks: list[str]) -> MagicMock:
    """Create a mock response that yields text in specific chunks."""
    mock = MagicMock()
    mock.iter_text.return_value = chunks
    mock.close = MagicMock()
    return mock


class TestParseSSE:
    def test_parses_single_event(self):
        response = make_sse_response([{"t": "stdout", "seq": 0, "data": "hello"}])
        events = list(parse_sse(response))
        assert len(events) == 1
        assert events[0]["t"] == "stdout"
        assert events[0]["data"] == "hello"

    def test_parses_multiple_events(self):
        response = make_sse_response(
            [
                {"t": "stdout", "seq": 0, "data": "line1\n"},
                {"t": "stderr", "seq": 1, "data": "warn\n"},
                {
                    "t": "exit", "seq": 2, "code": 0,
                    "duration_ms": 50, "resource_usage": {},
                },
            ]
        )
        events = list(parse_sse(response))
        assert len(events) == 3
        assert events[0]["t"] == "stdout"
        assert events[1]["t"] == "stderr"
        assert events[2]["t"] == "exit"

    def test_handles_chunked_delivery(self):
        # Event split across two chunks
        event = {"t": "stdout", "seq": 0, "data": "hello"}
        full = f"data: {json.dumps(event)}\n\n"
        mid = len(full) // 2
        chunks = [full[:mid], full[mid:]]

        response = make_chunked_sse_response(chunks)
        events = list(parse_sse(response))
        assert len(events) == 1
        assert events[0]["data"] == "hello"

    def test_skips_empty_data(self):
        response = make_chunked_sse_response(["data: \n\n"])
        events = list(parse_sse(response))
        assert len(events) == 0

    def test_ignores_non_data_lines(self):
        text = "event: stdout\ndata: {\"t\":\"stdout\",\"seq\":0,\"data\":\"hi\"}\n\n"
        response = make_chunked_sse_response([text])
        events = list(parse_sse(response))
        assert len(events) == 1
        assert events[0]["data"] == "hi"

    def test_closes_response(self):
        response = make_sse_response(
            [{"t": "exit", "seq": 0, "code": 0, "duration_ms": 0}]
        )
        list(parse_sse(response))
        response.close.assert_called_once()


class TestExecStream:
    def test_iteration(self):
        events = [
            {"t": "stdout", "seq": 0, "data": "out"},
            {"t": "exit", "seq": 1, "code": 0, "duration_ms": 10},
        ]
        stream = ExecStream("ex_1", iter(events))
        collected = list(stream)
        assert len(collected) == 2

    def test_collect(self):
        events = [
            {"t": "stdout", "seq": 0, "data": "hello "},
            {"t": "stdout", "seq": 1, "data": "world"},
            {"t": "stderr", "seq": 2, "data": "warn"},
            {"t": "exit", "seq": 3, "code": 42, "duration_ms": 200},
        ]
        stream = ExecStream("ex_2", iter(events))
        result = stream.collect()
        assert isinstance(result, ExecResult)
        assert result.exec_id == "ex_2"
        assert result.stdout == "hello world"
        assert result.stderr == "warn"
        assert result.exit_code == 42
        assert result.duration_ms == 200

    def test_collect_empty_stream(self):
        stream = ExecStream("ex_3", iter([]))
        result = stream.collect()
        assert result.stdout == ""
        assert result.stderr == ""
        assert result.exit_code == 0
        assert result.duration_ms == 0

    def test_exec_id(self):
        stream = ExecStream("ex_4", iter([]))
        assert stream.exec_id == "ex_4"
