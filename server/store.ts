import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  FeedbackClaimInput,
  FeedbackCompleteInput,
  FeedbackEvent,
  FeedbackId,
  FeedbackRequest,
  FeedbackSubmission,
  type FeedbackClaimResult,
  type FeedbackEvents,
} from "../src/feedback";

export class FeedbackStoreError extends Schema.TaggedError<FeedbackStoreError>()(
  "FeedbackStoreError",
  { code: Schema.String, message: Schema.String, status: Schema.Int },
) {}
const failure = (code: string, message: string, status = 409) =>
  new FeedbackStoreError({ code, message, status });
const StoredRequest = Schema.Struct({
  request: FeedbackRequest,
  submissionHash: Schema.String,
  claimToken: Schema.NullOr(Schema.String),
});
type StoredRequest = typeof StoredRequest.Type;
const Snapshot = Schema.Struct({
  version: Schema.Literal(1),
  projectId: FeedbackId,
  cursor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  requests: Schema.Array(StoredRequest),
  events: Schema.Array(FeedbackEvent),
});
type Snapshot = typeof Snapshot.Type;
export interface FeedbackStoreOptions {
  dataDir: string;
  projectId: string;
  /** Explicit clock seam shared by operations and the owned lease-expiry scheduler. */
  now?: () => number;
  maxRequests?: number;
  maxEvents?: number;
  /** Tests can fail persistence before commit without mocking filesystem globals. */
  persist?: (path: string, content: string) => Promise<void>;
  /** Owned expiration scheduler seam. The returned cancellation must be idempotent. */
  schedule?: (callback: () => void, delayMs: number) => () => void;
  onError?: (error: Error) => void;
}
export interface FeedbackStore {
  readonly projectId: string;
  submit: (input: FeedbackSubmission) => Promise<FeedbackRequest>;
  list: () => Promise<readonly FeedbackRequest[]>;
  get: (id: string) => Promise<FeedbackRequest>;
  claim: (id: string, input: FeedbackClaimInput) => Promise<FeedbackClaimResult>;
  complete: (id: string, input: FeedbackCompleteInput) => Promise<FeedbackRequest>;
  events: (after?: number) => Promise<FeedbackEvents>;
  subscribe: (listener: (event: FeedbackEvent) => void) => () => void;
  close: () => Promise<void>;
}
const clone = <T>(value: T): T => structuredClone(value);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const equalSecret = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
};
const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

/** Rename succeeded, but its directory entry could not be made crash-durable. */
export class FeedbackCommitUncertainError extends Error {
  readonly name = "FeedbackCommitUncertainError";
  readonly replaced = true;
  constructor() {
    super("Feedback snapshot was replaced, but directory durability could not be confirmed.");
  }
}
async function syncDirectory(path: string) {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** Flush file contents and the containing directory before acknowledging a commit. */
export async function atomicWrite(
  path: string,
  content: string,
  options: { syncDirectory?: (directory: string) => Promise<void> } = {},
): Promise<void> {
  const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(content, "utf8");
    await file.sync();
  } catch (error) {
    await file.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await file.close();
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  try {
    await (options.syncDirectory ?? syncDirectory)(dirname(path));
  } catch {
    throw new FeedbackCommitUncertainError();
  }
}

async function secureDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw failure(
      "configuration",
      "Feedback data directory must be a real private directory.",
      500,
    );
  await chmod(path, 0o700);
}

/** One writer owns a directory. Crash locks fail closed: never race another writer to steal a lock. */
async function acquireLock(directory: string) {
  const path = join(directory, "instance.lock");
  const identity = `${process.pid}:${randomBytes(24).toString("hex")}`;
  let file: FileHandle;
  try {
    file = await open(path, "wx", 0o600);
  } catch (error) {
    if (errorCode(error) === "EEXIST")
      throw failure(
        "locked",
        "Feedback data directory is locked. If the previous process crashed, verify its PID has exited before manually removing instance.lock.",
        503,
      );
    throw error;
  }
  try {
    await file.writeFile(identity, "utf8");
    await file.sync();
  } catch (error) {
    await file.close();
    await rm(path, { force: true });
    throw error;
  }
  await file.close();
  return async () => {
    if ((await readFile(path, "utf8").catch(() => "")) === identity)
      await rm(path, { force: true });
  };
}

/** Credential is local filesystem state, never a URL or a report field. */
export async function loadPairingToken(dataDir: string): Promise<string> {
  const directory = resolve(dataDir);
  await secureDirectory(directory);
  const path = join(directory, "pairing-token");
  try {
    const file = await open(path, "wx", 0o600);
    const token = randomBytes(32).toString("base64url");
    try {
      await file.writeFile(`${token}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    return token;
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink())
      throw failure("configuration", "Pairing credential must be a regular private file.", 500);
    await chmod(path, 0o600);
    const token = (await readFile(path, "utf8")).trim();
    if (!/^[a-zA-Z0-9_-]{32,256}$/.test(token))
      throw failure(
        "configuration",
        "Pairing credential is corrupt; inspect the private data directory.",
        500,
      );
    return token;
  }
}

/** Atomic persistence is the commit point. Readers and notifications see only committed snapshots. */
export async function createFeedbackStore(options: FeedbackStoreOptions): Promise<FeedbackStore> {
  const projectId = Schema.decodeSync(FeedbackId)(options.projectId);
  const directory = resolve(options.dataDir);
  await secureDirectory(directory);
  const releaseLock = await acquireLock(directory);
  const path = join(directory, "requests.json");
  const persist = options.persist ?? atomicWrite;
  const now = options.now ?? Date.now;
  const maxRequests = options.maxRequests ?? 2_000;
  const maxEvents = options.maxEvents ?? 10_000;
  if (
    !Number.isSafeInteger(maxRequests) ||
    maxRequests < 1 ||
    !Number.isSafeInteger(maxEvents) ||
    maxEvents < 1
  ) {
    await releaseLock();
    throw failure("configuration", "Queue limits must be positive integers.", 500);
  }
  let state: Snapshot;
  try {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || (await stat(path)).size > 128 * 1024 * 1024)
        throw failure("storage", "Feedback snapshot is not a bounded regular file.", 500);
      await chmod(path, 0o600);
      state = await Effect.runPromise(
        Schema.decodeUnknownEffect(Snapshot)(JSON.parse(await readFile(path, "utf8"))),
      );
      if (state.projectId !== projectId)
        throw failure("project", "This data directory belongs to another project.", 409);
      const ids = new Set(state.requests.map((row) => row.request.id));
      if (
        ids.size !== state.requests.length ||
        state.requests.some((row) => {
          const request = row.request;
          const validToken =
            row.claimToken !== null && /^[a-zA-Z0-9_-]{32,256}$/.test(row.claimToken);
          return (
            request.projectId !== projectId ||
            !/^[a-f0-9]{64}$/.test(row.submissionHash) ||
            !Number.isFinite(Date.parse(request.createdAt)) ||
            !Number.isFinite(Date.parse(request.updatedAt)) ||
            (request.status === "pending" &&
              (request.claim !== null || row.claimToken !== null || request.result !== null)) ||
            (request.status === "claimed" &&
              (!request.claim ||
                !validToken ||
                request.result !== null ||
                !Number.isFinite(Date.parse(request.claim.expiresAt)))) ||
            ((request.status === "completed" || request.status === "failed") &&
              (request.claim !== null || !validToken || request.result === null))
          );
        }) ||
        (state.events.length > 0 && state.events.at(-1)?.cursor !== state.cursor) ||
        state.events.some(
          (event, index) =>
            !ids.has(event.requestId) ||
            event.cursor > state.cursor ||
            (index > 0 && event.cursor !== (state.events[index - 1]?.cursor ?? 0) + 1),
        )
      )
        throw failure(
          "storage",
          "Feedback snapshot invariants are invalid; refusing to overwrite it.",
          500,
        );
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      state = { version: 1, projectId, cursor: 0, requests: [], events: [] };
    }
  } catch (error) {
    await releaseLock();
    throw error;
  }
  let closed = false;
  let accepting = true;
  let closing: Promise<void> | undefined;
  let unavailable: FeedbackStoreError | undefined;
  let cancelExpiry = () => {};
  const schedule =
    options.schedule ??
    ((callback: () => void, delayMs: number) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref();
      return () => clearTimeout(timer);
    });
  let tail: Promise<void> = Promise.resolve();
  const listeners = new Set<(event: FeedbackEvent) => void>();
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    if (!accepting) return Promise.reject(failure("closed", "Feedback store is closed.", 503));
    if (unavailable) return Promise.reject(unavailable);
    const result = tail.then(() => {
      if (unavailable) throw unavailable;
      return operation();
    });
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  const rowFor = (id: string) => {
    Schema.decodeSync(FeedbackId)(id);
    const row = state.requests.find((value) => value.request.id === id);
    if (!row) throw failure("not_found", "Feedback request was not found.", 404);
    return row;
  };
  const rescheduleExpiry = (minimumDelay = 0) => {
    cancelExpiry();
    cancelExpiry = () => {};
    if (!accepting || unavailable) return;
    const expirations = state.requests.flatMap((row) =>
      row.request.status === "claimed" && row.request.claim
        ? [Date.parse(row.request.claim.expiresAt)]
        : [],
    );
    if (expirations.length === 0) return;
    const delay = Math.max(minimumDelay, Math.min(...expirations) - now(), 0);
    cancelExpiry = schedule(
      () => {
        cancelExpiry = () => {};
        void serialized(async () => {
          const timestamp = now();
          const expired = state.requests.filter(
            (row) =>
              row.request.status === "claimed" &&
              row.request.claim &&
              Date.parse(row.request.claim.expiresAt) <= timestamp,
          );
          for (const row of expired) {
            await commit(
              {
                ...row,
                claimToken: null,
                request: {
                  ...row.request,
                  status: "pending",
                  claim: null,
                  updatedAt: new Date(timestamp).toISOString(),
                  revision: row.request.revision + 1,
                },
              },
              "lease_expired",
            );
          }
          rescheduleExpiry();
        }).catch((error: unknown) => {
          if (!accepting) return;
          try {
            options.onError?.(
              error instanceof Error ? error : new Error("Feedback lease expiration failed."),
            );
          } catch {
            /* Reporting never controls persistence. */
          }
          // A failed pre-commit write can be retried; an uncertain commit stops the queue.
          if (!unavailable) rescheduleExpiry(1_000);
        });
      },
      Math.min(delay, 2_147_483_647),
    );
  };
  const commit = async (
    row: StoredRequest,
    cause: FeedbackEvent["cause"],
  ): Promise<FeedbackRequest> => {
    const event: FeedbackEvent = {
      cursor: state.cursor + 1,
      requestId: row.request.id,
      status: row.request.status,
      updatedAt: row.request.updatedAt,
      cause,
    };
    const next: Snapshot = {
      ...state,
      cursor: event.cursor,
      requests: [...state.requests.filter((value) => value.request.id !== row.request.id), row],
      events: [...state.events, event].slice(-maxEvents),
    };
    const content = JSON.stringify(next);
    if (Buffer.byteLength(content, "utf8") > 128 * 1024 * 1024)
      throw failure(
        "capacity",
        "Feedback snapshot reached its storage limit. Archive this private queue before creating another.",
        503,
      );
    try {
      await persist(path, content);
    } catch (error) {
      if (error instanceof FeedbackCommitUncertainError) {
        // Rename already replaced the snapshot. Never claim rollback or continue writing over it.
        state = next;
        unavailable = failure(
          "durability",
          "Feedback snapshot was replaced but could not be made crash-durable. Restart the companion and retry with the same request ID.",
          503,
        );
        cancelExpiry();
        throw unavailable;
      }
      throw failure("storage", "Could not persist feedback. No change was committed.", 503);
    }
    state = next;
    rescheduleExpiry();
    for (const listener of listeners) {
      try {
        listener(clone(event));
      } catch {
        /* A disconnected observer cannot roll back a commit. */
      }
    }
    return clone(row.request);
  };
  const submitEffect = Effect.fn("Foldmark.Feedback.submit")((input: FeedbackSubmission) =>
    Effect.tryPromise({
      try: () =>
        serialized(async () => {
          const submission = Schema.decodeSync(FeedbackSubmission)(input);
          const digest = hash(JSON.stringify(submission.annotations));
          const previous = state.requests.find((row) => row.request.id === submission.requestId);
          if (previous) {
            if (previous.submissionHash !== digest)
              throw failure(
                "idempotency_conflict",
                "This request ID has already been used for different feedback.",
              );
            return clone(previous.request);
          }
          if (state.requests.length >= maxRequests)
            throw failure(
              "capacity",
              "Feedback queue is full. Archive its private data directory before starting a new queue.",
              503,
            );
          const timestamp = new Date(now()).toISOString();
          const request: FeedbackRequest = {
            id: submission.requestId,
            projectId,
            status: "pending",
            annotations: submission.annotations,
            createdAt: timestamp,
            updatedAt: timestamp,
            revision: 1,
            claim: null,
            result: null,
          };
          return commit({ request, submissionHash: digest, claimToken: null }, "submission");
        }),
      catch: (error) =>
        error instanceof FeedbackStoreError
          ? error
          : failure("invalid", "Feedback submission is invalid.", 400),
    }),
  );
  const claimEffect = Effect.fn("Foldmark.Feedback.claim")(
    (id: string, input: FeedbackClaimInput) =>
      Effect.tryPromise({
        try: () =>
          serialized(async () => {
            const values = Schema.decodeSync(FeedbackClaimInput)(input);
            const row = rowFor(id);
            const timestamp = now();
            if (row.request.status === "completed" || row.request.status === "failed")
              throw failure("finished", "Feedback request has already finished.");
            const active = row.request.claim && Date.parse(row.request.claim.expiresAt) > timestamp;
            if (
              active &&
              (!values.claimToken ||
                !row.claimToken ||
                !equalSecret(values.claimToken, row.claimToken) ||
                values.owner !== row.request.claim?.owner)
            )
              throw failure("claimed", "Feedback request is already claimed by an active agent.");
            if (!active && values.claimToken)
              throw failure(
                "lease_expired",
                "The previous feedback claim expired. Acquire a new claim.",
              );
            const claimToken =
              active && row.claimToken ? row.claimToken : randomBytes(32).toString("base64url");
            const request = await commit(
              {
                ...row,
                claimToken,
                request: {
                  ...row.request,
                  status: "claimed",
                  revision: row.request.revision + 1,
                  updatedAt: new Date(timestamp).toISOString(),
                  claim: {
                    owner: values.owner,
                    expiresAt: new Date(timestamp + (values.leaseMs ?? 300_000)).toISOString(),
                  },
                },
              },
              active ? "renewal" : "claim",
            );
            return { request, claimToken };
          }),
        catch: (error) =>
          error instanceof FeedbackStoreError
            ? error
            : failure("invalid", "Feedback claim is invalid.", 400),
      }),
  );
  const completeEffect = Effect.fn("Foldmark.Feedback.complete")(
    (id: string, input: FeedbackCompleteInput) =>
      Effect.tryPromise({
        try: () =>
          serialized(async () => {
            const values = Schema.decodeSync(FeedbackCompleteInput)(input);
            const row = rowFor(id);
            if (!row.claimToken || !equalSecret(values.claimToken, row.claimToken))
              throw failure("claim_token", "A matching claim credential is required.", 403);
            const message = values.message ?? "";
            if (row.request.status === "completed" || row.request.status === "failed") {
              if (row.request.status === values.status && row.request.result?.message === message)
                return clone(row.request);
              throw failure(
                "finished",
                "Feedback request already finished with a different result.",
              );
            }
            const timestamp = now();
            if (!row.request.claim || Date.parse(row.request.claim.expiresAt) <= timestamp)
              throw failure(
                "lease_expired",
                "Feedback claim expired; this agent can no longer complete it.",
              );
            return commit(
              {
                ...row,
                request: {
                  ...row.request,
                  status: values.status,
                  result: { message },
                  claim: null,
                  updatedAt: new Date(timestamp).toISOString(),
                  revision: row.request.revision + 1,
                },
              },
              "completion",
            );
          }),
        catch: (error) =>
          error instanceof FeedbackStoreError
            ? error
            : failure("invalid", "Feedback completion is invalid.", 400),
      }),
  );
  rescheduleExpiry();
  return {
    projectId,
    submit: (input) => Effect.runPromise(submitEffect(input)),
    list: () =>
      serialized(async () =>
        clone(
          state.requests
            .map((row) => row.request)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
        ),
      ),
    get: (id) => serialized(async () => clone(rowFor(id).request)),
    claim: (id, input) => Effect.runPromise(claimEffect(id, input)),
    complete: (id, input) => Effect.runPromise(completeEffect(id, input)),
    events: (after = 0) =>
      serialized(async () => {
        if (!Number.isSafeInteger(after) || after < 0)
          throw failure("cursor", "Feedback event cursor must be a non-negative integer.", 400);
        const oldest = state.events[0]?.cursor ?? state.cursor + 1;
        return clone({
          cursor: state.cursor,
          reset: after > state.cursor || after < oldest - 1,
          events: state.events.filter((event) => event.cursor > after),
        });
      }),
    subscribe: (listener) => {
      if (closed || !accepting) throw failure("closed", "Feedback store is closed.", 503);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => {
      accepting = false;
      cancelExpiry();
      closing ??= tail.then(async () => {
        closed = true;
        listeners.clear();
        await releaseLock();
      });
      return closing;
    },
  };
}
