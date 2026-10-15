import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "@effect/vitest";
import {
  createFeedbackClient,
  FeedbackTransportError,
  type FeedbackClient,
} from "../src/transport";
import { createFeedbackStore, type FeedbackStore } from "../server/store";
import { startFeedbackHttpServer, type FeedbackHttpServer } from "../server/http";
import { annotation, deferred, token } from "./server/fixtures";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) await close();
});
const clientOptions = { endpoint: "http://127.0.0.1:5177", token, projectId: "test-project" };
async function companion(): Promise<{
  client: FeedbackClient;
  store: FeedbackStore;
  http: FeedbackHttpServer;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), "foldmark-client-"));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const store = await createFeedbackStore({ dataDir, projectId: "test-project" });
  cleanup.push(() => store.close());
  const http = await startFeedbackHttpServer({ store, token, port: 0 });
  cleanup.push(() => http.close());
  const client = createFeedbackClient({ ...clientOptions, endpoint: http.endpoint });
  cleanup.push(() => client.dispose());
  return { client, store, http };
}

describe("opt-in browser feedback transport", () => {
  test("creating and disposing a paired client performs no network I/O", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createFeedbackClient({ ...clientOptions, fetch: fetcher });
    expect(fetcher).not.toHaveBeenCalled();
    client.dispose();
    await expect(client.list()).rejects.toBeInstanceOf(FeedbackTransportError);
    expect(fetcher).not.toHaveBeenCalled();
  });
  test("explicit submission round-trips through a durable server and reports progress", async () => {
    const { client, store } = await companion();
    const request = await client.submit([annotation], { requestId: "explicit-send" });
    expect(request.status).toBe("pending");
    expect(await client.submit([annotation], { requestId: "explicit-send" })).toEqual(request);
    expect(await client.list()).toHaveLength(1);
    const claim = await client.claim(request.id, { owner: "test-agent" });
    expect((await client.get(request.id)).status).toBe("claimed");
    const completed = await client.complete(request.id, {
      claimToken: claim.claimToken,
      status: "completed",
      message: "Changed and checked.",
    });
    expect(completed.result?.message).toBe("Changed and checked.");
    expect(await client.events(1)).toMatchObject({
      cursor: 3,
      reset: false,
      events: [{ status: "claimed" }, { status: "completed" }],
    });
    expect((await store.get(request.id)).status).toBe("completed");
  });
  test("HTTP claim conflicts preserve the error instance and inspectable status for Pi", async () => {
    const { client } = await companion();
    await client.submit([annotation], { requestId: "claim-conflict" });
    await client.claim("claim-conflict", { owner: "agent-one" });
    const attempt = client.claim("claim-conflict", { owner: "agent-two" });
    await expect(attempt).rejects.toBeInstanceOf(FeedbackTransportError);
    await expect(attempt).rejects.toMatchObject({ status: 409, code: "claimed" });
  });
  test("credentials stay in headers and responses are validated before being exposed", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ requests: [] })));
    const client = createFeedbackClient({ ...clientOptions, fetch: fetcher });
    cleanup.push(() => client.dispose());
    await client.list();
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:5177/v1/projects/test-project/requests",
      expect.objectContaining({
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ requests: ["not a request"] })));
    await expect(client.list()).rejects.toMatchObject({ code: "validation" });
  });
  test("rejects remote endpoints, query credentials, and weak pairing tokens before any fetch", () => {
    for (const endpoint of [
      "not a URL",
      "https://example.com",
      "http://127.0.0.1:5177?token=secret",
      "http://localhost:5177/path",
      "http://user:password@localhost:5177",
      "http://localhost.attacker.test",
    ])
      expect(() => createFeedbackClient({ ...clientOptions, endpoint })).toThrow(
        FeedbackTransportError,
      );
    expect(() => createFeedbackClient({ ...clientOptions, token: "weak" })).toThrow(
      FeedbackTransportError,
    );
  });
  test("disposing aborts owned requests and leaves no future fetch capability", async () => {
    const entered = deferred();
    let signal: AbortSignal | null | undefined;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      signal = init?.signal;
      entered.resolve();
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Cancelled", "AbortError")),
          { once: true },
        );
      });
    });
    const client = createFeedbackClient({ ...clientOptions, fetch: fetcher });
    const pending = client.list();
    const rejection = expect(pending).rejects.toMatchObject({ code: "aborted" });
    await entered.promise;
    client.dispose();
    expect(signal?.aborted).toBe(true);
    await rejection;
    await expect(client.events()).rejects.toMatchObject({ code: "disposed" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
