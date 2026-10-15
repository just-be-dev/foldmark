import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { cp, lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const execFileAsync = promisify(execFile);
const staging = await mkdtemp(join(tmpdir(), "foldmark-consumer-"));
const app = join(staging, "app");
const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

const active = new Set();
let interrupted = false;
const terminate = (child) => {
  if (child.pid) {
    try {
      process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
};
const onSignal = () => {
  interrupted = true;
  for (const child of active) terminate(child);
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
const run = (args, cwd = app, { capture = false, timeout = 180_000 } = {}) =>
  new Promise((resolve, reject) => {
    if (interrupted) return reject(new Error("Consumer smoke interrupted"));
    console.log(`> bun ${args.join(" ")}`);
    const child = spawn("bun", args, {
      cwd,
      env: process.env,
      detached: process.platform !== "win32",
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    active.add(child);
    let output = "";
    let timedOut = false;
    child.stdout?.on("data", (chunk) => {
      output += chunk;
      if (output.length > 2 * 1024 * 1024) terminate(child);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child);
    }, timeout);
    const finish = () => {
      clearTimeout(timer);
      active.delete(child);
    };
    child.once("error", (error) => {
      finish();
      reject(error);
    });
    child.once("close", (code, signal) => {
      finish();
      if (code !== 0) {
        terminate(child);
        reject(
          new Error(`bun ${args.join(" ")} failed (${timedOut ? "timeout" : (signal ?? code)})`),
        );
      } else resolve(output);
    });
  });

try {
  const packed = (
    await run(["pm", "pack", "--ignore-scripts", "--quiet", "--destination", staging], root, {
      capture: true,
    })
  ).trim();
  const tarball = join(staging, basename(packed));
  assert.match(basename(tarball), /^foldmark-.+\.tgz$/, "Expected exactly one package tarball");
  const { stdout: listing } = await execFileAsync("tar", ["-tzf", tarball]);
  const files = new Set(listing.split("\n").map((file) => file.replace(/^package\//, "")));
  for (const [entry, conditions] of Object.entries(rootManifest.exports)) {
    for (const condition of ["import", "types"]) {
      const target = conditions[condition];
      if (target)
        assert.ok(
          files.has(target.replace(/^\.\//, "")),
          `Missing ${condition} target for ${entry}: ${target}. Build the library first.`,
        );
    }
  }
  const fixtures = join(root, "tests/consumer");
  await cp(fixtures, app, { recursive: true });
  for (const entry of await readdir(app)) {
    if (entry.endsWith(".fixture")) {
      await writeFile(join(app, basename(entry, ".fixture")), await readFile(join(app, entry)));
      await rm(join(app, entry));
    }
  }
  const manifestPath = join(app, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.dependencies = {
    ...rootManifest.peerDependencies,
    foldmark: `file:${tarball}`,
  };
  manifest.devDependencies = Object.fromEntries(
    ["@foldkit/vite-plugin", "@playwright/test", "@types/node", "typescript", "vite"].map(
      (name) => {
        const version = rootManifest.devDependencies[name];
        assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/, `${name} must be exactly pinned`);
        return [name, version];
      },
    ),
  );
  for (const [name, version] of Object.entries(rootManifest.peerDependencies))
    assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/, `${name} peer must be exactly pinned`);
  const entrypoints = Object.keys(rootManifest.exports).filter(
    (entry) => !entry.endsWith(".json") && rootManifest.exports[entry].types,
  );
  const exportImports = entrypoints.map((entry, index) => {
    const specifier = entry === "." ? rootManifest.name : rootManifest.name + entry.slice(1);
    return `import * as entry${index} from ${JSON.stringify(specifier)}\nvoid entry${index}`;
  });
  await writeFile(join(app, "exports-smoke.ts"), exportImports.join("\n") + "\n");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  await run(["install", "--ignore-scripts", "--no-save"]);
  const installed = join(app, "node_modules/foldmark");
  assert.equal(
    (await lstat(installed)).isSymbolicLink(),
    false,
    "Must install a tarball, not a link",
  );
  assert.equal(await realpath(installed), join(await realpath(app), "node_modules/foldmark"));
  const installedManifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert.equal(installedManifest.version, rootManifest.version);
  for (const [name, version] of Object.entries(rootManifest.peerDependencies)) {
    const dependency = JSON.parse(
      await readFile(join(app, "node_modules", name, "package.json"), "utf8"),
    );
    assert.equal(dependency.version, version, `Consumer installed the wrong ${name} peer`);
  }
  await run(["run", "typecheck"]);
  await run(["run", "test:ssr"]);
  await run(["run", "build"]);
  await run(["run", "test:browser"]);
  console.log(`Packed consumer smoke passed for ${rootManifest.name}@${rootManifest.version}`);
} finally {
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  for (const child of active) terminate(child);
  if (process.env.FOLDMARK_KEEP_CONSUMER === "1")
    console.log(`Consumer fixture retained at ${staging}`);
  else await rm(staging, { recursive: true, force: true });
}
