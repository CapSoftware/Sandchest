"""Tests for sandchest.client — Sandchest client class."""

import os
from unittest.mock import patch

import pytest

from sandchest.client import Sandchest
from sandchest.sandbox import Sandbox


class TestClientInit:
    def test_requires_api_key(self):
        with (
            patch.dict(os.environ, {}, clear=True),
            pytest.raises(ValueError, match="API key is required"),
        ):
            Sandchest()

    def test_reads_env_var(self):
        with patch.dict(os.environ, {"SANDCHEST_API_KEY": "sk_env"}):
            client = Sandchest()
            assert client._http._api_key == "sk_env"
            client.close()

    def test_explicit_key_overrides_env(self):
        with patch.dict(os.environ, {"SANDCHEST_API_KEY": "sk_env"}):
            client = Sandchest(api_key="sk_explicit")
            assert client._http._api_key == "sk_explicit"
            client.close()

    def test_context_manager(self):
        with Sandchest(api_key="sk_test") as client:
            assert client._http._api_key == "sk_test"


class TestCreate:
    def test_create_sandbox(self):
        client = Sandchest(api_key="sk_test", base_url="https://api.test.com")
        with patch.object(client._http, "request") as mock_req:
            mock_req.return_value = {
                "sandbox_id": "sb_123",
                "status": "running",
                "replay_url": "https://replay.test.com/sb_123",
                "queue_position": 0,
                "estimated_ready_seconds": 0,
                "created_at": "2024-01-01T00:00:00Z",
            }
            sandbox = client.create(wait_ready=False)
            assert isinstance(sandbox, Sandbox)
            assert sandbox.id == "sb_123"
            assert sandbox.status == "running"
            assert sandbox.replay_url == "https://replay.test.com/sb_123"

    def test_create_sends_options(self):
        client = Sandchest(api_key="sk_test")
        with patch.object(client._http, "request") as mock_req:
            mock_req.return_value = {
                "sandbox_id": "sb_1",
                "status": "running",
                "replay_url": "https://r.test.com/sb_1",
                "queue_position": 0,
                "estimated_ready_seconds": 0,
                "created_at": "2024-01-01",
            }
            client.create(
                image="node:20",
                profile="medium",
                env={"FOO": "bar"},
                ttl_seconds=600,
                queue_timeout_seconds=30,
                wait_ready=False,
            )
            body = mock_req.call_args.kwargs["body"]
            assert body["image"] == "node:20"
            assert body["profile"] == "medium"
            assert body["env"] == {"FOO": "bar"}
            assert body["ttl_seconds"] == 600
            assert body["queue_timeout_seconds"] == 30

    def test_create_polls_by_default(self):
        client = Sandchest(api_key="sk_test")
        with patch.object(client._http, "request") as mock_req:
            mock_req.side_effect = [
                # create response
                {
                    "sandbox_id": "sb_1",
                    "status": "queued",
                    "replay_url": "https://r.test.com/sb_1",
                    "queue_position": 1,
                    "estimated_ready_seconds": 2,
                    "created_at": "2024-01-01",
                },
                # first poll — still queued
                {
                    "sandbox_id": "sb_1",
                    "status": "provisioning",
                    "image": "ubuntu",
                    "profile": "small",
                    "env": {},
                    "forked_from": None,
                    "fork_count": 0,
                    "created_at": "2024-01-01",
                    "started_at": None,
                    "ended_at": None,
                    "failure_reason": None,
                    "replay_url": "https://r.test.com/sb_1",
                    "replay_public": False,
                },
                # second poll — running
                {
                    "sandbox_id": "sb_1",
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
                    "replay_url": "https://r.test.com/sb_1",
                    "replay_public": False,
                },
            ]
            with patch("sandchest.sandbox.time.sleep"):
                sandbox = client.create()
            assert sandbox.status == "running"
            assert mock_req.call_count == 3


class TestGet:
    def test_get_sandbox(self):
        client = Sandchest(api_key="sk_test")
        with patch.object(client._http, "request") as mock_req:
            mock_req.return_value = {
                "sandbox_id": "sb_456",
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
                "replay_url": "https://r.test.com/sb_456",
                "replay_public": False,
            }
            sandbox = client.get("sb_456")
            assert sandbox.id == "sb_456"
            assert sandbox.status == "running"


class TestList:
    def test_list_sandboxes(self):
        client = Sandchest(api_key="sk_test")
        with patch.object(client._http, "request") as mock_req:
            mock_req.return_value = {
                "sandboxes": [
                    {
                        "sandbox_id": "sb_1",
                        "status": "running",
                        "image": "ubuntu",
                        "profile": "small",
                        "forked_from": None,
                        "created_at": "2024-01-01",
                        "replay_url": "https://r.test.com/sb_1",
                    },
                    {
                        "sandbox_id": "sb_2",
                        "status": "stopped",
                        "image": "node:20",
                        "profile": "medium",
                        "forked_from": "sb_1",
                        "created_at": "2024-01-01",
                        "replay_url": "https://r.test.com/sb_2",
                    },
                ],
                "next_cursor": None,
            }
            sandboxes = client.list(status="running")
            assert len(sandboxes) == 2
            assert sandboxes[0].id == "sb_1"
            assert sandboxes[1].id == "sb_2"

    def test_list_sends_query_params(self):
        client = Sandchest(api_key="sk_test")
        with patch.object(client._http, "request") as mock_req:
            mock_req.return_value = {"sandboxes": [], "next_cursor": None}
            client.list(status="running", limit=10, cursor="c_1")
            query = mock_req.call_args.kwargs["query"]
            assert query["status"] == "running"
            assert query["limit"] == 10
            assert query["cursor"] == "c_1"
