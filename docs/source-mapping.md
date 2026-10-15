# Source hints and source maps

Foldmark does not infer a source file from an arbitrary DOM node. There must be a real link between a rendered element and a view call. You can provide that link explicitly with `annotate`, automatically in supported Foldkit views with the development Vite plugin, or with your own generated-location instrumentation.

## Automatic Foldkit view locations

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { foldmarkSourceHints } from "foldmark/vite";

export default defineConfig({
  plugins: [foldmarkSourceHints({ include: ["src/"] })],
});
```

This source-hints plugin is independent of the optional `@foldkit/vite-plugin`. When also using Foldkit's official plugin, use its full `foldkit(...)` configuration and add `optimizeDeps: { include: ['effect'] }` to Vite's configuration. With the pinned toolchain, this keeps Effect's barrel and subpath imports on one optimized module identity and avoids duplicate Schema instances. See the repository's `vite.config.ts` and README for the complete tested setup.

An explicit `include` is required. Strings select a root-relative file or directory prefix; a regular expression, an array of strings/expressions, or an absolute-ID predicate also works. Keep this list limited to the consuming application's view files. `include: 'demo'` is suitable for this repository's playground. `sourceRoot` can override the base used in source labels without changing Vite's root.

The plugin recognizes element calls on variables/parameters annotated with the `HtmlBuilder` type imported from `foldkit/html`, including renamed imports and namespace imports. It also recognizes imported `inertHtml` aliases. For deliberately untyped view helpers, explicitly trust their identifier names:

```ts
foldmarkSourceHints({ include: "src/views", builderNames: ["h", "ui"] });
```

For example, this view:

```ts
import type { HtmlBuilder } from "foldkit/html";

const view = (h: HtmlBuilder<Message>) => h.button([h.OnClick(Message.ClickedSave())], ["Save"]);
```

receives a development-only `data-foldmark-source` attribute containing the original call's file, line, and column (for example, `src/view.ts:3:41`). Locations are one-based. Foldmark's regular capture then includes that location, without a runtime source-map request.

The added attribute is **first** in the attribute list. Explicit `annotate(h, { source: ... })` or source attributes later on the same element remain authoritative. Existing attributes are evaluated once, in their original order; event handlers are neither wrapped nor replaced. A precise hint on a child element takes precedence over inherited ancestor metadata, as normal DOM capture does.

The transform parses JavaScript/TypeScript/JSX instead of replacing text patterns. Nested element calls, spread attributes, and expression-valued attribute lists are supported. Comments and strings are untouched. Generated high-resolution source maps preserve host-code positions through the added metadata. A second transform does not add duplicate hints.

### Deliberate limits

- The plugin only runs in Vite's development serve pipeline. Builds, production mode, `node_modules`, and Foldmark's own source directory are excluded.
- Supported calls are direct `builder.tag(attributes, children)` element constructors. Computed properties, destructured factories, aliases of a builder variable, `h.keyed(...)`, and custom-element factory calls are not instrumented.
- Imported type aliases such as `HtmlBuilder as Builder` are supported; arbitrary user-defined type aliases and builder values returned from other expressions are not inferred. Use explicit annotations or `builderNames` where appropriate.
- `builderNames` is an explicit trust declaration: every matching identifier in the included files must actually be a Foldkit builder. Prefer typed builders and narrowly scoped includes.
- Source hints describe the view call, not runtime state, a component stack, or model snapshots. Production source metadata remains opt-in through explicit `annotate` calls.

## Resolve a known generated location

For a host with its own generated-location instrumentation, import the separate browser-safe helper:

```ts
import { createSourceResolver } from "foldmark/source-map";
import { mountFoldmark } from "foldmark";

// Maps should come from a build manifest or another host-controlled source.
// The resolver never fetches URLs or reads files by itself.
const sourceResolver = createSourceResolver({
  loadSourceMap: async (generatedSourceUrl, signal) => {
    const entry = knownBuildMaps.get(generatedSourceUrl);
    if (!entry || signal.aborted) return null;
    return { map: entry.json, mapUrl: entry.absoluteMapUrl };
  },
});

const feedback = mountFoldmark({ sourceResolver });

// HMR invalidation: discard cached maps and pending resolution results.
sourceResolver.clearCache();

// Host teardown: the resolver can be shared, so its owner disposes it separately.
feedback.dispose();
sourceResolver.dispose();
```

`loadSourceMap` is the only I/O seam. It returns `{ map, mapUrl? }` or `null`, synchronously or asynchronously. `map` must be a version-3 **encoded** map object or its JSON string; indexed/decoded maps are not currently accepted. `mapUrl` is the map's absolute URL/path, used to resolve relative original source names; it defaults to the generated source URL. The optional second argument is an `AbortSignal` aborted on `dispose()`. A network-backed loader must explicitly allowlist known generated resources, restrict response sizes, and pass the signal to its own request. Never turn a DOM-provided URL into an unrestricted file read or authenticated fetch.

By default the resolver looks for this tuple on the selected element or its nearest ancestor carrying the URL:

```html
<button
  data-foldmark-source-url="http://localhost:5173/assets/app.js"
  data-foldmark-source-line="120"
  data-foldmark-source-column="7"
>
  Save
</button>
```

All three values must belong to the **same** ancestor; line/column must be positive integers. Open-shadow and accessible frame-owner ancestry is supported. Source URLs are linkage supplied by your instrumentation, not extracted from arbitrary DOM contents or JavaScript stacks.

For another linkage format, provide `resolveGenerated(element, context)`, returning `{ source, line, column }` or `null`. All public positions are **one-based lines and columns**; the helper converts to the source-map library's zero-based columns internally.

Existing nonempty `context.source` is preserved without loading a map. Missing locations, unavailable mappings, invalid maps, loader errors, and disposed resolvers leave the original context unchanged. Other context fields are retained after successful resolution. Map loads are deduplicated and held in a bounded cache (`maxCacheEntries`, default 32, range 1–256); missing/failed maps can be retried. `clearCache()` invalidates outstanding resolution results, and `dispose()` stops future resolution and aborts loader work.

## Verification

`tests/vite.test.ts` covers supported calls, renamed builders, explicit metadata precedence, event-handler identity, shadowed names, comments/strings, TS syntax, duplicate transforms, path escaping, source-map accuracy, and production exclusion. `tests/source-map.test.ts` covers original-source precedence, generated-location inheritance, validation, caching, failures, and disposal. These are transform/reader-interface tests, not a claim that every third-party view factory or browser framework can be mapped automatically.
