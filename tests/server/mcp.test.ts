import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/server";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, test, vi } from "@effect/vitest";
import { FeedbackStatus } from "../../src/feedback";
import type { Annotation } from "../../src/model";
import { createFeedbackStore } from "../../server/store";
import { feedbackResourceUris, serveFeedbackStdio } from "../../server/mcp";
import { annotation, deferred, submission } from "./fixtures";

const McpSummary = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  status: FeedbackStatus,
  revision: Schema.Int,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  annotationCount: Schema.Int,
  targetCount: Schema.Int,
  attachmentCount: Schema.Int,
  resourceUri: Schema.String,
});
const McpClaim = Schema.Struct({ request: McpSummary, claimToken: Schema.String });
const McpCatalog = Schema.Struct({ requests: Schema.Array(McpSummary) });
const pixel =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/aY9sAAAAASUVORK5CYII=";
const screenshot = {
  dataUrl: "data:image/png;base64," + pixel,
  width: 1,
  height: 1,
  capturedAt: "2026-10-01T00:00:00.000Z",
};

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.useRealTimers();
});
async function fixture(modern = false) {
  const dataDir = await mkdtemp(join(tmpdir(), "foldmark-mcp-"));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const store = await createFeedbackStore({ dataDir, projectId: "test-project" });
  cleanup.push(() => store.close());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = serveFeedbackStdio(store, { transport: serverTransport });
  cleanup.push(() => server.close());
  const client = new Client(
    { name: "foldmark-test", version: "1.0.0" },
    {
      versionNegotiation: { mode: modern ? { pin: "2026-07-28" } : "legacy" },
    },
  );
  client.setNotificationHandler("notifications/resources/list_changed", () => {});
  cleanup.push(() => client.close());
  await client.connect(clientTransport);
  return { client, store };
}
function textResult(result: CallToolResult) {
  const block = result.content?.[0];
  if (!block || block.type !== "text") throw new Error("Expected MCP text content");
  return JSON.parse(block.text);
}

describe("real MCP tools and resource subscriptions", () => {
  test("legacy clients can list/read/claim/complete without sampling or agent wake-up assumptions", async () => {
    const { client, store } = await fixture();
    await store.submit(submission());
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "foldmark_list_requests",
      "foldmark_get_request",
      "foldmark_claim_request",
      "foldmark_complete_request",
    ]);
    const list = textResult(
      await client.callTool({ name: "foldmark_list_requests", arguments: { status: "pending" } }),
    );
    expect(list.requests).toHaveLength(1);
    const claim = Schema.decodeUnknownSync(McpClaim)(
      textResult(
        await client.callTool({
          name: "foldmark_claim_request",
          arguments: { id: "request-one", owner: "mcp-agent" },
        }),
      ),
    );
    expect(claim.request.status).toBe("claimed");
    const get = textResult(
      await client.callTool({ name: "foldmark_get_request", arguments: { id: "request-one" } }),
    );
    expect(JSON.stringify(get)).not.toContain(claim.claimToken);
    const conflict = await client.callTool({
      name: "foldmark_claim_request",
      arguments: { id: "request-one", owner: "other-agent" },
    });
    expect(conflict.isError).toBe(true);
    expect(textResult(conflict).error).toBe("claimed");
    const complete = Schema.decodeUnknownSync(McpSummary)(
      textResult(
        await client.callTool({
          name: "foldmark_complete_request",
          arguments: {
            id: "request-one",
            claimToken: claim.claimToken,
            status: "completed",
            message: "Build and tests passed.",
          },
        }),
      ),
    );
    expect(complete.status).toBe("completed");
    expect(complete.annotationCount).toBe(1);
    expect((await store.get("request-one")).result?.message).toBe("Build and tests passed.");
    const pending = await client.readResource({
      uri: feedbackResourceUris(store.projectId).pending,
    });
    const content = pending.contents[0];
    if (!content || !("text" in content)) throw new Error("Expected JSON resource");
    expect(JSON.parse(content.text).requests).toEqual([]);
  });
  test("all text surfaces are image-free while get_request preserves groups and sends real image blocks", async () => {
    const { client, store } = await fixture(true);
    const grouped: Annotation = {
      ...annotation,
      id: "grouped-note",
      screenshot,
      targets: [
        annotation.target,
        {
          ...annotation.target,
          selector: "#cancel",
          path: [
            { kind: "shadow", selector: "#checkout" },
            { kind: "frame", selector: "iframe" },
          ],
          framePage: "http://localhost:5173/embedded",
          kind: "area",
        },
      ],
    };
    const second: Annotation = {
      ...annotation,
      id: "second-note",
      note: "Keep both screenshot attachments.",
      screenshot,
    };
    await store.submit({
      version: 1,
      requestId: "images-and-groups",
      annotations: [grouped, second],
    });
    const uri = feedbackResourceUris(store.projectId);
    const listResult = await client.callTool({ name: "foldmark_list_requests", arguments: {} });
    expect(textResult(listResult).requests[0]).toMatchObject({
      id: "images-and-groups",
      annotationCount: 2,
      targetCount: 3,
      attachmentCount: 2,
      resourceUri: uri.request("images-and-groups"),
    });
    expect(textResult(listResult).requests[0].annotations).toBeUndefined();
    const pending = await client.readResource({ uri: uri.pending });
    const detail = await client.readResource({ uri: uri.request("images-and-groups") });
    const detailBlock = detail.contents[0];
    if (!detailBlock || !("text" in detailBlock)) throw new Error("Expected metadata resource");
    const detailMetadata = JSON.parse(detailBlock.text);
    expect(detailMetadata.attachments).toHaveLength(2);
    expect(detailMetadata.getRequest).toEqual({
      name: "foldmark_get_request",
      arguments: { id: "images-and-groups" },
    });
    const claimedResult = await client.callTool({
      name: "foldmark_claim_request",
      arguments: { id: "images-and-groups", owner: "image-agent" },
    });
    const claim = Schema.decodeUnknownSync(McpClaim)(textResult(claimedResult));
    const getResult = await client.callTool({
      name: "foldmark_get_request",
      arguments: { id: "images-and-groups" },
    });
    expect(getResult.isError).not.toBe(true);
    const metadata = textResult(getResult);
    const { screenshot: _screenshot, ...groupMetadata } = grouped;
    expect(metadata.annotations[0]).toMatchObject(groupMetadata);
    expect(metadata.annotations[0].targets).toEqual(grouped.targets);
    expect(metadata.annotations[0].screenshot).toMatchObject({
      width: 1,
      height: 1,
      attachmentIndex: 0,
      contentBlockIndex: 1,
      mimeType: "image/png",
    });
    expect(metadata.annotations[1].note).toBe(second.note);
    expect(getResult.content.filter((block) => block.type === "image")).toEqual([
      { type: "image", mimeType: "image/png", data: pixel },
      { type: "image", mimeType: "image/png", data: pixel },
    ]);
    const completeResult = await client.callTool({
      name: "foldmark_complete_request",
      arguments: {
        id: "images-and-groups",
        claimToken: claim.claimToken,
        status: "completed",
        message: "Verified both requested targets.",
      },
    });
    expect(textResult(completeResult)).toMatchObject({ status: "completed", attachmentCount: 2 });
    const texts = [
      ...listResult.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
      ...getResult.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
      ...pending.contents.flatMap((block) => ("text" in block ? [block.text] : [])),
      ...detail.contents.flatMap((block) => ("text" in block ? [block.text] : [])),
      ...completeResult.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
    ];
    for (const text of [
      ...texts,
      ...claimedResult.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
    ]) {
      expect(text).not.toContain("data:image/");
      expect(text).not.toContain("dataUrl");
      expect(text).not.toContain(pixel);
    }
    for (const text of texts) expect(text).not.toContain(claim.claimToken);
    // MCP presentation does not mutate the versioned HTTP/store representation.
    expect((await store.get("images-and-groups")).annotations).toEqual([grouped, second]);
  });
  test("oversized image count, encoded bytes, and full context fail visibly without partial delivery", async () => {
    const { client, store } = await fixture();
    const requests = [
      {
        id: "too-many-images",
        annotations: Array.from({ length: 21 }, (_, index) => ({
          ...annotation,
          id: `image-${index}`,
          screenshot,
        })),
      },
      {
        id: "too-many-encoded-bytes",
        annotations: Array.from({ length: 12 }, (_, index) => ({
          ...annotation,
          id: `large-image-${index}`,
          screenshot: { ...screenshot, dataUrl: "data:image/png;base64," + "A".repeat(680_000) },
        })),
      },
      {
        id: "too-much-complete-context",
        annotations: Array.from({ length: 13 }, (_, index) => ({
          ...annotation,
          id: `long-note-${index}`,
          note: "x".repeat(4_000),
          screenshot,
        })),
      },
    ];
    for (const request of requests) {
      await store.submit({ version: 1, requestId: request.id, annotations: request.annotations });
      const result = await client.callTool({
        name: "foldmark_get_request",
        arguments: { id: request.id },
      });
      expect(result.isError).toBe(true);
      expect(textResult(result)).toMatchObject({ error: "delivery_limit" });
      expect(textResult(result).message).toContain("Split the notes");
      expect(textResult(result).message).toContain("No partial annotation context or images");
      expect(result.content).toHaveLength(1);
      expect(result.content[0]?.type).toBe("text");
      expect(JSON.stringify(result.content)).not.toContain(pixel);
      expect((await store.get(request.id)).annotations).toHaveLength(request.annotations.length);
      expect((await store.get(request.id)).status).toBe("pending");
    }
  });
  test("catalog pagination explicitly exposes all remaining summaries without annotation payloads", async () => {
    const { client, store } = await fixture();
    for (let index = 0; index < 3; index++) await store.submit(submission(`catalog-${index}`));
    const first = textResult(
      await client.callTool({
        name: "foldmark_list_requests",
        arguments: { status: "pending", limit: 2 },
      }),
    );
    expect(first).toMatchObject({ total: 3, offset: 0, nextOffset: 2 });
    expect(first.requests).toHaveLength(2);
    const second = textResult(
      await client.callTool({
        name: "foldmark_list_requests",
        arguments: { status: "pending", offset: first.nextOffset, limit: 2 },
      }),
    );
    expect(second).toMatchObject({ total: 3, offset: 2, nextOffset: null });
    expect(second.requests).toHaveLength(1);
    expect(new Set([...first.requests, ...second.requests].map((request) => request.id)).size).toBe(
      3,
    );
    expect(JSON.stringify([first, second])).not.toContain(annotation.note);
  });
  test("legacy resource updates are delivered only after explicit subscription and after durable commit", async () => {
    const { client, store } = await fixture();
    const uri = feedbackResourceUris(store.projectId).pending;
    const updates: string[] = [];
    const delivered = deferred();
    client.setNotificationHandler("notifications/resources/updated", (notification) => {
      updates.push(notification.params.uri);
      delivered.resolve();
    });
    await store.submit(submission("before-subscription"));
    await client.listResources(); // A protocol round-trip, not a timing sleep.
    expect(updates).toEqual([]);
    await client.subscribeResource({ uri });
    await store.submit(submission("after-subscription"));
    await delivered.promise;
    expect(updates).toEqual([uri]);
    expect((await store.get("after-subscription")).status).toBe("pending");
    await client.unsubscribeResource({ uri });
    await store.submit(submission("after-unsubscribe"));
    await client.listResources();
    expect(updates).toEqual([uri]);
  });
  test("a generic subscription sees an expired lease become available without another mutation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T00:00:00.000Z"));
    const { client, store } = await fixture(true);
    const uri = feedbackResourceUris(store.projectId).pending;
    await store.submit(submission("lease-notification"));
    await store.claim("lease-notification", { owner: "agent-that-disconnected", leaseMs: 15_000 });
    const available = deferred<string>();
    client.setNotificationHandler("notifications/resources/updated", async () => {
      const resource = await client.readResource({ uri });
      const content = resource.contents[0];
      if (!content || !("text" in content)) throw new Error("Expected JSON resource");
      const pending = Schema.decodeUnknownSync(McpCatalog)(JSON.parse(content.text));
      const expired = pending.requests.find(
        (request) => request.id === "lease-notification" && request.status === "pending",
      );
      if (expired) available.resolve(expired.id);
    });
    const subscription = await client.listen({ resourceSubscriptions: [uri] });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await available.promise).toBe("lease-notification");
    expect((await store.events()).events.at(-1)).toMatchObject({
      cause: "lease_expired",
      status: "pending",
    });
    await subscription.close();
  });
  test("2026-07-28 clients receive actual resources/updated over subscriptions/listen", async () => {
    const { client, store } = await fixture(true);
    const uri = feedbackResourceUris(store.projectId).pending;
    const delivered = deferred<string>();
    client.setNotificationHandler("notifications/resources/updated", (notification) => {
      delivered.resolve(notification.params.uri);
    });
    const subscription = await client.listen({ resourceSubscriptions: [uri] });
    await store.submit(submission("modern-submission"));
    expect(await delivered.promise).toBe(uri);
    const resource = await client.readResource({ uri });
    const content = resource.contents[0];
    if (!content || !("text" in content)) throw new Error("Expected JSON resource");
    expect(JSON.parse(content.text).requests[0].id).toBe("modern-submission");
    await subscription.close();
    expect(await subscription.closed).toBe("local");
  });
});
