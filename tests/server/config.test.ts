import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { readFeedbackServerConfig } from "../../server/config";

const read = (args: readonly string[], environment: Record<string, unknown> = {}) =>
  readFeedbackServerConfig(args, "/test/workspace").pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(environment)),
  );

const rejection = (args: readonly string[]) =>
  read(args).pipe(
    Effect.exit,
    Effect.map((exit) => (Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "accepted")),
  );

describe("local companion configuration", () => {
  it.effect("stable local-first defaults and explicit flags override environment values", () =>
    Effect.gen(function* () {
      const defaults = yield* read([]);
      expect(defaults.host).toBe("127.0.0.1");
      expect(defaults.port).toBe(5177);
      expect(defaults.projectId).toMatch(/^[a-f0-9]{24}$/);
      expect(defaults.projectId).toBe((yield* read([])).projectId);
      expect(defaults.allowedOrigins).toEqual(["http://localhost:5173"]);
      const explicit = yield* read(
        [
          "--mcp",
          "--project",
          "chosen-app",
          "--port",
          "5199",
          "--origin",
          "http://localhost:5180",
          "--origin",
          "http://127.0.0.1:5180",
        ],
        {
          FOLDMARK_PROJECT: "environment-app",
          FOLDMARK_PORT: "5188",
          FOLDMARK_ORIGINS: "http://localhost:1234",
        },
      );
      expect(explicit).toMatchObject({
        projectId: "chosen-app",
        port: 5199,
        mcp: true,
        allowedOrigins: ["http://localhost:5180", "http://127.0.0.1:5180"],
      });
    }),
  );
  it.effect("rejects non-loopback binds and ambiguous or invalid flags", () =>
    Effect.gen(function* () {
      expect(yield* rejection(["--host", "0.0.0.0"])).toContain("loopback");
      expect(yield* rejection(["--project", "../../escape"])).not.toBe("accepted");
      expect(yield* rejection(["--port", "5177", "--port", "5178"])).toContain("more than once");
      expect(yield* rejection(["--port", "0"])).toContain("65535");
      expect(yield* rejection(["--unknown"])).toContain("Unknown");
    }),
  );
});
