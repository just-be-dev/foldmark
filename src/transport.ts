import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { Annotation } from './model'
import {
  FeedbackClaimInput,
  FeedbackClaimResult,
  FeedbackCompleteInput,
  FeedbackEvents,
  FeedbackId,
  FeedbackList,
  FeedbackRequest,
  FeedbackSubmission,
} from './feedback'

export interface FeedbackClientOptions {
  /** Loopback HTTP(S) origin of the explicitly paired companion. */
  endpoint: string
  /** Pairing credential. Keep it out of URLs, reports, and application persistence. */
  token: string
  projectId: string
  timeoutMs?: number
  /** Dependency seam for hosts and deterministic transport tests. */
  fetch?: typeof globalThis.fetch
}
export class FeedbackTransportError extends Error {
  readonly name = 'FeedbackTransportError'
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
  ) {
    super(message)
  }
}
export interface FeedbackClient {
  submit: (
    annotations: readonly Annotation[],
    options?: { requestId?: string },
  ) => Promise<FeedbackRequest>
  list: () => Promise<readonly FeedbackRequest[]>
  get: (id: string) => Promise<FeedbackRequest>
  claim: (id: string, options: FeedbackClaimInput) => Promise<FeedbackClaimResult>
  complete: (id: string, options: FeedbackCompleteInput) => Promise<FeedbackRequest>
  events: (after?: number) => Promise<FeedbackEvents>
  dispose: () => void
  close: () => void
}

/** Creation does not perform I/O. Only explicit method calls contact the companion. */
export function createFeedbackClient(options: FeedbackClientOptions): FeedbackClient {
  let endpoint: URL
  try {
    endpoint = new URL(options.endpoint)
  } catch {
    throw new FeedbackTransportError(
      'configuration',
      'Feedback endpoint must be a valid loopback origin.',
    )
  }
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/'
  )
    throw new FeedbackTransportError(
      'configuration',
      'Feedback endpoint must be a loopback origin.',
    )
  if (!/^[a-zA-Z0-9_-]{32,256}$/.test(options.token))
    throw new FeedbackTransportError('configuration', 'A valid pairing token is required.')
  const projectId = Schema.decodeSync(FeedbackId)(options.projectId)
  const timeoutMs = options.timeoutMs ?? 15_000
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000)
    throw new FeedbackTransportError('configuration', 'Feedback timeout must be 100–120000 ms.')
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
  const controllers = new Set<AbortController>()
  let disposed = false
  const path = `/v1/projects/${encodeURIComponent(projectId)}`
  const request = <T>(
    method: string,
    route: string,
    schema: Schema.Decoder<T>,
    body?: unknown,
  ): Promise<T> => {
    if (disposed)
      return Promise.reject(
        new FeedbackTransportError('disposed', 'The feedback connection is closed.'),
      )
    // Cancellation is owned by this client, not detached from its dispose lifecycle.
    const controller = new AbortController()
    controllers.add(controller)
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const operation = Effect.fn('Foldmark.Feedback.request')(function* () {
      const data = yield* Effect.tryPromise({
        try: async () => {
          const response = await fetcher(endpoint.origin + path + route, {
            method,
            headers: {
              Authorization: `Bearer ${options.token}`,
              ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal,
            credentials: 'omit',
            cache: 'no-store',
            redirect: 'error',
            referrerPolicy: 'no-referrer',
          })
          const value: unknown = await response.json()
          if (!response.ok) {
            const error = Schema.decodeUnknownOption(
              Schema.Struct({ error: Schema.String, message: Schema.String }),
            )(value)
            if (error._tag === 'Some')
              throw new FeedbackTransportError(
                error.value.error,
                error.value.message,
                response.status,
              )
            throw new FeedbackTransportError(
              'http',
              'The companion rejected the request.',
              response.status,
            )
          }
          return value
        },
        catch: (error) =>
          error instanceof FeedbackTransportError
            ? error
            : new FeedbackTransportError(
                controller.signal.aborted ? 'aborted' : 'connection',
                controller.signal.aborted
                  ? 'Feedback request was cancelled or timed out.'
                  : 'Could not communicate with the feedback companion.',
              ),
      })
      return yield* Schema.decodeUnknownEffect(schema)(data).pipe(
        Effect.mapError(
          () =>
            new FeedbackTransportError(
              'validation',
              'The companion returned invalid feedback data.',
            ),
        ),
      )
    })
    return Effect.runPromise(operation()).finally(() => {
      clearTimeout(timer)
      controllers.delete(controller)
    })
  }
  const idPath = (id: string) =>
    `/requests/${encodeURIComponent(Schema.decodeSync(FeedbackId)(id))}`
  const dispose = () => {
    disposed = true
    for (const controller of controllers) controller.abort()
    controllers.clear()
  }
  return {
    submit: (annotations, submission = {}) => {
      const input = Schema.decodeSync(FeedbackSubmission)({
        version: 1,
        requestId: submission.requestId ?? crypto.randomUUID(),
        annotations,
      })
      return request('POST', '/requests', FeedbackRequest, input)
    },
    list: async () => (await request('GET', '/requests', FeedbackList)).requests,
    get: (id) => request('GET', idPath(id), FeedbackRequest),
    claim: (id, input) =>
      request(
        'POST',
        `${idPath(id)}/claim`,
        FeedbackClaimResult,
        Schema.decodeSync(FeedbackClaimInput)(input),
      ),
    complete: (id, input) =>
      request(
        'POST',
        `${idPath(id)}/complete`,
        FeedbackRequest,
        Schema.decodeSync(FeedbackCompleteInput)(input),
      ),
    events: (after = 0) => {
      if (!Number.isSafeInteger(after) || after < 0)
        return Promise.reject(
          new FeedbackTransportError('cursor', 'Invalid feedback event cursor.'),
        )
      return request('GET', `/events?after=${after}`, FeedbackEvents)
    },
    dispose,
    close: dispose,
  }
}
