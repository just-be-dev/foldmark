#!/usr/bin/env node
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as Effect from "effect/Effect";
import { feedbackHelp, readFeedbackServerConfig } from "./config";
import { startFeedbackCompanion } from "./index";
import { serveFeedbackStdio } from "./mcp";
import { FeedbackStoreError } from "./store";

export async function main(args = process.argv.slice(2)) {
  if (args.includes("--help") || args.includes("-h")) {
    process.stderr.write(feedbackHelp);
    return;
  }
  const config = await Effect.runPromise(readFeedbackServerConfig(args));
  const companion = await startFeedbackCompanion({
    ...config,
    onError: () => {
      process.stderr.write(
        "Foldmark: a background lease update could not be persisted. Inspect private storage and restart if durability is uncertain.\n",
      );
    },
  });
  const mcp = config.mcp
    ? serveFeedbackStdio(companion.store, {
        onerror: () =>
          process.stderr.write(
            "Foldmark: MCP transport error; persisted feedback remains available.\n",
          ),
      })
    : undefined;
  process.stderr.write(
    `Foldmark ready: ${companion.endpoint}\n` +
      `Project: ${config.projectId}\n` +
      `Allowed browser origins: ${config.allowedOrigins.join(", ") || "(none)"}\n` +
      `Pairing credential file (private): ${join(config.dataDir, "pairing-token")}\n` +
      `${config.mcp ? "MCP stdio enabled; " : ""}Feedback stays local until explicitly submitted.\n`,
  );
  let closing: Promise<void> | undefined;
  const shutdown = () =>
    (closing ??= (async () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      process.stdin.off("end", onEnd);
      process.stdin.off("close", onEnd);
      try {
        await mcp?.close();
      } finally {
        await companion.close();
      }
    })());
  const onSignal = () => {
    void shutdown().catch(() => {
      process.exitCode = 1;
    });
  };
  const onEnd = () => {
    void shutdown().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  if (config.mcp) {
    process.stdin.once("end", onEnd);
    process.stdin.once("close", onEnd);
  }
  return { close: shutdown };
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      error instanceof FeedbackStoreError
        ? `Foldmark: ${error.message}\n`
        : "Foldmark: could not start the feedback companion. Check configuration and private storage permissions.\n",
    );
    process.exitCode = 1;
  });
}
