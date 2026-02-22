"""Tests for sandchest.types."""

import pytest

from sandchest.types import (
    Artifact,
    ExecResult,
    FileEntry,
    ForkTree,
    ForkTreeNode,
    RegisterArtifactsResult,
)


class TestExecResult:
    def test_frozen(self):
        r = ExecResult(
            exec_id="ex_1", exit_code=0, stdout="hello", stderr="", duration_ms=42
        )
        assert r.exec_id == "ex_1"
        assert r.exit_code == 0
        assert r.stdout == "hello"
        assert r.stderr == ""
        assert r.duration_ms == 42

    def test_immutable(self):
        r = ExecResult(
            exec_id="ex_1", exit_code=0, stdout="", stderr="", duration_ms=0
        )
        with pytest.raises(AttributeError):
            r.exit_code = 1  # type: ignore[misc]


class TestForkTree:
    def test_tree_structure(self):
        node = ForkTreeNode(
            sandbox_id="sb_1",
            status="running",
            forked_from=None,
            forked_at=None,
            children=["sb_2"],
        )
        tree = ForkTree(root="sb_1", tree=[node])
        assert tree.root == "sb_1"
        assert len(tree.tree) == 1
        assert tree.tree[0].children == ["sb_2"]


class TestFileEntry:
    def test_fields(self):
        f = FileEntry(name="test.py", path="/home/test.py", type="file", size_bytes=42)
        assert f.name == "test.py"
        assert f.type == "file"
        assert f.size_bytes == 42

    def test_directory(self):
        d = FileEntry(name="src", path="/home/src", type="directory", size_bytes=None)
        assert d.type == "directory"
        assert d.size_bytes is None


class TestArtifact:
    def test_fields(self):
        a = Artifact(
            id="art_1",
            name="output.txt",
            mime="text/plain",
            bytes=100,
            sha256="abc123",
            download_url="https://example.com/dl",
            exec_id="ex_1",
            created_at="2024-01-01T00:00:00Z",
        )
        assert a.id == "art_1"
        assert a.exec_id == "ex_1"


class TestRegisterArtifactsResult:
    def test_fields(self):
        r = RegisterArtifactsResult(registered=2, total=5)
        assert r.registered == 2
        assert r.total == 5
