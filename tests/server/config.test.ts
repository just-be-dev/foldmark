import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import { describe, expect, test } from 'vitest'
import { readFeedbackServerConfig } from '../../server/config'

const read = (args: readonly string[], environment: Record<string, unknown> = {}) =>
  Effect.runPromise(
    readFeedbackServerConfig(args, '/test/workspace').pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(environment)),
    ),
  )

describe('local companion configuration', () => {
  test('stable local-first defaults and explicit flags override environment values', async () => {
    const defaults = await read([])
    expect(defaults.host).toBe('127.0.0.1')
    expect(defaults.port).toBe(5177)
    expect(defaults.projectId).toMatch(/^[a-f0-9]{24}$/)
    expect(defaults.projectId).toBe((await read([])).projectId)
    expect(defaults.allowedOrigins).toEqual(['http://localhost:5173'])
    const explicit = await read(
      [
        '--mcp',
        '--project',
        'chosen-app',
        '--port',
        '5199',
        '--origin',
        'http://localhost:5180',
        '--origin',
        'http://127.0.0.1:5180',
      ],
      {
        FOLDMARK_PROJECT: 'environment-app',
        FOLDMARK_PORT: '5188',
        FOLDMARK_ORIGINS: 'http://localhost:1234',
      },
    )
    expect(explicit).toMatchObject({
      projectId: 'chosen-app',
      port: 5199,
      mcp: true,
      allowedOrigins: ['http://localhost:5180', 'http://127.0.0.1:5180'],
    })
  })
  test('rejects non-loopback binds and ambiguous or invalid flags', async () => {
    await expect(read(['--host', '0.0.0.0'])).rejects.toThrow('loopback')
    await expect(read(['--project', '../../escape'])).rejects.toBeDefined()
    await expect(read(['--port', '5177', '--port', '5178'])).rejects.toThrow('more than once')
    await expect(read(['--port', '0'])).rejects.toThrow('65535')
    await expect(read(['--unknown'])).rejects.toThrow('Unknown')
  })
})
