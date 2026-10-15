# Working on Foldmark

Foldmark is an original visual-feedback widget for Foldkit. Keep the library reusable; the demo is a consumer, not its implementation. Do not copy upstream Agentation code or assets.

Use Schema-defined data, fact-named Messages, a pure update function, explicit Commands for effects, and ports for browser interop. Keep DOM access out of view and update. Own every listener and external resource in the mount/dispose lifecycle. Never capture application state or send feedback over the network implicitly.

Before changing Foldkit APIs, inspect the pinned package's declarations in `node_modules/foldkit` and the official docs. The peer versions are deliberately exact. Do not upgrade Effect independently of Foldkit's peer requirements.

## Effect best practices

Always consult effect-solutions before writing Effect code. Run it with `mise run effect-solutions`.

1. Run `mise run effect-solutions list`.
2. Run `mise run effect-solutions show <topic>...` for relevant patterns.
3. Check the installed Effect 4 source for current APIs; older guide examples may need adaptation.

Use bare imports such as `import * as Effect from "effect/Effect"`. Prefer Schema.Struct records and named Commands. Do not silence errors with `as any` or non-null assertions.

## Tooling

mise pins Bun and Node; `mise trust && mise install` sets up everything and installs from `bun.lock`. Use Bun for packages and scripts (`bun add`, `bunx`), never npm. Oxlint lints with the Effect and Foldkit plugins (`oxlint.config.ts`), and Oxfmt formats. Unit tests use Vitest; write Effect tests with `@effect/vitest` (`it.effect`). Lint runs clean; fix findings rather than adding overrides. Messages live in `src/message.ts`, absent Model values use `Option` with a `maybe*` name, and time, randomness, and UUIDs come from Effect (`Clock`, `Crypto.Crypto`) inside Command `execute`.

Run `mise run check` (typecheck, lint, test, format:check) and `mise run build` for library changes. Run `mise run test:browser` for capture, lifecycle, or UI behavior changes. Inspect screenshots when changing layout. Do not commit generated builds, browser traces, or node_modules.
