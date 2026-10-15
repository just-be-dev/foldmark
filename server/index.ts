import { startFeedbackHttpServer, type FeedbackHttpOptions } from "./http";
import { createFeedbackStore, loadPairingToken } from "./store";

export { startFeedbackHttpServer } from "./http";
export type { FeedbackHttpOptions, FeedbackHttpServer } from "./http";
export { createFeedbackStore, loadPairingToken, FeedbackStoreError } from "./store";
export type { FeedbackStore, FeedbackStoreOptions } from "./store";
export { createFeedbackMcpServer, serveFeedbackStdio, feedbackResourceUris } from "./mcp";
export { readFeedbackServerConfig } from "./config";
export type { FeedbackServerConfig } from "./config";

/** Start the local HTTP companion. MCP can share the returned store, never another writer. */
export async function startFeedbackCompanion(options: {
  dataDir: string;
  projectId: string;
  port?: number;
  host?: FeedbackHttpOptions["host"];
  allowedOrigins?: readonly string[];
  onError?: (error: Error) => void;
}) {
  const store = await createFeedbackStore({
    dataDir: options.dataDir,
    projectId: options.projectId,
    onError: options.onError,
  });
  try {
    const token = await loadPairingToken(options.dataDir);
    const http = await startFeedbackHttpServer({ ...options, store, token });
    let closing: Promise<void> | undefined;
    return {
      endpoint: http.endpoint,
      projectId: options.projectId,
      store,
      close: () =>
        (closing ??= (async () => {
          try {
            await http.close();
          } finally {
            await store.close();
          }
        })()),
    };
  } catch (error) {
    await store.close();
    throw error;
  }
}
