/** What SandboxWorkspace asks the microVM to run, against a stubbed sandbox client. */
import { describe, expect, test } from "bun:test";
import { WorkspaceError } from "../src";
import { SandboxWorkspace } from "../src/sandbox";
import { BASE_ENV } from "../src/shared";

type RunCommandParams = { cmd: string; args?: string[]; cwd?: string; env?: Record<string, string>; detached?: boolean };

function stubbed(): { workspace: SandboxWorkspace; commands: RunCommandParams[] } {
  const commands: RunCommandParams[] = [];
  const sandbox = {
    cwd: "/vercel/sandbox",
    runCommand: async (params: RunCommandParams) => {
      commands.push(params);
      return { exitCode: 0, stdout: async () => "", stderr: async () => "" };
    },
    delete: async () => {},
  };
  // The constructor is private: `create()` would boot a real microVM.
  const Ctor = SandboxWorkspace as unknown as new (sandbox: unknown) => SandboxWorkspace;
  return { workspace: new Ctor(sandbox), commands };
}

describe("SandboxWorkspace.installIndexer", () => {
  test("downloads once, however many times it is asked, and never into the checkout", async () => {
    const { workspace, commands } = stubbed();
    const binary = { url: "https://example.com/sandchest-index", sha256: "0".repeat(64) };
    await Promise.all([workspace.installIndexer(binary), workspace.installIndexer(binary)]);
    await workspace.installIndexer(binary);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ cmd: "sh", cwd: "/vercel/sandbox" });
    expect(commands[0]!.args).toContain("/vercel/sandbox/bin/sandchest-index");
    expect(commands[0]!.args!.some((arg) => arg.includes("--retry 6"))).toBe(true);
  });
});

describe("SandboxWorkspace.startDetached", () => {
  test("runs in the checkout with the base environment, like exec", async () => {
    const { workspace, commands } = stubbed();
    await workspace.startDetached(["npm", "run", "start"], { env: { PORT: "3000" } });
    await workspace.exec(["npm", "ci"]);

    const [start, exec] = commands;
    expect(start).toMatchObject({ cmd: "npm", args: ["run", "start"], cwd: workspace.root, detached: true });
    expect(start!.env).toEqual({ ...BASE_ENV, PORT: "3000" });
    expect(start!.cwd).toBe(exec!.cwd!);
  });

  test("still refuses empty commands and a destroyed workspace", async () => {
    const { workspace, commands } = stubbed();
    await expect(workspace.startDetached([])).rejects.toThrow(WorkspaceError);
    await workspace.destroy();
    await expect(workspace.startDetached(["npm", "start"])).rejects.toThrow(/destroyed/);
    expect(commands).toHaveLength(0);
  });
});
