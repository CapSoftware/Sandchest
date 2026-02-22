"""
Sandchest + CrewAI Integration

Use Sandchest sandboxes as tools for CrewAI agents, giving AI agents
the ability to execute code in isolated Firecracker microVMs.

Install:
    pip install crewai requests
"""

import os
import time

import requests
from crewai import Agent, Crew, Task
from crewai.tools import tool

SANDCHEST_API_URL = os.getenv("SANDCHEST_API_URL", "https://api.sandchest.com")
SANDCHEST_API_KEY = os.getenv("SANDCHEST_API_KEY", "")


class SandchestClient:
    """Minimal Sandchest HTTP client for Python."""

    def __init__(
        self,
        api_key: str = SANDCHEST_API_KEY,
        base_url: str = SANDCHEST_API_URL,
    ):
        self.base_url = base_url.rstrip("/")
        self.headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        self.sandbox_id: str | None = None

    def create_sandbox(
        self,
        image: str = "sandchest://ubuntu-22.04",
        ttl_seconds: int = 600,
    ) -> str:
        resp = requests.post(
            f"{self.base_url}/v1/sandboxes",
            headers=self.headers,
            json={"image": image, "ttlSeconds": ttl_seconds},
        )
        resp.raise_for_status()
        self.sandbox_id = resp.json()["id"]
        self._wait_ready()
        return self.sandbox_id

    def _wait_ready(self) -> None:
        for _ in range(60):
            resp = requests.get(
                f"{self.base_url}/v1/sandboxes/{self.sandbox_id}",
                headers=self.headers,
            )
            resp.raise_for_status()
            if resp.json()["status"] == "running":
                return
            time.sleep(1)
        raise TimeoutError(f"Sandbox {self.sandbox_id} did not become ready")

    def exec(self, command: str, cwd: str | None = None) -> dict:
        body: dict = {"command": command}
        if cwd:
            body["cwd"] = cwd
        resp = requests.post(
            f"{self.base_url}/v1/sandboxes/{self.sandbox_id}/exec",
            headers=self.headers,
            json=body,
        )
        resp.raise_for_status()
        return resp.json()

    def stop(self) -> None:
        if self.sandbox_id:
            requests.post(
                f"{self.base_url}/v1/sandboxes/{self.sandbox_id}/stop",
                headers=self.headers,
            )


_client = SandchestClient()


@tool
def execute_command(command: str) -> str:
    """Execute a shell command in an isolated Linux sandbox powered by
    Firecracker microVMs. Returns stdout on success or stderr on failure."""
    if not _client.sandbox_id:
        _client.create_sandbox()
    result = _client.exec(command)
    if result["exitCode"] != 0:
        return f"Command failed (exit {result['exitCode']}):\n{result['stderr']}"
    return result["stdout"]


@tool
def write_and_run_code(filename: str, code: str, language: str = "python3") -> str:
    """Write code to a file in the sandbox and execute it.
    Supports Python, Node.js, Bash, and other installed runtimes."""
    if not _client.sandbox_id:
        _client.create_sandbox()

    # Write the file
    write_cmd = f"cat > /tmp/{filename} << 'SANDCHEST_EOF'\n{code}\nSANDCHEST_EOF"
    write_result = _client.exec(write_cmd)
    if write_result["exitCode"] != 0:
        return f"Failed to write file: {write_result['stderr']}"

    runners = {
        "python3": "python3",
        "python": "python3",
        "node": "node",
        "bash": "bash",
    }
    runner = runners.get(language, language)

    result = _client.exec(f"{runner} /tmp/{filename}")
    if result["exitCode"] != 0:
        return f"Execution failed (exit {result['exitCode']}):\n{result['stderr']}"
    return result["stdout"]


# ---------------------------------------------------------------------------
# Usage with CrewAI
# ---------------------------------------------------------------------------


def main() -> None:
    try:
        coder = Agent(
            role="Software Engineer",
            goal="Write and execute code to solve problems",
            backstory="Expert programmer with access to a secure Linux sandbox.",
            tools=[execute_command, write_and_run_code],
            verbose=True,
        )

        task = Task(
            description=(
                "Write a Python script that generates the first 20 Fibonacci "
                "numbers and prints them. Save it to a file and run it."
            ),
            expected_output="The first 20 Fibonacci numbers printed to stdout.",
            agent=coder,
        )

        crew = Crew(agents=[coder], tasks=[task], verbose=True)
        result = crew.kickoff()
        print(f"\nResult: {result}")
    finally:
        _client.stop()


if __name__ == "__main__":
    main()
