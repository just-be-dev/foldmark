# Local feedback loop and MCP

Foldmark's companion connects explicit browser feedback to a coding agent:

1. Capture and edit notes locally.
2. Choose **Send to agent** to submit the open notes on the current page.
3. The companion commits a request to its private disk queue.
4. A paired Pi integration or an MCP client reads and claims the request.
5. The agent makes and verifies changes, then reports completion or failure.
6. Foldmark reads the request status and displays the result.

Saving a note, creating the transport, and importing the package do **not** submit feedback. Configuring feedback enables status reads; the submit operation remains an explicit action. There is no cloud service and no arbitrary code execution in the companion.

## Start and pair

From a source checkout:

```sh
mise run feedback -- --project my-app --origin http://localhost:5173
```

After building/installing the package:

```sh
foldmark-server --project my-app --origin http://localhost:5173
```

Defaults are `http://127.0.0.1:5177`, the exact allowed browser origin `http://localhost:5173`, and a private directory at `~/.local/share/foldmark/<project-id>`. Without `--project`, the project ID is a stable hash of the working directory. Supply a distinct project ID and private directory for each app. Origins include the port: `http://127.0.0.1:5173` is different from `http://localhost:5173`.

The readiness message is written to **stderr**. It prints the endpoint, project ID, allowed origins, and the path to `pairing-token`—never the credential itself. Read that file locally and pass its value to the development app:

```ts
import { mountFoldmark } from "foldmark";

const feedback = mountFoldmark({
  feedback: {
    endpoint: "http://127.0.0.1:5177",
    projectId: "my-app",
    token: pairingToken, // Read/paste locally. Never commit, export, or put in a URL.
  },
});

// The host still owns this lifecycle.
import.meta.hot?.dispose(() => feedback.dispose());
```

`pairingToken` above is host-supplied configuration, not a Foldmark global. Keep this integration development-only. Browser JavaScript must hold the credential to send authenticated requests; every script running in that development page shares its trust. Do not pair hostile pages or expose the credential in a public deployment.

The HTTP server accepts only loopback binds (`127.0.0.1` or `::1`). It validates Host, checks browser origins against an exact allowlist, requires a bearer credential on every data endpoint, rejects compressed request bodies, and caps incoming JSON at 8 MiB. No permissive `*` CORS or query-string credentials are supported. A configured browser origin is not a substitute for authentication.

## Agent integration

### Pi

Use the optional Pi integration documented in the package README. It uses the same explicit submissions, claims, leases, and completion records as MCP. Its host integration can start an agent turn; an MCP resource update by itself does not guarantee that a generic agent host starts a turn.

### MCP stdio

Run **one** companion process for the project with `--mcp`. This single process serves the browser HTTP endpoint and MCP stdio, sharing one queue writer. Do not also start a separate HTTP companion against the same private data directory.

An MCP host configuration commonly looks like this; adapt the outer configuration shape to your host:

```json
{
  "mcpServers": {
    "foldmark": {
      "command": "node",
      "args": [
        "/absolute/path/to/foldmark/dist/server.js",
        "--mcp",
        "--project",
        "my-app",
        "--origin",
        "http://localhost:5173"
      ]
    }
  }
}
```

This implementation uses the official `@modelcontextprotocol/server@2.3.1` serving entry. It supports the 2026-07-28 protocol's `subscriptions/listen` resource subscriptions and the SDK's compatible 2025-era stdio negotiation. Both paths are exercised with the official SDK client in tests.

Exposed tools:

- `foldmark_list_requests({ status?, offset?, limit? })`
- `foldmark_get_request({ id })`
- `foldmark_claim_request({ id, owner, leaseMs?, claimToken? })`
- `foldmark_complete_request({ id, claimToken, status, message? })`

Resource URIs:

```text
foldmark://feedback/projects/my-app/pending
foldmark://feedback/projects/my-app/requests/<request-id>
```

The pending resource lists pending requests, including requests durably returned to pending after lease expiry. For current clients, request `notifications/resources/updated` through the `resourceSubscriptions` filter of `subscriptions/listen`. Legacy clients use `resources/subscribe`. Updates identify a resource URI; clients reread its contents. Resource-list changes are separate notifications. A queue commit happens before notifications are emitted.

MCP notifications are **not prompts, instructions, or guaranteed agent wake-up events**. A generic host may only refresh resources, may not support subscriptions, or may require the user to ask the agent to process feedback. Portable tools remain usable without push support. Sampling/elicitation is not abused as an unsolicited turn trigger. An owned nearest-expiry timer durably returns expired claims to `pending` and emits a resource update even without another user mutation. Renewal and completion reschedule or cancel it; restart restores scheduling, and shutdown disposes it. Clients should still reread pending work after connecting or reconnecting because notifications are not a durable delivery guarantee.

### MCP context and image delivery

MCP presentation is deliberately different from the unchanged versioned HTTP/store JSON:

- `foldmark_list_requests` and the pending resource return **summaries only**: request identity, status, revision, timestamps, annotation/target/attachment counts, and a detail resource URI. Pages default to 25 requests; tool pages allow up to 50. The response includes `total` and `nextOffset`, so remaining requests are explicit rather than silently hidden.
- Detail resources return a summary, attachment descriptors, and an explicit `foldmark_get_request({ id })` instruction. Discover detail URIs through the paged catalog rather than enumerating every request globally.
- `foldmark_get_request` returns every annotation and grouped target, source hint, style, note, and screenshot metadata in JSON text **without `dataUrl`**. Screenshot bytes are delivered as actual MCP `image` content blocks. Descriptors identify their content-block positions. Generic multimodal clients can therefore see images without base64 flooding their text context.
- Claim responses contain `{ request: summary, claimToken }`; completion responses contain a summary. No other response includes that private claim credential, and none of these text surfaces embeds screenshot bytes.

A get-request response is **all or fail**: at most **20 images**, **8,000,000 encoded image characters in total**, and **48,000 UTF-8 bytes of complete metadata text**. If any limit is exceeded or an attachment is invalid, the tool returns actionable `isError` content with no partial annotations or images. Split the notes into smaller explicit requests or recapture smaller screenshots, then submit again. Do not act on a summary alone, and do not assume an oversized request was partially delivered.

Captured page text, selectors, notes, source hints, and screenshot contents are untrusted feedback. The server does not read source files or execute commands named in a request. The coding agent must use its normal permissions and verify requested changes before completing a request.

## Browser and host transport interface

For a host-owned integration without the toolbar:

```ts
import { createFeedbackClient } from "foldmark";

const client = createFeedbackClient({
  endpoint: "http://127.0.0.1:5177",
  projectId: "my-app",
  token: pairingToken,
});

// No I/O until a method is called. Keep an ID across a retry of the SAME submission.
const requestId = crypto.randomUUID();
const submitted = await client.submit(annotations, { requestId });
const status = await client.get(submitted.id);
const changes = await client.events(0);
client.dispose(); // Aborts owned in-flight requests; future methods fail.
```

The client also provides `list()`, `claim(id, input)`, `complete(id, input)`, and `close()` (an alias of `dispose`). Server errors preserve `FeedbackTransportError` with an inspectable `.status` and `.code`; a competing active claim produces status `409` and code `claimed`.

HTTP routes, all authenticated with `Authorization: Bearer <token>`:

```text
GET  /v1/projects/<project-id>/requests
POST /v1/projects/<project-id>/requests
GET  /v1/projects/<project-id>/requests/<id>
POST /v1/projects/<project-id>/requests/<id>/claim
POST /v1/projects/<project-id>/requests/<id>/complete
GET  /v1/projects/<project-id>/events?after=<cursor>
```

A submission is `{ "version": 1, "requestId": "...", "annotations": [...] }`. It must contain 1–100 valid annotations. Reusing its ID with identical decoded annotations returns the same request without adding an event. Reusing an ID with different annotations returns `409 idempotency_conflict`. A client should retain an ID when retrying an ambiguous network failure, not generate a fresh ID for the same send.

Requests move from `pending` to `claimed` to `completed` or `failed`. Claim responses contain `{ request, claimToken }`; list/get/resource responses **never expose the claim credential**. Leases default to five minutes and can be set to 15 seconds–one hour. An active renewal must supply the same owner and current token. Even the same owner cannot acquire an active claim without its token. After expiry, acquire a new claim without the old token; the old agent can no longer renew or complete it. Completion is idempotent for the same token, status, and message. Finished requests cannot be reopened by an agent; a user can explicitly submit another request.

Events are metadata-only and have monotonic cursors. `events(after)` returns `{ cursor, reset, events }`. If `reset` is true, reread the list and continue from the returned cursor. The companion retains at most 10,000 events, 2,000 requests, and a 128 MiB snapshot. It does not silently evict requests or deduplication IDs; a full queue reports a visible capacity error. Archive the private directory and start a new queue when needed.

## Persistence, recovery, and credentials

The dedicated data directory is mode `0700`; credentials, lock, and snapshot files are mode `0600`. Snapshot data includes private claim credentials and captured feedback: do not publish or check in this directory. Writes are serialized: temporary file contents are flushed, the snapshot is atomically renamed, and its containing directory is flushed before acknowledgment and observer delivery. A failed pre-commit write leaves the previous state and event cursor intact. If rename succeeds but the directory flush fails, the server reports `503 durability`—not a false rollback—stops accepting queue operations, and sends no notification. Stop and restart it, then reconcile using the same submission ID; the replaced snapshot may already contain that request. This is a single-process local queue, not a replicated database, and it requires a local filesystem that supports directory synchronization.

A normal shutdown releases `instance.lock`; restarts recover requests, cursor history, and active claims. A second process targeting the same directory is refused. A crash leaves the lock **fail-closed** rather than racing another process to steal it. If startup reports a lock:

1. Read `instance.lock` locally; its prefix is the owning PID.
2. Verify that process has exited and that no other Foldmark companion owns this directory.
3. Only then remove that stale lock and restart. Do not remove an active process's lock.

Corrupt or incompatible snapshots are preserved and startup fails rather than silently dropping requests. To rotate the browser pairing credential, stop the companion, remove only its `pairing-token` file, restart, and explicitly pair the new token with the app and agent. Queue contents remain. Existing agent claim credentials are separate from the browser pairing token.

## CLI configuration

Run `foldmark-server --help` for flags. Supported flags are `--mcp`, `--project`, `--data-dir`, `--port`, repeatable `--origin`, and `--host`. Equivalent environment settings are `FOLDMARK_PROJECT`, `FOLDMARK_DATA_DIR`, `FOLDMARK_PORT`, `FOLDMARK_HOST`, and comma-separated `FOLDMARK_ORIGINS`; explicit flags win. Use a dedicated private directory with `--data-dir`, not an unrelated existing directory. No argument accepts a browser credential, and no credential is emitted to stdout.

## Verification

```sh
bunx vitest run tests/server tests/transport.test.ts
mise run typecheck
mise run build
```

Tests cover explicit transport submission, cancellation, error identity, origin/Host/auth rejection, body limits, project isolation, concurrent deduplication and claims, pre-commit rollback and post-rename uncertainty, expiry scheduling and restart, private file modes, protocol-only CLI stdout and shutdown, and real legacy/current MCP subscription delivery (including lease expiry without another mutation). They do not establish that every third-party MCP host automatically schedules an agent turn.

Primary protocol reference: [official TypeScript SDK revision migration](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28).
