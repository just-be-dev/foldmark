import type { HtmlBuilder, Attribute } from 'foldkit/html'
import type { Target } from './model'

export interface SourceContext {
  source?: string
  modelPath?: string
  message?: string
}

/** Explicit metadata stays searchable in source and survives minified builds. */
export function annotate<Message>(
  h: HtmlBuilder<Message>,
  context: SourceContext,
): Attribute<Message>[] {
  const attrs: Attribute<Message>[] = []
  if (context.source) attrs.push(h.DataAttribute('foldmark-source', context.source))
  if (context.modelPath) attrs.push(h.DataAttribute('foldmark-model', context.modelPath))
  if (context.message) attrs.push(h.DataAttribute('foldmark-message', context.message))
  return attrs
}

export const pageKey = (location: Location) =>
  `${location.origin}${location.pathname}${location.hash}`
const escaped = (value: string) => CSS.escape(value)
const unique = (element: Element, selector: string) => {
  const matches = element.ownerDocument.querySelectorAll(selector)
  return matches.length === 1 && matches[0] === element
}

/** Always verifies uniqueness, including duplicate IDs and test attributes. */
export function selectorFor(element: Element): string {
  if (element.id && unique(element, `#${escaped(element.id)}`)) return `#${escaped(element.id)}`
  for (const attr of ['data-testid', 'data-test', 'data-foldmark-id']) {
    const value = element.getAttribute(attr)
    if (value) {
      const selector = `[${attr}="${escaped(value)}"]`
      if (unique(element, selector)) return selector
    }
  }
  const parts: string[] = []
  let current: Element | null = element
  while (current) {
    let part = current.localName
    const classes = [...current.classList]
      .filter((name) => !/^(active|hover|focus|selected)$/.test(name))
      .slice(0, 2)
    if (classes.length) part += classes.map((name) => `.${escaped(name)}`).join('')
    const parent: Element | null = current.parentElement
    if (parent && [...parent.children].filter((child) => child.matches(part)).length > 1) {
      part += `:nth-child(${[...parent.children].indexOf(current) + 1})`
    }
    parts.unshift(part)
    if (unique(element, parts.join(' > '))) return parts.join(' > ')
    current = parent
  }
  return parts.join(' > ')
}

export function capture(element: Element, context?: (element: Element) => SourceContext): Target {
  const doc = element.ownerDocument
  const win = doc.defaultView
  if (!win) throw new Error('Cannot inspect an element without a window')
  const rect = element.getBoundingClientRect()
  const style = win.getComputedStyle(element)
  const metadata = context?.(element) ?? {}
  const attribute = (name: string) =>
    element.closest(`[data-foldmark-${name}]`)?.getAttribute(`data-foldmark-${name}`) ?? ''
  const selection = win.getSelection()
  const privateElement = element.closest(
    '[data-foldmark-private], input, textarea, select, [contenteditable="true"]',
  )
  // Never collect form values, markup, or text in explicitly private regions.
  const text = privateElement ? '' : safeText(element).replace(/\s+/g, ' ').trim().slice(0, 300)
  const selectionIncludesPrivate =
    selection &&
    selection.rangeCount > 0 &&
    [
      ...element.querySelectorAll(
        '[data-foldmark-private], input, textarea, select, [contenteditable="true"]',
      ),
    ].some((node) => selection.getRangeAt(0).intersectsNode(node))
  const selectedText =
    !privateElement &&
    !selectionIncludesPrivate &&
    selection?.anchorNode &&
    selection.focusNode &&
    element.contains(selection.anchorNode) &&
    element.contains(selection.focusNode)
      ? selection.toString().slice(0, 500)
      : ''
  return {
    selector: selectorFor(element),
    tag: element.localName,
    text,
    selectedText,
    source: metadata.source ?? attribute('source'),
    modelPath: metadata.modelPath ?? attribute('model'),
    message: metadata.message ?? attribute('message'),
    rect: {
      x: Math.round(rect.x + win.scrollX),
      y: Math.round(rect.y + win.scrollY),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    font: `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
    color: style.color,
    background: style.backgroundColor,
    page: pageKey(win.location),
    title: doc.title,
    viewport: `${win.innerWidth}×${win.innerHeight}`,
  }
}

function safeText(element: Element): string {
  if (
    element.matches(
      '[data-foldmark-private], input, textarea, select, script, style, [contenteditable="true"]',
    )
  )
    return ''
  return [...element.childNodes]
    .map((node) =>
      node.nodeType === 3
        ? (node.textContent ?? '')
        : node instanceof Element
          ? safeText(node)
          : '',
    )
    .join(' ')
}
