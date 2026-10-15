import type { HtmlBuilder, Attribute } from 'foldkit/html'
import type { Rect, Target, TargetBoundary } from './model'

export interface SourceContext {
  source?: string
  modelPath?: string
  message?: string
}
export type InspectionRoot = Document | ShadowRoot
const privateSelector =
  '[data-foldmark-private], input, textarea, select, [contenteditable]:not([contenteditable="false"])'
export const isElement = (node: unknown): node is Element =>
  typeof node === 'object' && node !== null && 'nodeType' in node && node.nodeType === 1
const isFrame = (element: Element): element is HTMLIFrameElement =>
  element.localName === 'iframe' && 'contentDocument' in element
const isShadow = (root: Node): root is ShadowRoot => root.nodeType === 11 && 'host' in root

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
const localRoot = (element: Element): InspectionRoot => {
  const root = element.getRootNode()
  return isShadow(root) ? root : element.ownerDocument
}
const unique = (element: Element, selector: string) => {
  const matches = localRoot(element).querySelectorAll(selector)
  return matches.length === 1 && matches[0] === element
}

/** Always verifies uniqueness within the element's document or shadow root. */
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
    const siblings = parent ? [...parent.children] : [...localRoot(current).children]
    if (siblings.filter((child) => child.matches(part)).length > 1) {
      part += `:nth-child(${siblings.indexOf(current) + 1})`
    }
    parts.unshift(part)
    if (unique(element, parts.join(' > '))) return parts.join(' > ')
    current = parent
  }
  return parts.join(' > ')
}

/** Walks through open shadow hosts and accessible frame owners, never into an opaque root. */
export function composedParent(element: Element): Element | null {
  if (element.parentElement) return element.parentElement
  const root = element.getRootNode()
  if (isShadow(root)) return root.host
  try {
    return element.ownerDocument.defaultView?.frameElement ?? null
  } catch {
    return null
  }
}
export function composedClosest(element: Element, selector: string): Element | null {
  let current: Element | null = element
  while (current) {
    if (current.matches(selector)) return current
    current = composedParent(current)
  }
  return null
}
export const isPrivateElement = (element: Element) => !!composedClosest(element, privateSelector)
export const isIgnoredElement = (element: Element) =>
  !!composedClosest(element, '[data-foldmark-ignore], [data-foldmark-root]')

/** Each segment is a verified local CSS selector plus the kind of root to open. */
export function pathFor(element: Element, topDocument: Document = document): TargetBoundary[] {
  const root = element.getRootNode()
  if (isShadow(root))
    return [
      ...pathFor(root.host, topDocument),
      { kind: 'shadow', selector: selectorFor(root.host) },
    ]
  if (element.ownerDocument === topDocument) return []
  try {
    const frame = element.ownerDocument.defaultView?.frameElement
    return frame
      ? [...pathFor(frame, topDocument), { kind: 'frame', selector: selectorFor(frame) }]
      : []
  } catch {
    return []
  }
}
export function resolveTarget(target: Target, topDocument: Document = document): Element | null {
  if (target.kind === 'area') return null
  let root: InspectionRoot = topDocument
  try {
    for (const boundary of target.path ?? []) {
      const element: Element | null = root.querySelector(boundary.selector)
      if (!element) return null
      if (boundary.kind === 'shadow') {
        if (!element.shadowRoot) return null
        root = element.shadowRoot
      } else {
        if (!isFrame(element) || !element.contentDocument) return null
        root = element.contentDocument
      }
    }
    if (target.framePage) {
      const currentDocument = root.nodeType === 9 ? (root as Document) : root.ownerDocument
      const currentWindow = currentDocument?.defaultView
      if (!currentWindow || pageKey(currentWindow.location) !== target.framePage) return null
    }
    return root.querySelector(target.selector)
  } catch {
    // Saved selectors can become invalid or a formerly same-origin frame can navigate away.
    return null
  }
}

/** AABB in the mounting document's viewport, including frame borders and CSS scaling. */
export function viewportRect(element: Element, topDocument: Document = document): Rect {
  const box = element.getBoundingClientRect()
  let result = { x: box.x, y: box.y, width: box.width, height: box.height }
  let doc = element.ownerDocument
  while (doc !== topDocument) {
    const frame = doc.defaultView?.frameElement
    if (!frame || !('offsetWidth' in frame) || !('offsetHeight' in frame)) break
    const outer = frame.getBoundingClientRect()
    const width = typeof frame.offsetWidth === 'number' ? frame.offsetWidth : outer.width
    const height = typeof frame.offsetHeight === 'number' ? frame.offsetHeight : outer.height
    const scaleX = width ? outer.width / width : 1
    const scaleY = height ? outer.height / height : 1
    result = {
      x: outer.x + (frame.clientLeft + result.x) * scaleX,
      y: outer.y + (frame.clientTop + result.y) * scaleY,
      width: result.width * scaleX,
      height: result.height * scaleY,
    }
    doc = frame.ownerDocument
  }
  return result
}
export function documentRect(element: Element, topDocument: Document = document): Rect {
  const rect = viewportRect(element, topDocument)
  const win = topDocument.defaultView
  return {
    x: Math.round((rect.x + (win?.scrollX ?? 0)) * 100) / 100,
    y: Math.round((rect.y + (win?.scrollY ?? 0)) * 100) / 100,
    width: Math.round(rect.width * 100) / 100,
    height: Math.round(rect.height * 100) / 100,
  }
}
export function unionRects(rects: readonly Rect[]): Rect | null {
  const first = rects[0]
  if (!first) return null
  const x = Math.min(...rects.map((r) => r.x))
  const y = Math.min(...rects.map((r) => r.y))
  return {
    x,
    y,
    width: Math.max(...rects.map((r) => r.x + r.width)) - x,
    height: Math.max(...rects.map((r) => r.y + r.height)) - y,
  }
}

/** Discover rather than patch host attachShadow/history APIs. Closed and cross-origin roots stay opaque. */
export function inspectionRoots(
  topDocument: Document = document,
  includeIgnored = false,
): InspectionRoot[] {
  const roots: InspectionRoot[] = []
  const visit = (root: InspectionRoot, depth: number) => {
    if (depth > 24 || roots.includes(root) || roots.length >= 200) return
    roots.push(root)
    for (const element of root.querySelectorAll('*')) {
      if (composedClosest(element, '[data-foldmark-root]')) continue
      if (!includeIgnored && isIgnoredElement(element)) continue
      if (element.shadowRoot) visit(element.shadowRoot, depth + 1)
      if (isFrame(element)) {
        try {
          if (element.contentDocument) visit(element.contentDocument, depth + 1)
        } catch {
          // The frame element is inspectable, but its inaccessible contents are not.
        }
      }
    }
  }
  visit(topDocument, 0)
  return roots
}

export function capture(
  element: Element,
  context?: (element: Element) => SourceContext,
  topDocument: Document = document,
): Target {
  const doc = element.ownerDocument
  const win = doc.defaultView
  const topWindow = topDocument.defaultView
  if (!win || !topWindow) throw new Error('Cannot inspect an element without a window')
  const style = win.getComputedStyle(element)
  const metadata = context?.(element) ?? {}
  const attribute = (name: string) =>
    composedClosest(element, `[data-foldmark-${name}]`)?.getAttribute(`data-foldmark-${name}`) ?? ''
  const selection = win.getSelection()
  const privateElement = isPrivateElement(element)
  const text = privateElement ? '' : safeText(element).replace(/\s+/g, ' ').trim().slice(0, 300)
  const selectionIncludesPrivate =
    selection &&
    selection.rangeCount > 0 &&
    [...element.querySelectorAll(privateSelector)].some((node) => {
      try {
        return selection.getRangeAt(0).intersectsNode(node)
      } catch {
        return true
      }
    })
  const selectedText =
    !privateElement &&
    !selectionIncludesPrivate &&
    selection?.anchorNode &&
    selection.focusNode &&
    element.contains(selection.anchorNode) &&
    element.contains(selection.focusNode)
      ? selection.toString().slice(0, 500)
      : ''
  const path = pathFor(element, topDocument)
  return {
    selector: selectorFor(element),
    tag: element.localName,
    text,
    selectedText,
    source: metadata.source ?? attribute('source'),
    modelPath: metadata.modelPath ?? attribute('model'),
    message: metadata.message ?? attribute('message'),
    rect: documentRect(element, topDocument),
    font: `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
    color: style.color,
    background: style.backgroundColor,
    page: pageKey(topWindow.location),
    title: topDocument.title,
    viewport: `${topWindow.innerWidth}×${topWindow.innerHeight}`,
    ...(path.length ? { path } : {}),
    ...(doc !== topDocument ? { framePage: pageKey(win.location) } : {}),
  }
}
export function captureArea(rect: Rect, topDocument: Document = document): Target {
  const win = topDocument.defaultView
  if (!win) throw new Error('Cannot inspect an area without a window')
  return {
    selector: `@area(${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)})`,
    kind: 'area',
    tag: 'area',
    text: '',
    selectedText: '',
    source: '',
    modelPath: '',
    message: '',
    rect,
    font: '',
    color: '',
    background: '',
    page: pageKey(win.location),
    title: topDocument.title,
    viewport: `${win.innerWidth}×${win.innerHeight}`,
  }
}

function safeText(element: Element): string {
  if (element.matches(`${privateSelector},script,style`)) return ''
  return [...element.childNodes]
    .map((node) =>
      node.nodeType === 3 ? (node.textContent ?? '') : isElement(node) ? safeText(node) : '',
    )
    .join(' ')
}
/** Screenshot masks include all form controls and opaque embedded documents. */
export function privateRects(topDocument: Document = document): Rect[] {
  const rects: Rect[] = []
  for (const root of inspectionRoots(topDocument, true)) {
    for (const element of root.querySelectorAll('*')) {
      if (composedClosest(element, '[data-foldmark-root]')) continue
      // Ignored is a selection rule, never a privacy exemption. Include descendants too: a
      // display:contents or overflowing private/ignored host can have no useful box of its own.
      if (
        element.localName === 'iframe' ||
        isPrivateElement(element) ||
        composedClosest(element, '[data-foldmark-ignore]')
      ) {
        const rect = documentRect(element, topDocument)
        if (rect.width > 0 && rect.height > 0) rects.push(rect)
      }
    }
  }
  return rects
}
