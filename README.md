# Foldmark

Visual feedback for Foldkit applications and coding agents. Select a rendered element, explain what should change, and export a report that connects the UI to source code.

Foldmark is an independent implementation inspired by the interaction concepts in [Agentation](https://github.com/benjitaylor/agentation). No Agentation implementation, assets, or branding are included. It is built with [Foldkit](https://foldkit.dev/) and Effect, without React.

## Run the playground

Development uses [mise](https://mise.jdx.dev) and Bun. `mise install` pins Bun and Node and installs the locked dependencies.

```sh
mise trust && mise install
mise run dev
```

Open the URL Vite prints. The Fieldwork workspace is a real Foldkit app: tasks and navigation work when Inspect is off. Turn on Inspect in the floating toolbar, click an element, and save a note. Open Export to copy Markdown or download JSON.

## Package integration

This package is local and has not been published to npm. Build and install its tarball in your app:

```sh
mise run build
bun pm pack
# In the consuming app:
bun add -D /absolute/path/to/foldmark/foldmark-0.1.0.tgz
```

The published entry points and the `foldmark-server` CLI run on Node.js 22.19+.

The tested peer versions are `foldkit@0.165.0`, `effect@4.0.0`, and `@effect/platform-browser@4.0.0`. Foldkit currently pins those exact Effect peer versions, so this project follows them.

Mount once from your browser entry, after the document body exists:

```ts
if (import.meta.env.DEV) {
  const { mountFoldmark } = await import("foldmark");
  const feedback = mountFoldmark();
  import.meta.hot?.dispose(() => feedback.dispose());
}
```

The widget uses `Runtime.makeElement`, `Runtime.embed`, Schema-validated ports, a pure update function, and named Commands. Its UI renders in a Shadow DOM root. The host retains ownership of its model, document metadata, and routing. `dispose()` removes the widget, listeners, route watcher, and animation pause state. Server-side imports are safe; mounting without a document is a no-op.

### Add Foldkit context

DOM selectors work without instrumentation. For precise source hints, annotate an element in your view:

```ts
import { annotate } from "foldmark";

h.button(
  [
    h.Class("primary"),
    ...annotate(h, {
      source: "src/checkout/view.ts:42",
      modelPath: "checkout.address",
      message: "ClickedSubmitOrder",
    }),
    h.OnClick(Message.ClickedSubmitOrder()),
  ],
  ["Place order"],
);
```

Hints are inherited from the nearest ancestor carrying each attribute. A `context(element)` callback can supply hints for applications with existing instrumentation. None of these mechanisms snapshots your Model.

For automatic development-time source locations, opt in to the Vite plugin for application files:

```ts
import { defineConfig } from "vite";
import { foldmarkSourceHints } from "foldmark/vite";

export default defineConfig({
  plugins: [foldmarkSourceHints({ include: "src" })],
  optimizeDeps: { include: ["effect"] },
});
```

With the pinned Foldkit Vite plugin, include the `effect` barrel in dependency optimization even when your code uses `effect/*` imports. This keeps Foldkit and Foldmark on one optimized Schema instance; otherwise development port validation can fail. The demo and packaged-consumer checks cover this configuration.

The plugin instruments supported Foldkit HTML-builder calls and leaves production builds alone. Existing explicit hints take precedence. For generated locations from other instrumentation, `foldmark/source-map` provides `createSourceResolver` with a host-supplied, allowlisted map loader. It never fetches maps by default. See [source mapping](docs/source-mapping.md) for supported syntax and resolver lifecycle.

```ts
const feedback = mountFoldmark({
  enabled: true,
  storageKey: "my-app:foldmark:v1",
  // storage: false, // memory only; defaults to localStorage
  context: (element) => ({ source: element.getAttribute("data-source") ?? "" }),
  onChange: (annotations) => console.log(`${annotations.length} annotations`),
});

feedback.getAnnotations(); // across every captured page in this session
feedback.dispose();
```

`onChange` runs after successful persistence (or immediately in memory-only mode). Use it for a host-owned integration. Saving a note does not transmit it.

## Send feedback to an agent

Run a local companion for one project. Pair only the exact origin Vite prints:

```sh
mise run feedback -- --project my-app --origin http://localhost:5173
# Add --mcp when the agent host starts this process as an MCP stdio server.
```

The companion prints its loopback endpoint and the path to a private pairing-token file, never the token itself. Configure the widget explicitly from local development settings; do not commit the token, include it in URLs, or put it in production bundles:

```ts
mountFoldmark({
  feedback: {
    endpoint: "http://127.0.0.1:5177",
    projectId: "my-app",
    token: localPairingToken,
  },
});
```

Use **Send to agent** to submit feedback. The server persists requests, exposes their status, and grants an exclusive renewable lease before an agent acts. Completion and failure remain visible; a missed notification does not discard work. The browser client is also available separately from `foldmark/transport`.

The MCP server provides list/get/claim/complete tools and subscribable feedback resources. A resource-change notification is not an instruction to start a model turn: each MCP host controls that behavior. The optional [Pi integration](docs/pi-integration.md) adds an explicitly enabled watcher that starts turns only when the session is idle. Loading the extension alone does not enable it.

See [server setup and security](docs/feedback-server.md), [Pi setup](docs/pi-integration.md), and [testing and CI](docs/testing.md). The local companion is not a hosted multi-user service. Foldkit's own DevTools/MCP remains the tool for inspecting and time-traveling the host application's runtime Model; Foldmark does not capture it.

## What ships in 0.1

- Hover highlighting and unique, root-aware CSS selectors verified against the DOM.
- Element notes with edit, resolve/reopen, delete, and bounded undo/redo.
- Multi-element and rectangular area selection.
- Same-origin iframe and open shadow-root inspection, with explicit target paths.
- Selected text context and explicit Foldkit Model path/Message hints.
- Opt-in Vite source instrumentation and host-controlled source-map resolution.
- Captured bounds/styles plus live pins that follow layout and nested scrolling.
- Explicit screenshot attachments with privacy masks, image limits, and quota fallback.
- Schema-validated local persistence and system/light/dark appearance settings.
- Markdown and JSON export of open notes on the current route.
- Authenticated opt-in feedback submission, MCP tools/notifications, and request statuses.
- An optional Pi watcher with session approval and exclusive renewable work leases.
- Pause/resume for discoverable animations, transitions, and media.
- Keyboard shortcuts, focus handling, and a responsive toolbar.

See [widget features](docs/widget-features.md) for controls, screenshot providers, and capture limitations.

Shortcuts: **Alt+Shift+A** toggles Inspect; **Escape** cancels a draft/selection, then exits Inspect; **Cmd/Ctrl+Enter** saves a note. **Cmd/Ctrl+Z** and **Cmd/Ctrl+Shift+Z** undo/redo Foldmark changes when inspecting or focused in the widget (text editors retain their native undo). Ordinary host click handlers are intercepted while selecting. Pre-existing host capture listeners may run before Foldmark's listener.

## Data and boundaries

Notes remain in your browser under `foldmark:v1` unless you copy, download, explicitly send them, or wire a host-owned `onChange`. Reports contain page origin/path/hash, selectors, text excerpts, styles, source hints, notes, capture timestamps, and any explicitly attached screenshots. Query strings and form values are excluded from captured text. Credentials are never part of notes or reports.

Mark sensitive regions with `data-foldmark-private` and excluded regions with `data-foldmark-ignore`. Screenshots mask private/ignored regions, form controls, and embedded documents conservatively. Native screenshots require an explicit action, browser consent, and Chromium's current-tab Region Capture support; other browsers need an explicit host screenshot provider. Providers receive the crop/masks and an abort signal; returned raster images are validated, resized, and masked again. Storage quota fallback preserves notes without screenshot data. Review every report and image before sharing: selectors, page text outside marked regions, and your own notes may still contain sensitive information.

Captured bounds in reports are historical; on-screen element pins re-resolve their targets as layout changes. Area selections remain fixed document coordinates. Detached targets are distinguished rather than silently relocated. Cross-origin iframes and closed shadow roots remain inaccessible under browser security rules. Animation pause covers discoverable Web/CSS animations, transitions, and media, including newly discovered work; it cannot freeze canvas/WebGL rendering or scripts, and it does not override the browser's cross-origin restrictions.

There are no implicit feedback uploads. Pairing the widget does not submit notes; **Send to agent** starts submission and status polling. The optional source-map loader is host-owned and has no default network implementation. The demo loads Google Fonts; the widget itself does not. The companion is loopback-only and project-scoped, with exact browser-origin checks, a private pairing credential, and file-backed requests. It is not a substitute for normal agent permissions or a sandbox: captured feedback remains untrusted input.

## Development

```sh
mise run check          # typecheck, lint, test, format:check
mise run build
mise run build:demo
mise run test:consumer  # after build
mise run test:browser
```

`mise tasks` lists every task. Install browser engines with `mise run test:browser:install` (on Linux, use `bunx playwright install --with-deps chromium firefox webkit`). Browser tests cover real UI workflows and visual baselines across Chromium, Firefox, and WebKit. The consumer smoke test installs the built tarball into an isolated application and checks its declarations, server-safe imports, and browser mount/dispose. See [testing](docs/testing.md) for baseline updates and CI details.

TypeScript 7.0.2 ships its native compiler under the `tsc` command. The `prepare` hook patches it with `@effect/tsgo`; the Effect language service is configured in `tsconfig.json`. `bun.lock` pins the installed toolchain. Oxlint (with the Effect and Foldkit plugins, configured in `oxlint.config.ts`) lints, Oxfmt formats, and Vitest runs unit tests with `@effect/vitest` for Effect-based tests.

## Structure

- `src/model.ts`: schemas, messages, and state.
- `src/update.ts`: state transitions and named Commands.
- `src/capture.ts`: selectors, DOM snapshots, and source metadata.
- `src/index.ts`: public mount API and browser lifecycle adapter.
- `src/view.ts`, `src/styles.ts`: isolated Foldkit toolbar UI.
- `src/report.ts`: pure report generation.
- `src/feedback.ts`, `src/transport.ts`: shared feedback protocol and opt-in browser transport.
- `server/`: private durable queue, authenticated loopback HTTP, and MCP stdio adapter.
- `integrations/pi/`: optional session-approved agent watcher.
- `src/vite.ts`, `src/source-map.ts`: optional development source instrumentation and map resolution.
- `demo/`: interactive Foldkit playground.
- `tests/`: state, transport, server, agent bridge, packaged-consumer, and browser workflows.
- `.github/workflows/`: repeatable release-readiness checks.

MIT licensed. Foldmark is not affiliated with Agentation or Foldkit.
