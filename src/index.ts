import * as Schema from 'effect/Schema'
import { Port, Runtime, Subscription } from 'foldkit'
import { capture, pageKey, type SourceContext } from './capture'
import { Annotation, Message, Model, SavedSession, initialModel } from './model'
import { makeUpdate, ports } from './update'
import { view } from './view'
import { styles } from './styles'

export { annotate, selectorFor } from './capture'
export type { SourceContext } from './capture'
export { Annotation, Target, SavedSession } from './model'
export { toMarkdown, toJson } from './report'

export interface FoldmarkOptions {
  /** Use in development only. Defaults to true; callers decide their environment. */
  enabled?: boolean
  storageKey?: string
  /** Set false to retain notes in memory only. */
  storage?: Storage | false
  /** Explicit source hints, not an automatic capture of application state. */
  context?: (element: Element) => SourceContext
  onChange?: (annotations: readonly Annotation[]) => void
}
export interface FoldmarkHandle {
  dispose: () => void
  getAnnotations: () => readonly Annotation[]
}

/** A separate Foldkit runtime, isolated with Shadow DOM and owned by this handle. */
export function mountFoldmark(options: FoldmarkOptions = {}): FoldmarkHandle {
  if (options.enabled === false || typeof document === 'undefined')
    return { dispose() {}, getAnnotations: () => [] }
  if (document.querySelector('[data-foldmark-root]'))
    throw new Error(
      'Foldmark is already mounted. Dispose the existing handle before mounting again.',
    )
  const host = document.createElement('div')
  host.setAttribute('data-foldmark-root', '')
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = styles
  const container = document.createElement('div')
  container.id = 'foldmark-runtime'
  shadow.append(style, container)
  document.body.append(host)

  const key = options.storageKey ?? 'foldmark:v1'
  let storage: Storage | false = false
  let annotations: readonly Annotation[] = []
  let notice = ''
  try {
    storage = options.storage ?? window.localStorage
    const saved = storage && storage.getItem(key)
    if (saved) annotations = Schema.decodeUnknownSync(SavedSession)(JSON.parse(saved)).annotations
  } catch {
    notice = 'Could not restore saved notes. New notes can still be exported.'
  }
  let state: Model = { ...initialModel(pageKey(location), annotations), notice, scrollX, scrollY }
  let disposed = false
  const { update } = makeUpdate({
    save: (values) => {
      if (storage) storage.setItem(key, JSON.stringify({ version: 1, annotations: values }))
      options.onChange?.(values)
    },
    copy: (text) => navigator.clipboard.writeText(text),
    download: (text, format) => {
      const blob = new Blob([text], {
        type: format === 'json' ? 'application/json' : 'text/markdown',
      })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `foldmark-feedback.${format === 'json' ? 'json' : 'md'}`
      anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    },
  })
  const runtime = Runtime.embed(
    Runtime.makeElement({
      Model,
      init: () => ({ model: state }),
      update,
      view,
      ports,
      container,
      subscriptions: Subscription.make<Model, Message>()(() => ({
        browser: Port.subscription(ports.inbound.event, (event) => event),
      })),
    }),
  )
  const send = (message: Message) => {
    if (!disposed) runtime.ports.event.send(message)
  }
  let resumeAnimations = () => {}
  let previousFocus: Element | null = null
  let focusFrame = 0
  const unsubscribe = runtime.ports.state.subscribe((next) => {
    if (disposed) return
    if (next.paused !== state.paused) {
      resumeAnimations()
      resumeAnimations = next.paused ? pauseAnimations() : () => {}
    }
    if (next.draft && !state.draft) {
      previousFocus = document.activeElement
      focusFrame = requestAnimationFrame(() =>
        shadow.querySelector<HTMLTextAreaElement>('#foldmark-note')?.focus(),
      )
    } else if (!next.draft && state.draft) {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
    state = next
  })
  const controller = new AbortController()
  const ownEvent = (event: Event) => event.composedPath().includes(host)
  const editable = (event: KeyboardEvent) =>
    event
      .composedPath()
      .some(
        (node) =>
          node instanceof Element && node.matches('input,textarea,select,[contenteditable="true"]'),
      )
  const candidate = (event: Event) => {
    if (ownEvent(event) || !state.active || state.draft) return null
    const element = event.target
    if (
      !(element instanceof Element) ||
      element === document.documentElement ||
      element === document.body ||
      element.closest('[data-foldmark-ignore]')
    )
      return null
    return element
  }
  let hovered: Element | null = null
  let hoverFrame = 0
  document.addEventListener(
    'pointermove',
    (event) => {
      const element = candidate(event)
      if (element === hovered) return
      hovered = element
      cancelAnimationFrame(hoverFrame)
      hoverFrame = requestAnimationFrame(() =>
        send(Message.HoveredTarget({ target: element ? capture(element, options.context) : null })),
      )
    },
    { capture: true, signal: controller.signal },
  )
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (candidate(event)) event.stopImmediatePropagation()
    },
    { capture: true, signal: controller.signal },
  )
  document.addEventListener(
    'click',
    (event) => {
      const element = candidate(event)
      if (!element) return
      event.preventDefault()
      event.stopImmediatePropagation()
      send(Message.SelectedTarget({ target: capture(element, options.context) }))
      hovered = null
    },
    { capture: true, signal: controller.signal },
  )
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.altKey && event.shiftKey && event.code === 'KeyA' && !editable(event)) {
        event.preventDefault()
        send(Message.ClickedToggle())
      } else if (
        event.key === 'Escape' &&
        (state.active || state.draft || state.panel !== 'closed')
      ) {
        event.preventDefault()
        event.stopImmediatePropagation()
        send(Message.PressedEscape())
      } else if (
        ownEvent(event) &&
        state.draft &&
        event.key === 'Enter' &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault()
        send(Message.ClickedSave())
      } else if (ownEvent(event) && state.draft && event.key === 'Tab') {
        const inputs = [
          ...shadow.querySelectorAll<HTMLElement>(
            '.composer button:not(:disabled), .composer textarea',
          ),
        ]
        const first = inputs[0]
        const last = inputs.at(-1)
        if (event.shiftKey && shadow.activeElement === first) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && shadow.activeElement === last) {
          event.preventDefault()
          first?.focus()
        }
      }
    },
    { capture: true, signal: controller.signal },
  )
  const scrolled = () => {
    hovered = null
    send(Message.ScrolledPage({ x: window.scrollX, y: window.scrollY }))
  }
  window.addEventListener('scroll', scrolled, { signal: controller.signal, passive: true })
  window.addEventListener('resize', scrolled, { signal: controller.signal, passive: true })
  // Observes SPA pushState without patching host history methods.
  const routeTimer = setInterval(() => {
    const page = pageKey(location)
    if (page !== state.page) send(Message.ChangedPage({ page }))
  }, 200)
  return {
    getAnnotations: () => state.annotations,
    dispose: () => {
      if (disposed) return
      disposed = true
      controller.abort()
      clearInterval(routeTimer)
      cancelAnimationFrame(hoverFrame)
      cancelAnimationFrame(focusFrame)
      resumeAnimations()
      unsubscribe()
      runtime.dispose()
      host.remove()
    },
  }
}

function pauseAnimations(): () => void {
  const animations = document.getAnimations().filter((a) => a.playState === 'running')
  const videos = [...document.querySelectorAll('video')].filter((video) => !video.paused)
  animations.forEach((animation) => animation.pause())
  videos.forEach((video) => video.pause())
  const pauseStyle = document.createElement('style')
  pauseStyle.textContent = 'body * { animation-play-state: paused !important; }'
  document.head.append(pauseStyle)
  return () => {
    pauseStyle.remove()
    animations.forEach((animation) => {
      if (animation.playState === 'paused') animation.play()
    })
    videos.forEach((video) => {
      if (video.isConnected) void video.play().catch(() => {})
    })
  }
}
