import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "@effect/vitest";
import { createFeedbackStore } from "../../server/store";
import { startFeedbackHttpServer } from "../../server/http";
import type { Annotation } from "../../src/model";
import { createFeedbackClient } from "../../src/transport";
import { FeedbackBridge, type FeedbackImage } from "../../integrations/pi/bridge";

const origin = "http://localhost:5173";
const pairingToken = "pi-integration-test-pairing-token-with-32-characters";
const annotation: Annotation = {
  id: "mark-one",
  note: "Give this button enough contrast.",
  resolved: false,
  createdAt: "2026-10-05T00:00:00.000Z",
  target: {
    selector: "#save",
    tag: "button",
    text: "Save",
    selectedText: "",
    source: "src/view.ts:12",
    modelPath: "editor",
    message: "ClickedSave",
    rect: { x: 10, y: 20, width: 80, height: 40 },
    font: "14px sans-serif",
    color: "gray",
    background: "white",
    page: origin + "/",
    title: "Editor",
    viewport: "1440x900",
  },
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "foldmark-pi-http-"));
  let now = Date.parse("2026-10-05T00:00:00.000Z");
  const store = await createFeedbackStore({ dataDir, projectId: "project", now: () => now });
  const http = await startFeedbackHttpServer({
    store,
    token: pairingToken,
    port: 0,
    allowedOrigins: [origin],
  });
  let idle = true;
  const browser = createFeedbackClient({
    endpoint: http.endpoint,
    token: pairingToken,
    projectId: "project",
    // Exercise the actual browser-Origin validation path as well as the shared public client.
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("Origin", origin);
      return fetch(input, { ...init, headers });
    },
  });
  const agent = createFeedbackClient({
    endpoint: http.endpoint,
    token: pairingToken,
    projectId: "project",
  });
  const host = {
    isIdle: () => idle,
    hasPendingMessages: () => false,
    start: vi.fn<(prompt: string, images: readonly FeedbackImage[]) => void>(() => {}),
    abort: vi.fn(),
    notify: vi.fn(),
  };
  const bridge = new FeedbackBridge(agent, host, {
    projectId: "project",
    owner: "pi-http-test",
    now: () => now,
    nonce: () => "http-test-turn",
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    bridge.dispose();
    browser.dispose();
    await http.close();
    await store.close();
  };
  cleanups.push(async () => {
    await close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const begin = () => {
    const prompt = host.start.mock.calls[0]?.[0];
    if (!prompt) throw new Error("The bridge did not dispatch a feedback prompt.");
    bridge.beforeStart(prompt);
    idle = false;
  };
  return {
    dataDir,
    browser,
    agent,
    store,
    host,
    bridge,
    close,
    begin,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("real browser HTTP → durable queue → Pi turn → browser result", () => {
  test("an explicit submission is claimed, correlated, completed, and survives store restart", async () => {
    const s = await setup();
    const submitted = await s.browser.submit([annotation], { requestId: "from-browser" });
    expect(submitted.status).toBe("pending");
    await s.bridge.tick();
    const claimed = await s.browser.get(submitted.id);
    expect(claimed.status).toBe("claimed");
    expect(claimed.claim?.owner).toBe("pi-http-test");
    expect(claimed).not.toHaveProperty("claimToken");
    s.begin();
    s.bridge.assistantMessage("stop", "Improved contrast and verified the button test.");
    s.bridge.beforeSettle("completed");
    await s.bridge.settled(false);
    const completed = await s.browser.get(submitted.id);
    expect(completed.status).toBe("completed");
    expect(completed.result?.message).toContain("verified the button test");
    expect(completed.claim).toBeNull();
    await s.close();
    const reopened = await createFeedbackStore({ dataDir: s.dataDir, projectId: "project" });
    try {
      expect((await reopened.get(submitted.id)).status).toBe("completed");
      expect((await reopened.events(0)).events.map((event) => event.status)).toEqual([
        "pending",
        "claimed",
        "completed",
      ]);
    } finally {
      await reopened.close();
    }
  });

  test.each(["aborted", "error"] as const)(
    "%s is persisted as failed and visible to the browser",
    async (outcome) => {
      const s = await setup();
      await s.browser.submit([annotation], { requestId: "interrupted" });
      await s.bridge.tick();
      s.begin();
      s.bridge.assistantMessage(outcome, "Partial changes were made.");
      s.bridge.beforeSettle(outcome);
      await s.bridge.settled(outcome === "aborted");
      const failed = await s.browser.get("interrupted");
      expect(failed.status).toBe("failed");
      expect(failed.result?.message).toMatch(/error|interruption/);
      expect((await s.store.get("interrupted")).status).toBe("failed");
    },
  );

  test("renews the real lease while working without creating a second claim owner", async () => {
    const s = await setup();
    await s.browser.submit([annotation], { requestId: "long-run" });
    await s.bridge.tick();
    s.begin();
    const first = await s.browser.get("long-run");
    s.advance(65_000);
    await s.bridge.tick();
    const renewed = await s.browser.get("long-run");
    expect(renewed.claim?.owner).toBe(first.claim?.owner);
    expect(Date.parse(renewed.claim?.expiresAt ?? "")).toBeGreaterThan(
      Date.parse(first.claim?.expiresAt ?? ""),
    );
    s.bridge.assistantMessage("stop", "Completed after renewing the claim.");
    s.bridge.beforeSettle("completed");
    await s.bridge.settled(false);
    expect((await s.browser.get("long-run")).status).toBe("completed");
  });

  test("an expired claim cannot complete a request newly claimed by another agent", async () => {
    const s = await setup();
    await s.browser.submit([annotation], { requestId: "lease-race" });
    await s.bridge.tick();
    s.begin();
    s.advance(121_000);
    const other = await s.browser.claim("lease-race", { owner: "other-agent", leaseMs: 120_000 });
    await s.bridge.tick();
    expect(s.host.abort).toHaveBeenCalledTimes(1);
    s.bridge.assistantMessage("stop", "An old result must not complete the new owner’s claim.");
    s.bridge.beforeSettle("completed");
    await s.bridge.settled(false);
    const current = await s.browser.get("lease-race");
    expect(current.status).toBe("claimed");
    expect(current.claim?.owner).toBe("other-agent");
    await s.browser.complete("lease-race", {
      claimToken: other.claimToken,
      status: "completed",
      message: "Other owner result.",
    });
    expect((await s.browser.get("lease-race")).result?.message).toBe("Other owner result.");
  });

  test("delivers every screenshot and every multi-select group from the real submitted request", async () => {
    const s = await setup();
    const dataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1EAAAAASUVORK5CYII=";
    const marks = Array.from({ length: 5 }, (_, index) => ({
      ...annotation,
      id: `group-${index}`,
      targets: [annotation.target, { ...annotation.target, selector: `#other-${index}` }],
      screenshot: { dataUrl, width: 1, height: 1, capturedAt: annotation.createdAt },
    }));
    await s.browser.submit(marks, { requestId: "with-images" });
    await s.bridge.tick();
    const sent = s.host.start.mock.calls[0];
    expect(sent?.[1]).toHaveLength(5);
    for (let index = 0; index < 5; index++) {
      expect(sent?.[0]).toContain(`#other-${index}`);
      expect(sent?.[1][index]?.annotationId).toBe(`group-${index}`);
    }
    expect(sent?.[0]).not.toContain(dataUrl);
    s.begin();
    s.bridge.assistantMessage("stop", "Reviewed all five image groups and applied the updates.");
    s.bridge.beforeSettle("completed");
    await s.bridge.settled(false);
    expect((await s.browser.get("with-images")).status).toBe("completed");
  });

  test("too many attachments fail visibly rather than silently dropping screenshot groups", async () => {
    const s = await setup();
    const dataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1EAAAAASUVORK5CYII=";
    const marks = Array.from({ length: 21 }, (_, index) => ({
      ...annotation,
      id: `screenshot-${index}`,
      targets: [annotation.target],
      screenshot: { dataUrl, width: 1, height: 1, capturedAt: annotation.createdAt },
    }));
    await s.browser.submit(marks, { requestId: "too-many-images" });
    await s.bridge.tick();
    await s.bridge.tick();
    expect(s.host.start).not.toHaveBeenCalled();
    const failed = await s.browser.get("too-many-images");
    expect(failed.status).toBe("failed");
    expect(failed.result?.message).toContain("at most 20 screenshots");
    expect(failed.result?.message).toContain("no partial agent turn was started");
    expect(failed.annotations).toHaveLength(21);
  });

  test("extension shutdown leaves unfinished work durable, not falsely completed", async () => {
    const s = await setup();
    await s.browser.submit([annotation], { requestId: "shutdown" });
    await s.bridge.tick();
    s.begin();
    s.bridge.dispose();
    expect(s.host.abort).toHaveBeenCalledTimes(1);
    const outstanding = await s.browser.get("shutdown");
    expect(outstanding.status).toBe("claimed");
    expect(outstanding.result).toBeNull();
    s.advance(121_000);
    const recovered = await s.browser.claim("shutdown", {
      owner: "restart-agent",
      leaseMs: 120_000,
    });
    expect(recovered.request.claim?.owner).toBe("restart-agent");
  });
});
