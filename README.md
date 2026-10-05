# Foldmark

Visual feedback for Foldkit applications and coding agents. Select a rendered element, explain what should change, and export a report that connects the UI to source code.

Foldmark is an independent implementation inspired by the interaction concepts in [Agentation](https://github.com/benjitaylor/agentation). No Agentation implementation, assets, or branding are included. It is built with [Foldkit](https://foldkit.dev/) and Effect, without React.

## Run the playground

Requires Node.js 22.12+.

```sh
npm ci
npm run dev
```

Open the URL Vite prints. The Fieldwork workspace is a real Foldkit app: tasks and navigation work when Inspect is off. Turn on Inspect in the floating toolbar, click an element, and save a note. Open Export to copy Markdown or download JSON.

## Package integration

This package is local and has not been published to npm. Build and install its tarball in your app:

```sh
npm run build
npm pack
# In the consuming app:
npm install -D /absolute/path/to/foldmark/foldmark-0.1.0.tgz
```

The tested peer versions are `foldkit@0.165.0`, `effect@4.0.0`, and `@effect/platform-browser@4.0.0`. Foldkit currently pins those exact Effect peer versions, so this project follows them.

Mount once from your browser entry, after the document body exists:

```ts
if (import.meta.env.DEV) {
  const { mountFoldmark } = await import('foldmark')
  const feedback = mountFoldmark()
  import.meta.hot?.dispose(() => feedback.dispose())
}
```

The widget uses `Runtime.makeElement`, `Runtime.embed`, Schema-validated ports, a pure update function, and named Commands. Its UI renders in a Shadow DOM root. The host retains ownership of its model, document metadata, and routing. `dispose()` removes the widget, listeners, route watcher, and animation pause state. Server-side imports are safe; mounting without a document is a no-op.

### Add Foldkit context

DOM selectors work without instrumentation. For precise source hints, annotate an element in your view:

```ts
import { annotate } from 'foldmark'

h.button(
  [
    h.Class('primary'),
    ...annotate(h, {
      source: 'src/checkout/view.ts:42',
      modelPath: 'checkout.address',
      message: 'ClickedSubmitOrder',
    }),
    h.OnClick(Message.ClickedSubmitOrder()),
  ],
  ['Place order'],
)
```

Hints are inherited from the nearest ancestor carrying each attribute. They are explicit source metadata, not automatic source-map resolution or snapshots of your model. A `context(element)` callback can also supply hints for applications with existing instrumentation.

```ts
const feedback = mountFoldmark({
  enabled: true,
  storageKey: 'my-app:foldmark:v1',
  // storage: false, // memory only; defaults to localStorage
  context: (element) => ({ source: element.getAttribute('data-source') ?? '' }),
  onChange: (annotations) => console.log(`${annotations.length} annotations`),
})

feedback.getAnnotations() // across every captured page in this session
feedback.dispose()
```

`onChange` runs after successful persistence (or immediately in memory-only mode). Use it for a host-owned integration. There is no automatic network transport.

## What ships in 0.1

- Hover highlighting and unique CSS selectors verified against the DOM.
- Element notes with edit, resolve/reopen, and delete.
- Selected text context when selection exists inside the chosen element.
- Explicit Foldkit source, Model path, and Message hints.
- Captured document bounds, viewport, and relevant computed styles.
- Local, Schema-validated persistence, separated by origin/path/hash.
- Markdown and JSON export of open notes on the current route.
- Copy and download, with visible clipboard and storage error states.
- Pause/resume for running Web Animations, CSS animations, and videos.
- Keyboard shortcuts, composer focus handling, and a responsive toolbar.

Shortcuts: **Alt+Shift+A** toggles Inspect; **Escape** cancels a draft, then exits Inspect; **Cmd/Ctrl+Enter** saves a note. Ordinary host click handlers are intercepted while selecting. Pre-existing host capture listeners may run before Foldmark's listener.

## Data and boundaries

Notes remain in your browser under `foldmark:v1` unless you copy, download, or wire `onChange`. Reports contain page origin/path/hash, selectors, text excerpts, style information, explicit source hints, notes, and capture timestamps. Query strings and form values are not collected. Mark sensitive regions with `data-foldmark-private` to exclude their text; mark regions with `data-foldmark-ignore` to exclude them from selection. Review reports before sharing; selectors and user notes can still contain sensitive information. The demo loads Google Fonts; the widget itself has no external font or network requests.

Captured bounds are historical coordinates. Pins follow page scrolling but do not track subsequent layout changes or independently scrolling containers. CSS transitions, canvas animations, new programmatic animations after pausing, and media inside embedded documents are not frozen. Selection currently supports the main document; iframe and shadow-root traversal, area selection, multi-select, screenshots, undo, and theme settings are not implemented.

MCP/server sync is not included in this first release. Copy/download works with any coding agent; a future transport can consume the versioned JSON report or `onChange`. Foldkit's own DevTools/MCP remains the place to inspect and time-travel the host application's runtime state.

## Development

```sh
npm run typecheck
npm test
npm run test:browser
npm run build
npm run build:demo
```

If Chromium is not installed, run `npx playwright install chromium`. Browser tests exercise capture, host-event interception, persistence, editing, resolve/reopen/delete, copy/download, navigation, keyboard handling, privacy, animation pause, disposal, and small-screen layout.

TypeScript 7.0.2 ships its native compiler under the `tsc` command. The `prepare` hook patches it with `@effect/tsgo`; the Effect language service is configured in `tsconfig.json`. `package-lock.json` pins the installed toolchain.

## Structure

- `src/model.ts`: schemas, messages, and state.
- `src/update.ts`: state transitions and named Commands.
- `src/capture.ts`: selectors, DOM snapshots, and source metadata.
- `src/index.ts`: public mount API and browser lifecycle adapter.
- `src/view.ts`, `src/styles.ts`: isolated Foldkit toolbar UI.
- `src/report.ts`: pure report generation.
- `demo/`: interactive Foldkit playground.
- `tests/`: state/report tests and real Chromium workflows.

MIT licensed. Foldmark is not affiliated with Agentation or Foldkit.
