"""Sandchest SDK client — the main entry point."""

from __future__ import annotations

import os

from .http import HttpClient
from .sandbox import Sandbox
from .types import SandboxStatus

DEFAULT_BASE_URL = "https://api.sandchest.com"
DEFAULT_TIMEOUT = 30.0
DEFAULT_RETRIES = 3


class Sandchest:
    """Sandchest SDK client.

    Example::

        client = Sandchest(api_key="sk_...")
        sandbox = client.create()
        result = sandbox.exec("echo hello")
        print(result.stdout)
    """

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        timeout: float | None = None,
        retries: int | None = None,
    ) -> None:
        resolved_key = api_key or os.environ.get("SANDCHEST_API_KEY")
        if not resolved_key:
            raise ValueError(
                "Sandchest API key is required. Pass api_key or set SANDCHEST_API_KEY."
            )

        self._http = HttpClient(
            api_key=resolved_key,
            base_url=base_url or DEFAULT_BASE_URL,
            timeout=timeout or DEFAULT_TIMEOUT,
            retries=retries if retries is not None else DEFAULT_RETRIES,
        )

    def close(self) -> None:
        """Close the underlying HTTP client."""
        self._http.close()

    def __enter__(self) -> Sandchest:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def create(
        self,
        *,
        image: str | None = None,
        profile: str | None = None,
        env: dict[str, str] | None = None,
        ttl_seconds: int | None = None,
        queue_timeout_seconds: int | None = None,
        wait_ready: bool = True,
    ) -> Sandbox:
        """Create a new sandbox. Polls until ready by default.

        Args:
            image: VM image (e.g. 'ubuntu-22.04', 'node:20').
            profile: Resource profile ('small', 'medium', 'large').
            env: Environment variables.
            ttl_seconds: Time-to-live in seconds.
            queue_timeout_seconds: Max time in queue before timeout.
            wait_ready: If True (default), poll until the sandbox is running.

        Returns:
            A Sandbox instance.
        """
        res = self._http.request(
            "POST",
            "/v1/sandboxes",
            body={
                "image": image,
                "profile": profile,
                "env": env,
                "ttl_seconds": ttl_seconds,
                "queue_timeout_seconds": queue_timeout_seconds,
            },
        )

        sandbox = Sandbox(
            res["sandbox_id"], res["status"], res["replay_url"], self._http
        )

        if wait_ready:
            sandbox.wait_ready()

        return sandbox

    def get(self, sandbox_id: str) -> Sandbox:
        """Get an existing sandbox by ID."""
        res = self._http.request(
            "GET",
            f"/v1/sandboxes/{sandbox_id}",
        )
        return Sandbox(
            res["sandbox_id"], res["status"], res["replay_url"], self._http
        )

    def list(
        self,
        *,
        status: SandboxStatus | None = None,
        image: str | None = None,
        forked_from: str | None = None,
        cursor: str | None = None,
        limit: int | None = None,
    ) -> list[Sandbox]:
        """List sandboxes, optionally filtered."""
        res = self._http.request(
            "GET",
            "/v1/sandboxes",
            query={
                "status": status,
                "image": image,
                "forked_from": forked_from,
                "cursor": cursor,
                "limit": limit,
            },
        )
        return [
            Sandbox(s["sandbox_id"], s["status"], s["replay_url"], self._http)
            for s in res["sandboxes"]
        ]
