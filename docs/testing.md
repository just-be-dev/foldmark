# Verification and release checks

Use Node.js **22.19.0 or later**. CI pins Node 24.13.0 and the Playwright 1.63.0
Ubuntu Noble image; keep that image aligned with the exact `@playwright/test`
version in `package.json`.

```sh
npm ci
npx playwright install chromium firefox webkit
npm run typecheck
npm test
npm run build
npm run build:demo
npm run test:consumer
npm run test:browser
npm run format:check
```

A passing local command is not evidence of a published package, deployed service,
or completed CI run. Browser rendering is checked in Chromium, Firefox, and
WebKit; these are the Playwright engines, not every shipping browser version.

## Packaged consumer

`npm run test:consumer` must run **after the library build**. It:

- Packs the real npm tarball without running package lifecycle scripts again.
- Verifies every declared ESM/declaration export target exists in the tarball.
- Installs that tarball, exact Foldkit/Effect peers, and the pinned test toolchain
  into an independent temporary app. It does not use `npm link`, workspace source
  imports, or the development checkout's `node_modules` for the consumer.
- Typechecks the public root interface and every entrypoint advertising types,
  without `skipLibCheck`.
- Imports every public ESM entrypoint in Node with no document, exercises the
  server-safe root mount's no-op lifecycle, and invokes the installed CLI's
  `--help` to require a successful exit and clean MCP stdout.
- Builds the consumer into production assets, then mounts the installed widget,
  captures, saves, edits, exports, resolves, reopens, and deletes a note. It also
  verifies duplicate-mount rejection, disposes twice, remounts, and disposes again
  in a real browser.
- Repeats that browser workflow against a real development server with the exact
  `@foldkit/vite-plugin@0.26.0` and `optimizeDeps: { include: ['effect'] }`. The
  optimizer setting keeps one Schema instance when Foldkit's Effect barrel and
  Foldmark's Effect subpath imports meet in the pinned Vite toolchain. Runtime
  DevTools/MCP exposure is disabled for this test server.

Chromium runs production and development smoke by default. Check both modes in
all three engines with:

```sh
FOLDMARK_CONSUMER_BROWSERS=chromium,firefox,webkit npm run test:consumer
```

This smoke test installs dependencies in the temporary app and needs npm registry
access or a populated npm cache. Installs skip lifecycle scripts and never change
the repository lockfile. Each subprocess has a three-minute timeout; failures,
interruptions, and successful runs clean the temporary app and child processes.
For diagnosis only, `FOLDMARK_KEEP_CONSUMER=1` retains the temporary directory and
prints its path. The fixture's TypeScript files end in `.fixture` so root
`typecheck` does not accidentally resolve the unpublished package before a build.

## Browser workflows

`npm run test:browser` runs every workflow in Chromium, Firefox, and WebKit.
Contexts are isolated between tests. The Vite server binds only to loopback and
refuses a busy port rather than reusing a possibly unrelated development server.
If a concurrent test run owns the default port:

```sh
FOLDMARK_TEST_PORT=5186 npm run test:browser
```

The clipboard workflow replaces the clipboard interface with a deterministic
read/write fixture in each engine, because Firefox and WebKit do not implement
Chromium's clipboard permission names. It still asserts the copied report content
and the UI's success/failure behavior. This is not a native OS clipboard test.

Failure screenshots and retained traces go to Playwright's per-test output paths
under `test-results/<port>/`, not shared `/tmp` filenames. CI HTML reports use
`playwright-report/<port>/`. Distinct ports therefore isolate both servers and
artifacts for concurrent runs. Inspect a trace with `npx playwright show-trace`.

## Visual regression baselines

The desktop and mobile workflow tests use `toHaveScreenshot`, not screenshot-only
smoke checks. Baselines live in
`tests/browser/workflow.spec.ts-snapshots/` and are specific to browser and OS.
External Google font requests are blocked before navigation; locale, time zone,
color scheme, reduced motion, font readiness, animation handling, and hidden
carets are fixed. This makes font-network timing and active animations irrelevant
to the baseline. No broad pixel-difference allowance hides layout changes.

Generate baselines **only after the intended widget layout is stable**, inspect
the resulting desktop/mobile images, and commit the reviewed PNG files:

```sh
npx playwright test tests/browser/workflow.spec.ts \
  --grep 'mobile layout|desktop visual' --update-snapshots
```

Linux baselines must be generated in the same pinned Playwright image as CI,
not copied or renamed from macOS images. Docker reproduction is available:

```sh
node scripts/test-linux.mjs tests/browser/workflow.spec.ts \
  --grep 'mobile layout|desktop visual' --update-snapshots
# Re-run without --update-snapshots to prove the new images are stable:
node scripts/test-linux.mjs tests/browser/workflow.spec.ts \
  --grep 'mobile layout|desktop visual'
```

The helper uses Linux x86_64 to match the Ubuntu CI runner, including on an ARM
Mac. It mounts this checkout read-only, installs Linux dependencies into an
anonymous container workspace, and mounts only the snapshot and ignored test
output directories writable. It removes the container and workspace on success,
failure, interruption, or its twelve-minute timeout. Docker must be running and
may need to download the Playwright image. Diagnostic outputs are retained in
`test-results/linux/5176/`. `FOLDMARK_LINUX_PLATFORM` can override the architecture for
local behavioral debugging; do not use that override to bless CI baselines.

Missing or changed baselines fail CI. Do not use `--update-snapshots` in CI, and do
not refresh an image merely because the comparison fails: establish whether the
change is intended first.

## CI

`.github/workflows/ci.yml` uses read-only repository permissions, cancels superseded
runs, and runs install, typecheck, unit tests, both builds, all-engine packaged
consumer smoke in production and development, all-engine browser/visual
regressions, and formatting. Browser
failure evidence is uploaded for seven days. The workflow does not publish or
send feedback to an external agent.
