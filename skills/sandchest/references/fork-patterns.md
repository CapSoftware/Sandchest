# Fork Patterns

Forking is the main safety primitive in Sandchest. Use it to save a known-good sandbox state before uncertain work.

## Checkpoint Pattern

Use this after expensive setup:
1. Create a sandbox.
2. Clone or upload code.
3. Install dependencies.
4. Fork the sandbox.
5. Treat that fork source as the clean checkpoint.

If an experiment fails, destroy the experiment fork and fork from the checkpoint again.

## Sequential A/B

Use this when you want to compare approaches without rebuilding setup:
1. Start from a checkpoint.
2. Fork and try approach A.
3. If A fails, destroy that fork.
4. Fork the checkpoint again and try approach B.

This keeps each experiment isolated.

## Before Destructive Operations

Fork before:
- Bulk rewrites
- `rm -rf`
- Dependency upgrades
- Large search-and-replace operations
- Applying third-party patches
- Running migrations or teardown scripts

Forking is faster and safer than trying to manually undo filesystem changes.

## Directory Transfer Workflows

`sandbox_upload_dir` and `uploadDir()` are not transactional. If extraction fails partway through, partially written files can remain.

Preferred pattern:
1. Fork before bulk upload or replacement.
2. Run the file operation in the fork.
3. If extraction or replacement fails, destroy the fork and retry from the checkpoint.

## When To Keep A Fork

Keep a fork when:
- It contains the successful result of an experiment.
- You want a replay URL for the successful run.
- You still need files from that branch.

Destroy a fork when:
- The experiment failed.
- The branch is no longer useful.
- You want to avoid confusing later work with stale state.

## Mental Model

- Original sandbox: prepared base environment
- Checkpoint sandbox: safe restore point
- Experiment fork: disposable branch

Forking is branching, not parallelism. Work through one branch at a time inside a single agent turn.
