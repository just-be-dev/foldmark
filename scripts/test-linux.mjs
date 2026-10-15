import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const version = manifest.devDependencies["@playwright/test"];
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Pin @playwright/test exactly first");
const image = `mcr.microsoft.com/playwright:v${version}-noble`;
const bun = (await readFile(join(root, "mise.toml"), "utf8")).match(/^bun = "([^"]+)"$/m)?.[1];
if (!bun) throw new Error("Pin bun in mise.toml first");
const snapshots = join(root, "tests/browser/workflow.spec.ts-snapshots");
const evidence = join(root, "test-results/linux");
await mkdir(snapshots, { recursive: true });
await mkdir(evidence, { recursive: true });
const name = `foldmark-tests-${randomUUID()}`;
// Linux baselines match the x86_64 Ubuntu CI runner, even on an ARM development Mac.
const platform = process.env.FOLDMARK_LINUX_PLATFORM ?? "linux/amd64";
const args = process.argv.slice(2);
const setup = [
  "set -euo pipefail",
  "cd /source",
  "tar --exclude=./node_modules --exclude=./.git --exclude=./dist --exclude=./demo-dist --exclude=./test-results --exclude=./playwright-report --exclude=./tests/browser/workflow.spec.ts-snapshots -cf - . | tar -xf - -C /workspace",
  "cd /workspace",
  `npm install --global --no-audit --no-fund bun@${bun} >/dev/null`,
  "bun install --frozen-lockfile",
  'exec bunx playwright test "$@"',
].join("\n");
let child;
const onSignal = () => child?.kill("SIGKILL");
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

try {
  console.log(`Running ${image} (${platform}); source checkout is read-only`);
  await new Promise((resolve, reject) => {
    child = spawn(
      "docker",
      [
        "run",
        "--name",
        name,
        "--rm",
        "--init",
        "--platform",
        platform,
        "--ipc=host",
        "--mount",
        `type=bind,source=${root},target=/source,readonly`,
        "--mount",
        "type=volume,target=/workspace",
        "--mount",
        `type=bind,source=${snapshots},target=/workspace/tests/browser/workflow.spec.ts-snapshots`,
        "--mount",
        `type=bind,source=${evidence},target=/workspace/test-results`,
        "--workdir",
        "/workspace",
        "--env",
        "CI=true",
        image,
        "/bin/bash",
        "-c",
        setup,
        "foldmark-linux-tests",
        ...args,
      ],
      { stdio: "inherit" },
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 12 * 60_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(
          new Error(`Linux browser checks failed (${timedOut ? "timeout" : (signal ?? code)})`),
        );
    });
  });
} finally {
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  // Also clean up when the Docker client was killed before --rm could run.
  spawnSync("docker", ["rm", "--force", "--volumes", name], {
    stdio: "ignore",
    timeout: 10_000,
  });
}
