import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, test } from "@effect/vitest";
import { createFeedbackClient } from "../../src/transport";
import { annotation, deferred } from "./fixtures";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function unusedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No ephemeral port");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
async function stop(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}

describe("companion CLI lifecycle", () => {
  test("MCP stdout stays protocol-only, HTTP readiness is usable, and stdin EOF closes the queue", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "foldmark-cli-"));
    cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
    const port = await unusedPort();
    // Run the TypeScript entry directly with Bun; the built CLI is smoke-tested under Node.
    const child = spawn(
      "bun",
      [
        "server/cli.ts",
        "--mcp",
        "--project",
        "cli-app",
        "--port",
        String(port),
        "--data-dir",
        dataDir,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    cleanup.push(() => stop(child));
    const ready = deferred();
    const initialized = deferred<Record<string, unknown>>();
    let stderr = "";
    let stdout = "";
    let lineBuffer = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.includes("Foldmark ready:")) ready.resolve();
    });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      lineBuffer += chunk;
      while (lineBuffer.includes("\n")) {
        const index = lineBuffer.indexOf("\n");
        const line = lineBuffer.slice(0, index);
        lineBuffer = lineBuffer.slice(index + 1);
        try {
          initialized.resolve(JSON.parse(line));
        } catch (error) {
          initialized.reject(error);
        }
      }
    });
    child.once("error", (error) => {
      ready.reject(error);
      initialized.reject(error);
    });
    child.once("exit", (code) => {
      if (code !== 0) ready.reject(new Error("CLI exited before readiness"));
    });
    await ready.promise;
    expect(stderr).toContain(`http://127.0.0.1:${port}`);
    expect(stdout).toBe("");
    const token = (await readFile(join(dataDir, "pairing-token"), "utf8")).trim();
    expect(stderr).not.toContain(token);
    const client = createFeedbackClient({
      endpoint: `http://127.0.0.1:${port}`,
      token,
      projectId: "cli-app",
    });
    const request = await client.submit([annotation], { requestId: "cli-submission" });
    expect(request.status).toBe("pending");
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test-cli", version: "1.0.0" },
        },
      }) + "\n",
    );
    expect(await initialized.promise).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name: "foldmark" } },
    });
    client.dispose();
    const exited = once(child, "exit");
    child.stdin.end();
    const [code] = await exited;
    expect(code).toBe(0);
    await expect(readFile(join(dataDir, "instance.lock"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      stdout
        .split("\n")
        .filter(Boolean)
        .every((line) => JSON.parse(line).jsonrpc === "2.0"),
    ).toBe(true);
  });
});
