import { request as nodeRequest } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createFeedbackStore } from '../../server/store'
import { startFeedbackHttpServer } from '../../server/http'
import { submission, token } from './fixtures'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture(maxBodyBytes?: number) {
  const dataDir = await mkdtemp(join(tmpdir(), 'foldmark-http-'))
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }))
  const store = await createFeedbackStore({ dataDir, projectId: 'test-project' })
  cleanup.push(() => store.close())
  const server = await startFeedbackHttpServer({
    store,
    token,
    port: 0,
    allowedOrigins: ['http://localhost:5173'],
    maxBodyBytes,
  })
  cleanup.push(() => server.close())
  return { store, server }
}
function raw(
  endpoint: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
) {
  return new Promise<{
    status: number
    headers: Record<string, string | string[] | undefined>
    body: string
  }>((resolve, reject) => {
    const request = nodeRequest(
      endpoint + path,
      { method: options.method ?? 'GET', headers: options.headers },
      (response) => {
        let content = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          content += chunk
        })
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: content }),
        )
      },
    )
    request.on('error', reject)
    request.end(options.body)
  })
}
const path = '/v1/projects/test-project/requests'
const authorization = { Authorization: `Bearer ${token}` }

describe('loopback HTTP security and ingestion', () => {
  test('requires bearer auth and exact origin/host validation even on read-only endpoints', async () => {
    const { server } = await fixture()
    expect((await raw(server.endpoint, path)).status).toBe(401)
    expect(
      (await raw(server.endpoint, path, { headers: { Authorization: 'Bearer wrong' } })).status,
    ).toBe(401)
    const forbiddenOrigin = await raw(server.endpoint, path, {
      headers: { ...authorization, Origin: 'https://attacker.test' },
    })
    expect(forbiddenOrigin.status).toBe(403)
    expect(forbiddenOrigin.headers['access-control-allow-origin']).toBeUndefined()
    expect(
      (await raw(server.endpoint, path, { headers: { ...authorization, Origin: 'null' } })).status,
    ).toBe(403)
    expect(
      (await raw(server.endpoint, path, { headers: { ...authorization, Host: 'attacker.test' } }))
        .status,
    ).toBe(403)
    const allowed = await raw(server.endpoint, path, {
      headers: { ...authorization, Origin: 'http://localhost:5173' },
    })
    expect(allowed.status).toBe(200)
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173')
    expect(allowed.headers['cache-control']).toBe('no-store')
  })
  test('preflights are narrowly allowed without treating CORS as authentication', async () => {
    const { server } = await fixture()
    const preflight = await raw(server.endpoint, path, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, content-type',
      },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers['access-control-allow-headers']).toBe('Authorization, Content-Type')
    expect(
      (
        await raw(server.endpoint, path, {
          method: 'POST',
          headers: { Origin: 'http://localhost:5173' },
        })
      ).status,
    ).toBe(401)
    expect(
      (
        await raw(server.endpoint, path, {
          method: 'OPTIONS',
          headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'DELETE' },
        })
      ).status,
    ).toBe(403)
  })
  test('validates payloads, rejects query credentials, and isolates the configured project', async () => {
    const { server, store } = await fixture()
    const headers = { ...authorization, 'Content-Type': 'application/json' }
    expect(
      (await raw(server.endpoint, path + '?token=do-not-use-query-secrets', { headers })).status,
    ).toBe(400)
    expect(
      (await raw(server.endpoint, path.replace('test-project', 'other-project'), { headers }))
        .status,
    ).toBe(404)
    expect(
      (await raw(server.endpoint, path, { method: 'POST', headers, body: '{bad json' })).status,
    ).toBe(400)
    expect(
      (
        await raw(server.endpoint, path, {
          method: 'POST',
          headers,
          body: JSON.stringify({ version: 1, requestId: '../../escape', annotations: [] }),
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await raw(server.endpoint, path, {
          method: 'POST',
          headers: authorization,
          body: JSON.stringify(submission()),
        })
      ).status,
    ).toBe(415)
    expect(
      (
        await raw(server.endpoint, path, {
          method: 'POST',
          headers,
          body: JSON.stringify(submission()),
        })
      ).status,
    ).toBe(200)
    expect(await store.list()).toHaveLength(1)
    expect(
      (
        await raw(server.endpoint, path.replace('/requests', '/events?after=not-a-number'), {
          headers,
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await raw(server.endpoint, path.replace('/requests', '/events?after=0&after=1'), {
          headers,
        })
      ).status,
    ).toBe(400)
  })
  test('enforces declared and streamed body limits without committing oversized feedback', async () => {
    const { server, store } = await fixture(100)
    const response = await raw(server.endpoint, path, {
      method: 'POST',
      headers: { ...authorization, 'Content-Type': 'application/json' },
      body: 'x'.repeat(101),
    })
    expect(response.status).toBe(413)
    const streamed = await raw(server.endpoint, path, {
      method: 'POST',
      headers: {
        ...authorization,
        'Content-Type': 'application/json',
        'Transfer-Encoding': 'chunked',
      },
      body: 'x'.repeat(101),
    })
    expect(streamed.status).toBe(413)
    expect(await store.list()).toHaveLength(0)
  })
})
