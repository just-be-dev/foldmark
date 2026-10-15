import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  atomicWrite,
  createFeedbackStore,
  loadPairingToken,
  type FeedbackStore,
} from '../../server/store'
import { annotation, deferred, submission } from './fixtures'

const stores: FeedbackStore[] = []
const directories: string[] = []
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'foldmark-store-'))
  directories.push(dir)
  return dir
}
async function store(options: Partial<Parameters<typeof createFeedbackStore>[0]> = {}) {
  const value = await createFeedbackStore({
    dataDir: await directory(),
    projectId: 'test-project',
    ...options,
  })
  stores.push(value)
  return value
}
afterEach(async () => {
  await Promise.all(stores.splice(0).map((value) => value.close()))
  await Promise.all(
    directories.splice(0).map((value) => rm(value, { recursive: true, force: true })),
  )
})

describe('durable feedback queue', () => {
  test('deduplicates concurrent submissions, persists before publishing, and reopens without losing cursor', async () => {
    const dataDir = await directory()
    const entered = deferred()
    const release = deferred()
    const value = await store({
      dataDir,
      persist: async (path, content) => {
        entered.resolve()
        await release.promise
        await atomicWrite(path, content)
      },
    })
    const events: number[] = []
    value.subscribe((event) => {
      events.push(event.cursor)
    })
    const first = value.submit(submission())
    await entered.promise
    const second = value.submit(submission())
    expect(events).toEqual([])
    release.resolve()
    expect(await first).toEqual(await second)
    expect(events).toEqual([1])
    expect((await value.events()).cursor).toBe(1)
    const snapshot = JSON.parse(await readFile(join(dataDir, 'requests.json'), 'utf8'))
    expect(snapshot.requests).toHaveLength(1)
    await value.close()
    const reopened = await store({ dataDir })
    expect((await reopened.get('request-one')).annotations[0]?.note).toContain('space')
    expect((await reopened.events()).cursor).toBe(1)
    await expect(
      reopened.submit({ ...submission(), annotations: [{ ...annotation, note: 'Different' }] }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })
  test('failed persistence leaves the snapshot, event cursor, and observers unchanged', async () => {
    let failWrites = false
    const value = await store({
      persist: (path, content) =>
        failWrites ? Promise.reject(new Error('disk full')) : atomicWrite(path, content),
    })
    const events: number[] = []
    value.subscribe((event) => {
      events.push(event.cursor)
    })
    await value.submit(submission())
    failWrites = true
    await expect(value.claim('request-one', { owner: 'agent-a' })).rejects.toMatchObject({
      code: 'storage',
      status: 503,
    })
    expect((await value.get('request-one')).status).toBe('pending')
    expect(events).toEqual([1])
    expect((await value.events()).cursor).toBe(1)
    failWrites = false
    expect((await value.claim('request-one', { owner: 'agent-b' })).request.status).toBe('claimed')
  })
  test('post-rename directory-sync failure reports uncertain durability instead of pretending rollback', async () => {
    const dataDir = await directory()
    const value = await store({
      dataDir,
      persist: (path, content) =>
        atomicWrite(path, content, {
          syncDirectory: async () => {
            throw new Error('directory fsync failed')
          },
        }),
    })
    const events: number[] = []
    value.subscribe((event) => {
      events.push(event.cursor)
    })
    await expect(value.submit(submission())).rejects.toMatchObject({
      code: 'durability',
      status: 503,
    })
    expect(
      JSON.parse(await readFile(join(dataDir, 'requests.json'), 'utf8')).requests[0].request.id,
    ).toBe('request-one')
    expect(events).toEqual([])
    await expect(value.list()).rejects.toMatchObject({ code: 'durability' })
    await expect(value.submit(submission('cannot-continue'))).rejects.toMatchObject({
      code: 'durability',
    })
    await value.close()
    const restarted = await store({ dataDir })
    expect((await restarted.submit(submission())).id).toBe('request-one')
    expect((await restarted.events()).cursor).toBe(1)
    expect(await restarted.list()).toHaveLength(1)
  })
  test('nearest-expiry scheduling is renewed, makes durable pending events, and is disposed on close', async () => {
    let clock = 1_000_000
    let nextId = 0
    const scheduled = new Map<number, { at: number; callback: () => void }>()
    const value = await store({
      now: () => clock,
      schedule: (callback, delay) => {
        const id = ++nextId
        scheduled.set(id, { at: clock + delay, callback })
        return () => {
          scheduled.delete(id)
        }
      },
    })
    await value.submit(submission())
    const first = await value.claim('request-one', { owner: 'agent-a', leaseMs: 15_000 })
    expect([...scheduled.values()].map((timer) => timer.at)).toEqual([clock + 15_000])
    clock += 5_000
    await value.claim('request-one', {
      owner: 'agent-a',
      claimToken: first.claimToken,
      leaseMs: 20_000,
    })
    expect([...scheduled.values()].map((timer) => timer.at)).toEqual([clock + 20_000])
    clock += 20_000
    const timer = [...scheduled.entries()][0]
    if (!timer) throw new Error('Expected owned expiry timer')
    scheduled.delete(timer[0])
    timer[1].callback()
    const request = await value.get('request-one') // Serialized after the timer's committed transition.
    expect(request).toMatchObject({ status: 'pending', claim: null, revision: 4 })
    expect((await value.events()).events.at(-1)).toMatchObject({
      status: 'pending',
      cause: 'lease_expired',
    })
    expect(scheduled.size).toBe(0)
    const next = await value.claim('request-one', { owner: 'agent-b' })
    expect(scheduled.size).toBe(1)
    await value.complete('request-one', { claimToken: next.claimToken, status: 'completed' })
    expect(scheduled.size).toBe(0)
    await value.submit(submission('another-request'))
    await value.claim('another-request', { owner: 'agent-c' })
    expect(scheduled.size).toBe(1)
    await value.close()
    expect(scheduled.size).toBe(0)
  })
  test('serializes competing agents; renewals need the private credential; expired work is reclaimable', async () => {
    let clock = 1_000_000
    const value = await store({ now: () => clock })
    await value.submit(submission())
    const claims = await Promise.allSettled([
      value.claim('request-one', { owner: 'agent-a', leaseMs: 15_000 }),
      value.claim('request-one', { owner: 'agent-b', leaseMs: 15_000 }),
    ])
    expect(claims.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const first = claims[0]
    if (first?.status !== 'fulfilled') throw new Error('First queued claim should win')
    expect(JSON.stringify(await value.get('request-one'))).not.toContain(first.value.claimToken)
    await expect(value.claim('request-one', { owner: 'agent-a' })).rejects.toMatchObject({
      code: 'claimed',
      status: 409,
    })
    await expect(
      value.complete('request-one', { claimToken: 'x'.repeat(43), status: 'completed' }),
    ).rejects.toMatchObject({ code: 'claim_token', status: 403 })
    clock += 5_000
    const renewed = await value.claim('request-one', {
      owner: 'agent-a',
      claimToken: first.value.claimToken,
      leaseMs: 15_000,
    })
    expect(renewed.claimToken).toBe(first.value.claimToken)
    clock += 15_000
    await expect(
      value.complete('request-one', { claimToken: first.value.claimToken, status: 'completed' }),
    ).rejects.toMatchObject({ code: 'lease_expired' })
    await expect(
      value.claim('request-one', { owner: 'agent-a', claimToken: first.value.claimToken }),
    ).rejects.toMatchObject({ code: 'lease_expired' })
    const second = await value.claim('request-one', { owner: 'agent-b' })
    expect(second.claimToken).not.toBe(first.value.claimToken)
    const completed = await value.complete('request-one', {
      claimToken: second.claimToken,
      status: 'completed',
      message: 'Verified spacing adjustment.',
    })
    expect(completed.status).toBe('completed')
    expect(completed.claim).toBeNull()
    expect(
      (
        await value.complete('request-one', {
          claimToken: second.claimToken,
          status: 'completed',
          message: 'Verified spacing adjustment.',
        })
      ).revision,
    ).toBe(completed.revision)
    await expect(
      value.complete('request-one', { claimToken: second.claimToken, status: 'failed' }),
    ).rejects.toMatchObject({ code: 'finished' })
  })
  test('leases and ownership survive server restarts', async () => {
    const dataDir = await directory()
    const value = await store({ dataDir })
    await value.submit(submission())
    const claim = await value.claim('request-one', { owner: 'agent-a' })
    await value.close()
    const restarted = await store({ dataDir })
    await expect(restarted.claim('request-one', { owner: 'agent-b' })).rejects.toMatchObject({
      code: 'claimed',
    })
    expect(
      (
        await restarted.complete('request-one', {
          claimToken: claim.claimToken,
          status: 'failed',
          message: 'Checks failed.',
        })
      ).status,
    ).toBe('failed')
  })
  test('project directory ownership and exclusive writers prevent accidental cross-project access', async () => {
    const dataDir = await directory()
    const value = await store({ dataDir })
    await value.submit(submission())
    await expect(createFeedbackStore({ dataDir, projectId: 'test-project' })).rejects.toMatchObject(
      { code: 'locked' },
    )
    await value.close()
    await expect(
      createFeedbackStore({ dataDir, projectId: 'another-project' }),
    ).rejects.toMatchObject({ code: 'project' })
  })
  test('bounded event retention reports a cursor reset and does not leak feedback or claim secrets', async () => {
    const value = await store({ maxEvents: 2 })
    await value.submit(submission())
    await value.submit(submission('request-two'))
    await value.submit(submission('request-three'))
    expect(await value.events(0)).toMatchObject({
      cursor: 3,
      reset: true,
      events: [{ cursor: 2 }, { cursor: 3 }],
    })
    expect(await value.events(2)).toMatchObject({
      cursor: 3,
      reset: false,
      events: [{ cursor: 3 }],
    })
    expect((await value.events(99)).reset).toBe(true)
    expect(JSON.stringify(await value.events())).not.toContain('Add more space')
  })
  test('close drains accepted work, rejects new work, and releases the writer once', async () => {
    const entered = deferred()
    const release = deferred()
    const value = await store({
      persist: async (path, content) => {
        entered.resolve()
        await release.promise
        await atomicWrite(path, content)
      },
    })
    const pending = value.submit(submission())
    await entered.promise
    const closing = value.close()
    await expect(value.list()).rejects.toMatchObject({ code: 'closed' })
    release.resolve()
    await pending
    await closing
    await value.close()
  })
  test('a crash lock fails closed until an operator explicitly recovers it', async () => {
    const dataDir = await directory()
    const value = await store({ dataDir })
    await value.submit(submission())
    await value.close()
    await writeFile(join(dataDir, 'instance.lock'), '999999999:crashed-process')
    await expect(createFeedbackStore({ dataDir, projectId: 'test-project' })).rejects.toMatchObject(
      { code: 'locked' },
    )
    expect(await readFile(join(dataDir, 'instance.lock'), 'utf8')).toBe('999999999:crashed-process')
    await rm(join(dataDir, 'instance.lock'))
    const recovered = await store({ dataDir })
    expect((await recovered.get('request-one')).status).toBe('pending')
  })
  test('corrupt state is preserved rather than silently replaced', async () => {
    const dataDir = await directory()
    await writeFile(join(dataDir, 'requests.json'), '{bad json')
    await expect(createFeedbackStore({ dataDir, projectId: 'test-project' })).rejects.toBeDefined()
    expect(await readFile(join(dataDir, 'requests.json'), 'utf8')).toBe('{bad json')
  })
  test('pairing credentials are stable private files, never regenerated on a normal restart', async () => {
    const dataDir = await directory()
    const token = await loadPairingToken(dataDir)
    expect(token).toMatch(/^[a-zA-Z0-9_-]{43}$/)
    expect(await loadPairingToken(dataDir)).toBe(token)
    expect((await stat(join(dataDir, 'pairing-token'))).mode & 0o777).toBe(0o600)
    expect((await stat(dataDir)).mode & 0o777).toBe(0o700)
  })
})
