import { afterEach, beforeEach, describe, expect, test, vi } from "@effect/vitest";
import type { FeedbackClient, FeedbackClientOptions } from "../../src/transport";
import { makeFoldmarkExtension, type FoldmarkPiAPI } from "../../integrations/pi";

const createFeedbackClient = vi.fn<(options: FeedbackClientOptions) => FeedbackClient>();

function harness({ flag = false, hasUI = true, approved = true, cwd = process.cwd() } = {}) {
  const client = {
    submit: vi.fn(),
    list: vi.fn(async () => []),
    get: vi.fn(),
    claim: vi.fn(),
    complete: vi.fn(),
    events: vi.fn(async () => ({ cursor: 0, reset: false, events: [] })),
    dispose: vi.fn(),
    close: vi.fn(),
  } satisfies FeedbackClient;
  createFeedbackClient.mockReturnValue(client);
  const registrations: { event: string; handler: unknown }[] = [];
  const api = {
    on: (event: string, handler: unknown) => {
      registrations.push({ event, handler });
      return () => {};
    },
    registerFlag: vi.fn<FoldmarkPiAPI["registerFlag"]>(),
    getFlag: vi.fn<FoldmarkPiAPI["getFlag"]>(() => flag),
    registerCommand: vi.fn<FoldmarkPiAPI["registerCommand"]>(),
    sendUserMessage: vi.fn<FoldmarkPiAPI["sendUserMessage"]>(),
  } satisfies FoldmarkPiAPI;
  const ctx = {
    cwd,
    hasUI,
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort: vi.fn(),
    ui: {
      confirm: vi.fn(async () => approved),
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
  };
  makeFoldmarkExtension({ createFeedbackClient })(api);
  // Calls cross the same runtime registration seam as Pi; event payloads are checked in
  // the factory against Pi 1.1.0's declarations, while this host supplies only used fields.
  const emit = async (name: string, event: unknown = {}) => {
    for (const registration of registrations.filter((call) => call.event === name)) {
      const handler = registration.handler;
      if (typeof handler !== "function") throw new Error("Invalid event handler registration.");
      await handler(event, ctx);
    }
  };
  const command = async (args: string) => {
    const registration = api.registerCommand.mock.calls.find(([name]) => name === "foldmark");
    const handler: unknown = registration?.[1].handler;
    if (typeof handler !== "function") throw new Error("Foldmark command was not registered.");
    await handler(args, ctx);
  };
  return { api, client, ctx, emit, command };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("FOLDMARK_WORKSPACE", process.cwd());
  vi.stubEnv("FOLDMARK_ENDPOINT", "http://127.0.0.1:5177");
  vi.stubEnv("FOLDMARK_PROJECT_ID", "project");
  vi.stubEnv("FOLDMARK_TOKEN", "test-pairing-token-with-at-least-thirty-two-characters");
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  createFeedbackClient.mockReset();
});

describe("optional Pi extension activation and lifecycle", () => {
  test("loading and starting a default session is dormant", async () => {
    const s = harness();
    expect(createFeedbackClient).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await s.emit("session_start");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(createFeedbackClient).not.toHaveBeenCalled();
    expect(s.api.sendUserMessage).not.toHaveBeenCalled();
    expect(s.api.registerFlag).toHaveBeenCalledWith(
      "foldmark-enable",
      expect.objectContaining({ default: false }),
    );
  });

  test("interactive enable requires confirmation and starts exactly one watcher", async () => {
    const s = harness();
    await s.emit("session_start");
    await s.command("enable");
    expect(s.ctx.ui.confirm).toHaveBeenCalledTimes(1);
    expect(createFeedbackClient).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.client.events).toHaveBeenCalledTimes(1);
    expect(s.client.list).toHaveBeenCalledTimes(1);
    await s.command("enable");
    expect(createFeedbackClient).toHaveBeenCalledTimes(1);
    await s.emit("session_shutdown");
    expect(s.client.dispose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("declining activation starts no network or timers", async () => {
    const s = harness({ approved: false });
    await s.command("enable");
    expect(createFeedbackClient).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("explicit startup flag enables unattended operation without a dialog", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const s = harness({ flag: true, hasUI: false });
    await s.emit("session_start");
    expect(createFeedbackClient).toHaveBeenCalledTimes(1);
    expect(s.ctx.ui.confirm).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.client.list).toHaveBeenCalledTimes(1);
    await s.emit("session_shutdown");
    expect(stderr.mock.calls.flat().join("")).not.toContain(process.env.FOLDMARK_TOKEN);
  });

  test("non-interactive command cannot enable without explicit startup approval", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const s = harness({ hasUI: false });
    await s.command("enable");
    expect(createFeedbackClient).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("workspace mismatch prevents accidental work in another project", async () => {
    const s = harness({ flag: true, cwd: "/different-workspace" });
    await s.emit("session_start");
    expect(createFeedbackClient).not.toHaveBeenCalled();
    expect(s.ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("workspace does not match"),
      "error",
    );
  });

  test("missing credentials fail visibly without leaking configured values", async () => {
    vi.stubEnv("FOLDMARK_TOKEN", "");
    const s = harness({ flag: true });
    await s.emit("session_start");
    expect(createFeedbackClient).not.toHaveBeenCalled();
    expect(s.ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Set FOLDMARK_ENDPOINT"),
      "error",
    );
  });

  test.each([
    "session_before_switch",
    "session_before_fork",
    "session_before_tree",
    "session_shutdown",
  ])("%s closes the watcher and cancels the polling timer", async (event) => {
    const s = harness({ flag: true });
    await s.emit("session_start");
    await vi.advanceTimersByTimeAsync(0);
    await s.emit(event);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.client.dispose).toHaveBeenCalledTimes(1);
    expect(s.client.list).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
