import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { FeedbackId } from '../src/feedback'

export interface FeedbackServerConfig {
  projectId: string
  dataDir: string
  host: '127.0.0.1' | '::1'
  port: number
  allowedOrigins: readonly string[]
  mcp: boolean
}
export const feedbackHelp = `Foldmark local feedback companion

Usage: foldmark-server [--mcp] [--project ID] [--port PORT]
                       [--data-dir DIRECTORY] [--origin EXACT_ORIGIN]...
                       [--host 127.0.0.1|::1]

Without --mcp, run HTTP ingestion for the Pi integration or direct HTTP clients.
With --mcp, the same process also serves MCP over stdin/stdout. Do not run a
second process against the same data directory. All logs go to stderr.

Environment: FOLDMARK_PROJECT, FOLDMARK_DATA_DIR, FOLDMARK_PORT,
             FOLDMARK_HOST, FOLDMARK_ORIGINS (comma-separated exact origins).
Defaults: project = hash of working directory; port = 5177;
          host = 127.0.0.1; origin = http://localhost:5173.
The private pairing-token file is printed by path only, never by value.
`

/** Environment reads go through Effect Config; CLI flags are explicit overrides. */
export const readFeedbackServerConfig = Effect.fn('Foldmark.Feedback.config')(function* (
  args: readonly string[],
  cwd = process.cwd(),
) {
  const flags = new Map<string, string>()
  const origins: string[] = []
  let mcp = false
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (flag === '--mcp') {
      mcp = true
      continue
    }
    if (!flag || !['--project', '--data-dir', '--port', '--host', '--origin'].includes(flag))
      throw new Error('Unknown feedback server argument. Use --help.')
    const value = args[++index]
    if (!value || value.startsWith('--')) throw new Error('Missing feedback server argument value.')
    if (flag === '--origin') origins.push(value)
    else {
      if (flags.has(flag)) throw new Error('Feedback server argument was supplied more than once.')
      flags.set(flag, value)
    }
  }
  const defaultProject = createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 24)
  const projectId = yield* Schema.decodeEffect(FeedbackId)(
    flags.get('--project') ??
      (yield* Config.String('FOLDMARK_PROJECT').pipe(Config.withDefault(defaultProject))),
  )
  const dataDir = resolve(
    flags.get('--data-dir') ??
      (yield* Config.String('FOLDMARK_DATA_DIR').pipe(
        Config.withDefault(join(homedir(), '.local', 'share', 'foldmark', projectId)),
      )),
  )
  const portValue =
    flags.get('--port') ?? String(yield* Config.Int('FOLDMARK_PORT').pipe(Config.withDefault(5177)))
  const port = Number(portValue)
  if (!/^\d+$/.test(portValue) || !Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error('Feedback port must be an integer between 1 and 65535.')
  const host =
    flags.get('--host') ??
    (yield* Config.String('FOLDMARK_HOST').pipe(Config.withDefault('127.0.0.1')))
  if (host !== '127.0.0.1' && host !== '::1') throw new Error('Feedback host must be loopback.')
  const allowedOrigins = origins.length
    ? origins
    : (yield* Config.String('FOLDMARK_ORIGINS').pipe(Config.withDefault('http://localhost:5173')))
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
  return { projectId, dataDir, port, host, allowedOrigins, mcp } satisfies FeedbackServerConfig
})
