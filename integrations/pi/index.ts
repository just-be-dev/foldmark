import { resolve } from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { createFeedbackClient } from '../../src/transport'
import { FeedbackBridge } from './bridge'

const statusKey = 'foldmark'
export type FoldmarkPiAPI = Pick<
  ExtensionAPI,
  'on' | 'registerFlag' | 'getFlag' | 'registerCommand' | 'sendUserMessage'
>

/** Optional host adapter. Loading the extension alone never starts networking or an agent turn. */
export default function foldmarkExtension(pi: FoldmarkPiAPI): void {
  let bridge: FeedbackBridge | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let context: ExtensionContext | undefined
  let ownedRunContext: ExtensionContext | undefined
  const configuredWorkspace = resolve(process.env.FOLDMARK_WORKSPACE ?? process.cwd())

  const announce = (message: string, level: 'info' | 'warning' | 'error') => {
    if (context?.hasUI) {
      context.ui.setStatus(statusKey, message)
      context.ui.notify(message, level)
    } else {
      // Never write credentials, requests, or server errors into logs.
      process.stderr.write(`${message}\n`)
    }
  }
  const stop = () => {
    clearTimeout(timer)
    timer = undefined
    const previous = bridge
    bridge = null
    previous?.dispose()
    ownedRunContext = undefined
    context?.ui.setStatus(statusKey, undefined)
  }
  const schedule = (watcher: FeedbackBridge, delay = 0) => {
    if (bridge !== watcher || watcher.isClosed) return
    timer = setTimeout(() => {
      timer = undefined
      if (bridge !== watcher) return
      void watcher.tick().then((nextDelay) => schedule(watcher, nextDelay))
    }, delay)
    timer.unref?.()
  }
  const enable = (ctx: ExtensionContext): boolean => {
    if (bridge) return true
    context = ctx
    if (resolve(ctx.cwd) !== configuredWorkspace) {
      announce(
        'Foldmark workspace does not match FOLDMARK_WORKSPACE. Watcher remains disabled.',
        'error',
      )
      return false
    }
    const {
      FOLDMARK_ENDPOINT: endpoint,
      FOLDMARK_TOKEN: token,
      FOLDMARK_PROJECT_ID: projectId,
    } = process.env
    if (!endpoint || !token || !projectId) {
      announce(
        'Set FOLDMARK_ENDPOINT, FOLDMARK_TOKEN, and FOLDMARK_PROJECT_ID before enabling Foldmark.',
        'error',
      )
      return false
    }
    try {
      const client = createFeedbackClient({ endpoint, token, projectId, timeoutMs: 10_000 })
      const watcher = new FeedbackBridge(
        client,
        {
          isIdle: () => context?.isIdle() ?? false,
          hasPendingMessages: () => context?.hasPendingMessages() ?? true,
          start: (prompt, images) => {
            // No deliverAs: an unexpected busy session must reject rather than steer or queue.
            pi.sendUserMessage(
              images.length
                ? [
                    { type: 'text', text: prompt },
                    ...images.map((image) => ({
                      type: 'image' as const,
                      data: image.data,
                      mimeType: image.mimeType,
                    })),
                  ]
                : prompt,
              { expandPromptTemplates: false },
            )
          },
          abort: () => ownedRunContext?.abort(),
          notify: announce,
        },
        { projectId },
      )
      bridge = watcher
      schedule(watcher)
      announce(
        'Foldmark enabled for this session. Explicitly sent feedback may start agent turns.',
        'info',
      )
      return true
    } catch {
      announce('Invalid Foldmark pairing configuration. Watcher remains disabled.', 'error')
      return false
    }
  }

  pi.registerFlag('foldmark-enable', {
    type: 'boolean',
    default: false,
    description: 'Explicitly allow submitted Foldmark requests to start Pi turns for this session.',
  })
  pi.registerCommand('foldmark', {
    description: 'Enable, disable, or inspect the opt-in Foldmark feedback watcher.',
    handler: async (args, ctx) => {
      context = ctx
      switch (args.trim()) {
        case 'enable': {
          if (bridge) {
            announce('Foldmark is already enabled for this session.', 'info')
            return
          }
          if (!ctx.hasUI) {
            announce(
              'Enabling without a confirmation UI requires the explicit --foldmark-enable startup flag.',
              'warning',
            )
            return
          }
          const approved = await ctx.ui.confirm(
            'Allow Foldmark to start agent turns?',
            `Explicitly sent feedback for project ${process.env.FOLDMARK_PROJECT_ID ?? '(not configured)'} may run in ${ctx.cwd}, using this session’s normal tools and permissions. Existing pending requests are included. Up to 20 requests are processed per enable.`,
          )
          if (approved) enable(ctx)
          return
        }
        case 'disable':
          stop()
          announce(
            'Foldmark disabled. Unfinished requests remain claimed until their lease expires.',
            'info',
          )
          return
        case 'status':
        case '':
          announce(
            bridge
              ? `Foldmark enabled${bridge.currentRequestId ? `; request ${bridge.currentRequestId}` : '; waiting for explicitly sent feedback'}.`
              : 'Foldmark disabled. Use /foldmark enable after configuring pairing.',
            'info',
          )
          return
        default:
          announce('Usage: /foldmark enable | disable | status', 'warning')
      }
    },
  })

  pi.on('session_start', async (_event, ctx) => {
    stop()
    context = ctx
    if (pi.getFlag('foldmark-enable') === true) enable(ctx)
  })
  pi.on('session_shutdown', () => stop())
  pi.on('session_before_switch', () => stop())
  pi.on('session_before_fork', () => stop())
  pi.on('session_before_tree', () => stop())
  pi.on('input', (event) => {
    bridge?.input(event.text)
  })
  pi.on('before_agent_start', (event, ctx) => {
    context = ctx
    bridge?.beforeStart(event.prompt)
    if (!bridge?.ownsCurrentRun) ownedRunContext = undefined
  })
  pi.on('agent_start', (_event, ctx) => {
    context = ctx
    ownedRunContext = bridge?.ownsCurrentRun ? ctx : undefined
  })
  pi.on('message_end', (event) => {
    if (event.message.role !== 'assistant') return
    const text = event.message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    bridge?.assistantMessage(event.message.stopReason, text)
  })
  pi.on('agent_before_settle', (event) => {
    bridge?.beforeSettle(event.outcome)
  })
  pi.on('agent_settled', async (event, ctx) => {
    context = ctx
    const watcher = bridge
    await watcher?.settled(event.aborted)
    ownedRunContext = undefined
  })
}
