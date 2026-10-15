import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { FeedbackClaimInput, FeedbackCompleteInput, FeedbackSubmission } from '../src/feedback'
import { FeedbackStoreError, type FeedbackStore } from './store'

export interface FeedbackHttpOptions {
  store: FeedbackStore
  token: string
  host?: '127.0.0.1' | '::1'
  port?: number
  /** Exact browser origins, including port. Empty means no browser origin is permitted. */
  allowedOrigins?: readonly string[]
  maxBodyBytes?: number
}
export interface FeedbackHttpServer {
  readonly endpoint: string
  close: () => Promise<void>
}
const deny = (status: number, code: string, message: string) =>
  new FeedbackStoreError({ status, code, message })
const secretMatches = (actual: string, expected: string) => {
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}
const send = (response: ServerResponse, status: number, data: unknown) => {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(data))
}
async function body(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
    throw deny(415, 'content_type', 'Requests must use application/json.')
  if (request.headers['content-encoding'])
    throw deny(415, 'encoding', 'Compressed request bodies are not accepted.')
  const declared = request.headers['content-length']
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes))
    throw deny(413, 'body_limit', 'Feedback request body is too large.')
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > maxBytes) throw deny(413, 'body_limit', 'Feedback request body is too large.')
    chunks.push(bytes)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw deny(400, 'json', 'Feedback request body is not valid JSON.')
  }
}

/** The loopback HTTP adapter performs no agent work and never evaluates captured content. */
export async function startFeedbackHttpServer(
  options: FeedbackHttpOptions,
): Promise<FeedbackHttpServer> {
  const host = options.host ?? '127.0.0.1'
  if (host !== '127.0.0.1' && host !== '::1')
    throw deny(500, 'configuration', 'Feedback server may bind only to loopback.')
  if (!/^[a-zA-Z0-9_-]{32,256}$/.test(options.token))
    throw deny(500, 'configuration', 'Feedback server requires a valid pairing credential.')
  const maxBytes = options.maxBodyBytes ?? 8 * 1024 * 1024
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024)
    throw deny(500, 'configuration', 'Feedback body limit must be 1–16777216 bytes.')
  const origins = new Set(options.allowedOrigins ?? [])
  for (const origin of origins) {
    let parsed: URL
    try {
      parsed = new URL(origin)
    } catch {
      throw deny(500, 'configuration', 'Allowed browser origins must be valid HTTP(S) origins.')
    }
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.origin !== origin ||
      parsed.username ||
      parsed.password
    )
      throw deny(500, 'configuration', 'Allowed browser origins must be exact HTTP(S) origins.')
  }
  let port = options.port ?? 5177
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Content-Security-Policy', "default-src 'none'")
    response.setHeader('Vary', 'Origin')
    void (async () => {
      const hostHeader = request.headers.host
      if (
        !hostHeader ||
        request.rawHeaders.filter(
          (value, index) => index % 2 === 0 && value.toLowerCase() === 'host',
        ).length !== 1 ||
        !new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]).has(hostHeader)
      )
        throw deny(403, 'host', 'Feedback Host header is not allowed.')
      const origin = request.headers.origin
      if (origin && (!origins.has(origin) || origin === 'null'))
        throw deny(403, 'origin', 'This browser origin is not paired with Foldmark.')
      if (origin) response.setHeader('Access-Control-Allow-Origin', origin)
      if (request.method === 'OPTIONS') {
        const method = request.headers['access-control-request-method']
        const headers = (request.headers['access-control-request-headers'] ?? '')
          .split(',')
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean)
        if (
          !origin ||
          !['GET', 'POST'].includes(method ?? '') ||
          headers.some((value) => !['authorization', 'content-type'].includes(value))
        )
          throw deny(403, 'preflight', 'Feedback preflight is not allowed.')
        response.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET, POST',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Max-Age': '300',
        })
        response.end()
        return
      }
      const authorization = request.headers.authorization
      if (!authorization || !secretMatches(authorization, `Bearer ${options.token}`))
        throw deny(401, 'authentication', 'A valid Foldmark pairing credential is required.')
      const url = new URL(request.url ?? '/', `http://${hostHeader}`)
      const segments = url.pathname.split('/').filter(Boolean)
      if (
        segments.length < 4 ||
        segments[0] !== 'v1' ||
        segments[1] !== 'projects' ||
        segments[2] !== options.store.projectId
      )
        throw deny(404, 'not_found', 'Feedback endpoint was not found.')
      if (request.method === 'GET' && segments[3] === 'events' && segments.length === 4) {
        if (
          [...url.searchParams.keys()].some((key) => key !== 'after') ||
          url.searchParams.getAll('after').length > 1
        )
          throw deny(400, 'query', 'Unexpected feedback event query parameter.')
        const raw = url.searchParams.get('after') ?? '0'
        if (!/^\d+$/.test(raw)) throw deny(400, 'cursor', 'Feedback event cursor is invalid.')
        send(response, 200, await options.store.events(Number(raw)))
        return
      }
      if (url.search)
        throw deny(400, 'query', 'Feedback credentials and options must not appear in URLs.')
      if (segments[3] !== 'requests')
        throw deny(404, 'not_found', 'Feedback endpoint was not found.')
      const id = segments[4]
      if (request.method === 'GET' && segments.length === 4) {
        send(response, 200, { requests: await options.store.list() })
      } else if (request.method === 'GET' && id && segments.length === 5) {
        send(response, 200, await options.store.get(id))
      } else if (request.method === 'POST' && segments.length === 4) {
        const input = await Effect.runPromise(
          Schema.decodeUnknownEffect(FeedbackSubmission)(await body(request, maxBytes)),
        )
        send(response, 200, await options.store.submit(input))
      } else if (
        request.method === 'POST' &&
        id &&
        segments.length === 6 &&
        segments[5] === 'claim'
      ) {
        const input = await Effect.runPromise(
          Schema.decodeUnknownEffect(FeedbackClaimInput)(await body(request, maxBytes)),
        )
        send(response, 200, await options.store.claim(id, input))
      } else if (
        request.method === 'POST' &&
        id &&
        segments.length === 6 &&
        segments[5] === 'complete'
      ) {
        const input = await Effect.runPromise(
          Schema.decodeUnknownEffect(FeedbackCompleteInput)(await body(request, maxBytes)),
        )
        send(response, 200, await options.store.complete(id, input))
      } else throw deny(405, 'method', 'Feedback endpoint or method is not supported.')
    })().catch((error: unknown) => {
      if (error instanceof FeedbackStoreError)
        send(response, error.status, { error: error.code, message: error.message })
      else
        send(response, 400, {
          error: 'invalid',
          message: 'Feedback request could not be validated.',
        })
    })
  })
  server.requestTimeout = 20_000
  server.headersTimeout = 10_000
  server.keepAliveTimeout = 5_000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw deny(500, 'configuration', 'Feedback server did not receive a loopback address.')
  }
  port = (address satisfies AddressInfo).port
  return {
    endpoint: `http://${host === '::1' ? '[::1]' : host}:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      }),
  }
}
