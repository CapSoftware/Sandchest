import { spawn, type ChildProcess } from "node:child_process";

/** A running indexer daemon: where to reach it and how to authenticate. */
export interface IndexerHandle {
  /** Base URL, e.g. `http://127.0.0.1:52341` or `https://….vercel.run`. */
  url: string;
  token: string;
}

/** Port the indexer listens on inside a sandbox. */
export const INDEXER_PORT = 4100;

/**
 * Starts `sandchest-index serve` on a local checkout, on a random loopback
 * port with a random token. The daemon exits when this process does.
 */
export async function spawnIndexer(
  binary: string,
  root: string,
  options: { startTimeoutMs?: number } = {},
): Promise<IndexerHandle & { child: ChildProcess; close(): Promise<void> }> {
  const token = crypto.randomUUID();
  const child = spawn(binary, ["serve", root, "--host", "127.0.0.1", "--port", "0", "--exit-on-stdin-close"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "", SANDCHEST_INDEX_TOKEN: token },
  });

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4_000);
  });

  const port = await new Promise<number>((resolvePort, reject) => {
    let buffer = "";
    const settle = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const fail = (error: Error) => {
      settle();
      child.kill("SIGKILL");
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      try {
        const { port } = JSON.parse(line) as { port: number };
        settle();
        resolvePort(port);
      } catch {
        fail(new Error(`Unexpected indexer output: ${line.slice(0, 200)}`));
      }
    };
    const onError = (error: Error) => fail(new Error(`Could not start indexer: ${error.message}`));
    const onExit = (code: number | null) => fail(new Error(`Indexer exited with ${code}: ${stderr.trim()}`));
    const timer = setTimeout(() => fail(new Error("Indexer did not start in time")), options.startTimeoutMs ?? 30_000);

    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });

  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((done) => child.once("exit", () => done()));
    child.stdin.end();
    child.kill("SIGTERM");
    await exited;
  };

  return { url: `http://127.0.0.1:${port}`, token, child, close };
}
