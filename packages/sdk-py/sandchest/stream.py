"""SSE parsing and ExecStream for streaming exec results."""

from __future__ import annotations

import json
from collections.abc import Generator, Iterator
from typing import TYPE_CHECKING

from .types import ExecResult, ExecStreamEvent

if TYPE_CHECKING:
    import httpx


def parse_sse(response: httpx.Response) -> Generator[ExecStreamEvent, None, None]:
    """Parse SSE events from a streaming httpx Response."""
    buffer = ""
    for chunk in response.iter_text():
        buffer += chunk
        while "\n\n" in buffer:
            part, buffer = buffer.split("\n\n", 1)
            for line in part.split("\n"):
                if line.startswith("data: "):
                    data = line[6:]
                    if data:
                        yield json.loads(data)
    response.close()


class ExecStream:
    """A streaming exec result.

    Iterate over events with ``for event in stream``, or call
    ``stream.collect()`` to wait for the full result.

    Single-use: the underlying stream is consumed on first iteration.
    """

    def __init__(
        self,
        exec_id: str,
        generator: Generator[ExecStreamEvent, None, None],
    ) -> None:
        self.exec_id = exec_id
        self._generator = generator

    def __iter__(self) -> Iterator[ExecStreamEvent]:
        return self._generator  # type: ignore[return-value]

    def collect(self) -> ExecResult:
        """Consume the entire stream and return the aggregated ExecResult."""
        stdout = ""
        stderr = ""
        exit_code = 0
        duration_ms = 0

        for event in self:
            if event["t"] == "stdout":
                stdout += event["data"]
            elif event["t"] == "stderr":
                stderr += event["data"]
            elif event["t"] == "exit":
                exit_code = event["code"]
                duration_ms = event["duration_ms"]

        return ExecResult(
            exec_id=self.exec_id,
            exit_code=exit_code,
            stdout=stdout,
            stderr=stderr,
            duration_ms=duration_ms,
        )
