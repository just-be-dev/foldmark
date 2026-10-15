# Pi feedback integration

The optional Pi extension turns explicitly submitted Foldmark feedback into a normal user turn in the current Pi session. It uses the authenticated local companion’s durable HTTP queue. Generic MCP tools/resources remain available independently; an MCP resource notification alone does **not** guarantee that an agent host starts a turn.

Loading the extension does not contact the companion or start work. There are two separate permissions:

1. A developer enables the Pi watcher for the current session.
2. A browser user explicitly chooses **Send to agent** in Foldmark.

Saving, editing, or selecting a note does not send it to Pi. Enabling the watcher includes previously submitted pending requests for the configured project. Review those requests before enabling it.

## Compatibility and installation

The extension is typechecked against `@earendil-works/pi-coding-agent@1.1.0`. It uses `before_agent_start`, `agent_before_settle`, and `agent_settled`; older Pi releases without those events are not supported. Pi provides the runtime extension API. Foldmark does not install a second Pi runtime.

From this checkout:

```sh
npm run build
pi --extension /absolute/path/to/foldmark/dist/pi.js
```

The published/local tarball includes `dist/pi.js` and its generated shared modules. Load that path from your installed package, or install the package’s Pi resources with `pi install /absolute/path/to/foldmark`. The package’s `pi.extensions` manifest identifies the compiled extension. No source-checkout paths or globally installed implementation files are required by the built extension.

The extension is optional even when loaded: it remains dormant until activation. Do not load both its source entry and compiled entry in the same Pi invocation.

## Pair the companion and browser

Start one companion for the workspace. Choose a project identifier explicitly so the browser and Pi use the same value:

```sh
node /absolute/path/to/foldmark/dist/server.js \
  --project checkout-ui \
  --data-dir "$HOME/.local/share/foldmark/checkout-ui" \
  --origin http://localhost:5173
```

The server binds to loopback and prints the private pairing-token **file path**, not the credential. Add each actual browser origin with another `--origin`; scheme, hostname, and port must match exactly. See [feedback server](feedback-server.md) for MCP configuration, storage, authentication, and deployment limits. Do not launch another writer against the same data directory.

In the terminal where you will start Pi, read the credential without echoing it:

```sh
export FOLDMARK_ENDPOINT=http://127.0.0.1:5177
export FOLDMARK_PROJECT_ID=checkout-ui
export FOLDMARK_TOKEN="$(< "$HOME/.local/share/foldmark/checkout-ui/pairing-token")"
export FOLDMARK_WORKSPACE=/absolute/path/to/your/app
cd "$FOLDMARK_WORKSPACE"
pi --extension /absolute/path/to/foldmark/dist/pi.js
```

`FOLDMARK_WORKSPACE` is optional and defaults to the process working directory when the extension loads. The watcher refuses activation in a different working directory. Restart Pi with the appropriate configuration to target another workspace. Endpoint, project ID, token, and workspace are trusted configuration, never values extracted from captured feedback.

The browser app separately opts into the same endpoint/project/token through `mountFoldmark({ feedback: { endpoint, projectId, token } })`. Keep that development pairing token out of committed source, reports, URLs, analytics, and production builds. Browser JavaScript on a paired origin can access its configured credential: pairing is a local development trust decision, not protection against hostile code already running in that app.

## Enable, inspect, and stop

In an interactive Pi session:

```text
/foldmark enable
/foldmark status
/foldmark disable
```

`enable` requires confirmation before creating the client or polling. The confirmation states that submitted feedback can use the session’s normal tools and permissions. Non-interactive commands cannot bypass that confirmation.

For explicitly approved startup, including RPC or other non-interactive hosts that keep the Pi session alive, command-line approval is available:

```sh
pi --extension /absolute/path/to/foldmark/dist/pi.js --foldmark-enable
```

That flag authorizes the watcher for the invocation, including session starts in the configured workspace. Merely setting credentials or loading the extension is not approval. There is no persisted “always allow” setting. The watcher does not turn a one-shot print invocation into a daemon or keep an otherwise finished process alive.

Then capture notes in Foldmark and choose **Send to agent**. Foldmark displays request status as the agent claims and finishes work. The Pi status line and notifications report connection trouble or claim loss; headless modes receive safe status text on stderr, not stdout. Credentials and captured request content are never logged by the extension.

## Delivery and lifecycle guarantees

- One feedback request is processed at a time, and only when Pi is idle with no queued messages. The watcher does not steer an active run or enqueue a task behind unrelated work.
- The companion atomically claims requests with a secret ownership token. The watcher uses a two-minute lease, renews it during long work, and stops before expiry if ownership cannot be maintained. Claim credentials are not put in the model prompt or browser-visible request records.
- Feedback is delivered as a normal user message with prompt-template and extension-command expansion disabled. Captured notes, text, selectors, source hints, URLs, and images are explicitly labeled untrusted data. They do not become system instructions, shell commands, paths to execute, or additional permissions. Existing host tool approvals and workspace policies still apply; the extension does not sandbox the model or replace those policies.
- Every multi-selected target group and every consent-captured PNG/JPEG/WebP screenshot is delivered together. Screenshots are actual image content, not base64 embedded into text. Automatic delivery allows at most 20 screenshots and eight million base64 characters per request. Use an image-capable model when sending screenshots.
- Complete serialized request context must fit within 48,000 characters. Requests exceeding text or image limits are marked failed with an actionable split-request message, before any agent turn starts. Groups and screenshots are never silently dropped or truncated to make a partial turn look successful. The full durable request remains available for review or resubmission. An automatic enable is bounded to 20 completed or failed requests; disable and enable again to authorize another batch.
- A unique prompt is matched at `before_agent_start`. A request is completed only after that run has a successful final `agent_before_settle` outcome, a final assistant result, and a non-aborted `agent_settled` event. `agent_end` alone is not considered completion.
- Provider errors, interruptions, foreign input/runs, renewal disconnection, or lost claims cannot be reported as success. Interrupted/error runs with a valid claim are recorded as failed. Successful settlement means the agent run finished, not an independent guarantee that its code changes are correct; the returned summary should state its verification.
- Event cursors are replayed, and every idle pass reconciles the durable queue, including after missed events or event-log reset. Connectivity failures use bounded backoff. Completion retries reuse the same request and ownership token.
- Disable, session shutdown, switch, fork, and tree navigation cancel polling and HTTP work. An owned active run is interrupted. No successful completion is inferred during shutdown; unfinished claims remain durable and can be reclaimed after lease expiry.

The browser submits tasks; the companion stores and coordinates them; the Pi extension controls whether this host may start agent turns. A different agent host needs its own activation/wake adapter or must explicitly poll/read the MCP queue.

## Checks

```sh
npm test -- --run tests/pi
npm run typecheck
npm run build
```

The tests cover the bridge state machine and extension opt-in/lifecycle, plus real authenticated loopback HTTP and filesystem persistence: browser submission, atomic claim, correlated fake Pi turn, completion visible through the browser client, restart recovery, failed/interrupted outcomes, renewal, ownership loss, and shutdown. They do not call a paid model or establish that every third-party Pi extension preserves the prompt and lifecycle contracts.
