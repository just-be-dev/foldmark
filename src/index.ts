import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Port, Runtime, Subscription } from "foldkit";
import {
  capture,
  captureArea,
  documentRect,
  inspectionRoots,
  isElement,
  isIgnoredElement,
  pageKey,
  resolveTarget,
  unionRects,
  viewportRect,
  type InspectionRoot,
  type SourceContext,
} from "./capture";
import { freezeAnimations } from "./animations";
import { Message } from "./message";
import {
  Model,
  SavedSession,
  annotationTargets,
  initialModel,
  openAnnotations,
  type Annotation,
  type FeedbackSummary,
  type Rect,
  type Target,
  type Theme,
} from "./model";
import { makeUpdate, ports } from "./update";
import { view } from "./view";
import { styles } from "./styles";
import { takeScreenshot, type ScreenshotProvider } from "./screenshots";
import { createFeedbackClient, type FeedbackClientOptions } from "./transport";
import type { FeedbackRequest } from "./feedback";

export { annotate, selectorFor, pathFor, resolveTarget } from "./capture";
export type { SourceContext } from "./capture";
export { Annotation, Target, SavedSession, Screenshot, Theme } from "./model";
export { createFeedbackClient, FeedbackTransportError } from "./transport";
export type { FeedbackClientOptions, FeedbackClient } from "./transport";
export { FeedbackRequest, FeedbackSubmission, FeedbackStatus } from "./feedback";
export type { ScreenshotProvider, ScreenshotRequest, ScreenshotImage } from "./screenshots";
export { toMarkdown, toJson } from "./report";

export interface FoldmarkOptions {
  /** Use in development only. Defaults to true; callers decide their environment. */
  enabled?: boolean;
  storageKey?: string;
  /** Set false to retain notes and appearance in memory only. */
  storage?: Storage | false;
  theme?: Theme;
  /** Explicit source hints; never an automatic capture of application state. */
  context?: (element: Element) => SourceContext;
  /** Optional async original-source lookup; receives the captured/instrumented hints. */
  sourceResolver?: (
    element: Element,
    context: SourceContext,
  ) => SourceContext | Promise<SourceContext>;
  /** An explicit screenshot action invokes this provider; output is raster-validated and redacted. */
  screenshotProvider?: ScreenshotProvider;
  /** Pairing config is memory-only. No network I/O occurs until Send to agent is chosen. */
  feedback?: FeedbackClientOptions;
  onChange?: (annotations: readonly Annotation[]) => void;
}
export interface FoldmarkHandle {
  dispose: () => void;
  getAnnotations: () => readonly Annotation[];
}
const sourceContext = Schema.Struct({
  source: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4000))),
  modelPath: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4000))),
  message: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4000))),
});
const summary = (request: FeedbackRequest): FeedbackSummary => ({
  id: request.id,
  revision: request.revision,
  status: request.status,
  page: request.annotations[0]?.target.page ?? "",
  message: request.result?.message ?? "",
  updatedAt: request.updatedAt,
});

/** A separate Foldkit runtime, isolated with Shadow DOM and owned by this handle. */
export function mountFoldmark(options: FoldmarkOptions = {}): FoldmarkHandle {
  if (options.enabled === false || typeof document === "undefined")
    return { dispose() {}, getAnnotations: () => [] };
  if (document.querySelector("[data-foldmark-root]"))
    throw new Error(
      "Foldmark is already mounted. Dispose the existing handle before mounting again.",
    );
  // Validate configuration before adding any DOM or listeners. Creation itself performs no I/O.
  const client = options.feedback ? createFeedbackClient(options.feedback) : undefined;
  const doc = document;
  const win = window;
  const host = doc.createElement("div");
  host.setAttribute("data-foldmark-root", "");
  const shadow = host.attachShadow({ mode: "open" });
  const style = doc.createElement("style");
  style.textContent = styles;
  const container = doc.createElement("div");
  container.id = "foldmark-runtime";
  shadow.append(style, container);
  doc.body.append(host);

  const key = options.storageKey ?? "foldmark:v1";
  let storage: Storage | false = false;
  let annotations: readonly Annotation[] = [];
  let theme: Theme = options.theme ?? "system";
  let notice = "";
  try {
    storage = options.storage ?? win.localStorage;
    const saved = storage && storage.getItem(key);
    if (saved) {
      const session = Schema.decodeUnknownSync(SavedSession)(JSON.parse(saved));
      annotations = session.annotations;
      theme = options.theme ?? session.theme ?? "system";
    }
  } catch {
    notice = "Could not restore saved notes. New notes can still be exported.";
  }
  let state: Model = {
    ...initialModel(pageKey(win.location), annotations),
    theme,
    notice,
    scrollX: win.scrollX,
    scrollY: win.scrollY,
    feedbackEnabled: !!client,
  };
  let disposed = false;
  let screenshotController: AbortController | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let polling = false;
  let pollFailureShown = false;
  const sentRequests = new Map<string, FeedbackRequest>();
  let submissionGeneration = 0;
  const mergeRequest = (request: FeedbackRequest) => {
    const previous = sentRequests.get(request.id);
    if (
      !previous ||
      request.revision > previous.revision ||
      (request.revision === previous.revision && request.updatedAt > previous.updatedAt)
    )
      sentRequests.set(request.id, request);
  };
  const schedulePoll = (delay: number) => {
    if (!disposed && !pollTimer && !polling) pollTimer = setTimeout(() => void poll(), delay);
  };
  const poll = async () => {
    pollTimer = null;
    if (disposed || !client || polling) return;
    polling = true;
    const startedGeneration = submissionGeneration;
    let again = false;
    let delay = 1000;
    try {
      const requests = await client.list();
      if (disposed) return;
      pollFailureShown = false;
      for (const request of requests) {
        // A delayed list snapshot may omit newer submissions or contain older request revisions.
        if (sentRequests.has(request.id)) mergeRequest(request);
      }
      const known = [...sentRequests.values()];
      const feedback = known.map(summary);
      if (JSON.stringify(feedback) !== JSON.stringify(state.feedback))
        send(Message.ReceivedFeedback({ feedback }));
      again = known.some((request) => request.status === "pending" || request.status === "claimed");
    } catch {
      if (!disposed) {
        if (!pollFailureShown)
          send(
            Message.CompletedOperation({
              notice: "Agent status unavailable. Sent requests remain on the server; reconnecting…",
            }),
          );
        pollFailureShown = true;
        again = true;
        delay = 3000;
      }
    } finally {
      polling = false;
      // Submission can finish while list() awaits I/O. Release the guard before rescheduling,
      // even if the older snapshot contained only completed requests.
      if (again || submissionGeneration !== startedGeneration) schedulePoll(delay);
    }
  };
  const { update } = makeUpdate({
    save: (values, nextTheme) => {
      let result = "";
      if (storage) {
        const data = JSON.stringify({
          version: 1,
          annotations: values,
          theme: nextTheme ?? state.theme,
        });
        try {
          if (data.length > 2_000_000)
            throw new Error("Session exceeds the local screenshot budget");
          storage.setItem(key, data);
        } catch (error) {
          if (!values.some((annotation) => annotation.screenshot)) throw error;
          // Preserve notes on quota errors. Images remain in this session and its explicit exports.
          const metadata = values.map(({ screenshot: _image, ...annotation }) => annotation);
          storage.setItem(
            key,
            JSON.stringify({ version: 1, annotations: metadata, theme: nextTheme ?? state.theme }),
          );
          result = "Notes saved without screenshots (storage limit). Export to keep the images.";
        }
      }
      try {
        options.onChange?.(values);
      } catch {
        return result || "Notes saved, but the host onChange callback failed.";
      }
      return result;
    },
    copy: (text) => win.navigator.clipboard.writeText(text),
    download: (text, format) => {
      const blob = new Blob([text], {
        type: format === "json" ? "application/json" : "text/markdown",
      });
      const url = URL.createObjectURL(blob);
      const anchor = doc.createElement("a");
      anchor.href = url;
      anchor.download = `foldmark-feedback.${format === "json" ? "json" : "md"}`;
      anchor.click();
      const timer = setTimeout(() => {
        URL.revokeObjectURL(url);
        downloads.delete(url);
      }, 1000);
      downloads.set(url, timer);
    },
    screenshot: async (targets) => {
      screenshotController?.abort();
      const controller = new AbortController();
      screenshotController = controller;
      try {
        // Draft metadata is a capture-time snapshot. Screenshots must use current geometry for
        // every selected element, not just the first draft's live highlight.
        const current = targets.map((target) => {
          if (target.kind === "area") return target;
          const element = resolveTarget(target, doc);
          if (!element?.isConnected || isIgnoredElement(element))
            throw new Error(
              "A selected element is detached. Select it again before attaching a screenshot.",
            );
          const rect = documentRect(element, doc);
          if (rect.width <= 0 || rect.height <= 0)
            throw new Error(
              "A selected element is hidden. Make it visible before attaching a screenshot.",
            );
          return { ...target, rect };
        });
        return await takeScreenshot(current, controller.signal, {
          document: doc,
          provider: options.screenshotProvider,
          hideWidget: () => {
            const previous = host.style.visibility;
            host.style.visibility = "hidden";
            return () => {
              if (!disposed) host.style.visibility = previous;
            };
          },
        });
      } finally {
        if (screenshotController === controller) screenshotController = null;
      }
    },
    ...(options.sourceResolver
      ? {
          resolveSource: async (target: Target) => {
            const element = resolveTarget(target, doc);
            const captured = {
              source: target.source,
              modelPath: target.modelPath,
              message: target.message,
            };
            if (!element || !options.sourceResolver) return captured;
            return Schema.decodeUnknownSync(sourceContext)(
              await options.sourceResolver(element, captured),
            );
          },
        }
      : {}),
    ...(client
      ? {
          submit: async (values: readonly Annotation[], requestId: string) => {
            const request = await client.submit(values, { requestId });
            mergeRequest(request);
            submissionGeneration++;
            schedulePoll(1000);
            return summary(sentRequests.get(request.id) ?? request);
          },
        }
      : {}),
  });
  const downloads = new Map<string, ReturnType<typeof setTimeout>>();
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
  );
  const send = (message: Message) => {
    if (!disposed) runtime.ports.event.send(message);
  };
  let resumeAnimations = () => {};
  let previousFocus: Element | null = null;
  let focusFrame = 0;
  const unsubscribe = runtime.ports.state.subscribe((next) => {
    // Commands can emit concurrently; older snapshots must not rewind browser-adapter state.
    if (disposed || next.sequence <= state.sequence) return;
    if (screenshotController && next.revision !== state.revision) screenshotController.abort();
    if (next.paused !== state.paused) {
      resumeAnimations();
      resumeAnimations = next.paused ? freezeAnimations(doc) : () => {};
    }
    if (Option.isSome(next.maybeDraft) && Option.isNone(state.maybeDraft)) {
      previousFocus = shadow.activeElement ?? doc.activeElement;
      cancelAnimationFrame(focusFrame);
      focusFrame = requestAnimationFrame(() =>
        shadow.querySelector<HTMLTextAreaElement>("#foldmark-note")?.focus(),
      );
    } else if (Option.isNone(next.maybeDraft) && Option.isSome(state.maybeDraft)) {
      cancelAnimationFrame(focusFrame);
      if (
        previousFocus?.isConnected &&
        "focus" in previousFocus &&
        typeof previousFocus.focus === "function"
      )
        previousFocus.focus();
    }
    state = next;
  });
  const ownEvent = (event: Event) => event.composedPath().includes(host);
  const editable = (event: Event) =>
    event
      .composedPath()
      .some(
        (node) =>
          isElement(node) &&
          node.matches('input,textarea,select,[contenteditable]:not([contenteditable="false"])'),
      );
  const eventElement = (event: Event): Element | null =>
    event.composedPath().find(isElement) ?? null;
  const candidate = (event: Event) => {
    if (ownEvent(event) || !state.active || Option.isSome(state.maybeDraft)) return null;
    const element = eventElement(event);
    if (!element || isIgnoredElement(element)) return null;
    if (
      state.selectionMode !== "area" &&
      (element === element.ownerDocument.documentElement || element === element.ownerDocument.body)
    )
      return null;
    return element;
  };
  const seen = new WeakSet<Event>();
  const once = (callback: (event: Event) => void) => (event: Event) => {
    if (seen.has(event)) return;
    seen.add(event);
    callback(event);
  };
  let hovered: Element | null = null;
  let hoverFrame = 0;
  let skipClickUntil = 0;
  let drag: {
    pointerId: number;
    start: { x: number; y: number };
    end: { x: number; y: number };
  } | null = null;
  const point = (event: PointerEvent) => {
    const owner = eventElement(event)?.ownerDocument ?? doc;
    const element = owner.documentElement;
    const local = element.getBoundingClientRect();
    const top = viewportRect(element, doc);
    const sx = local.width ? top.width / local.width : 1;
    const sy = local.height ? top.height / local.height : 1;
    return {
      x: top.x + (event.clientX - local.x) * sx + win.scrollX,
      y: top.y + (event.clientY - local.y) * sy + win.scrollY,
    };
  };
  const dragRect = (): Rect | null =>
    drag
      ? {
          x: Math.min(drag.start.x, drag.end.x),
          y: Math.min(drag.start.y, drag.end.y),
          width: Math.abs(drag.start.x - drag.end.x),
          height: Math.abs(drag.start.y - drag.end.y),
        }
      : null;
  const captureTarget = (element: Element) => capture(element, options.context, doc);
  const roots = new Map<
    InspectionRoot,
    { controller: AbortController; observer: MutationObserver }
  >();
  let discoverQueued = false;
  const queueDiscover = () => {
    if (discoverQueued || disposed) return;
    discoverQueued = true;
    queueMicrotask(() => {
      discoverQueued = false;
      if (!disposed) discover();
    });
  };
  const keydown = once((event) => {
    const key = event as KeyboardEvent;
    if (key.altKey && key.shiftKey && key.code === "KeyA" && !editable(event)) {
      event.preventDefault();
      send(Message.ClickedToggle());
    } else if (
      key.key === "Escape" &&
      (state.active || Option.isSome(state.maybeDraft) || state.panel !== "closed")
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      drag = null;
      send(Message.PressedEscape());
    } else if (
      ownEvent(event) &&
      Option.isSome(state.maybeDraft) &&
      key.key === "Enter" &&
      (key.metaKey || key.ctrlKey)
    ) {
      event.preventDefault();
      send(Message.ClickedSave());
    } else if (
      (ownEvent(event) || state.active) &&
      !editable(event) &&
      (key.metaKey || key.ctrlKey) &&
      key.key.toLowerCase() === "z"
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      send(key.shiftKey ? Message.ClickedRedo() : Message.ClickedUndo());
    } else if (ownEvent(event) && Option.isSome(state.maybeDraft) && key.key === "Tab") {
      const inputs = [
        ...shadow.querySelectorAll<HTMLElement>(
          ".composer button:not(:disabled), .composer textarea",
        ),
      ];
      const first = inputs[0];
      const last = inputs.at(-1);
      if (key.shiftKey && shadow.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!key.shiftKey && shadow.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  });
  const pointermove = once((event) => {
    const pointer = event as PointerEvent;
    if (drag && pointer.pointerId === drag.pointerId) {
      drag.end = point(pointer);
      send(Message.DraggedArea({ rect: dragRect() }));
      return;
    }
    if (state.selectionMode === "area") return;
    const element = candidate(event);
    if (element === hovered) return;
    hovered = element;
    cancelAnimationFrame(hoverFrame);
    hoverFrame = requestAnimationFrame(() => {
      try {
        send(
          Message.HoveredTarget({ target: element?.isConnected ? captureTarget(element) : null }),
        );
      } catch {
        send(
          Message.CompletedOperation({
            notice: "Could not inspect this element. Try another target.",
          }),
        );
      }
    });
  });
  const pointerdown = once((event) => {
    const element = candidate(event);
    if (!element) return;
    const pointer = event as PointerEvent;
    event.stopImmediatePropagation();
    if (state.selectionMode === "area" && pointer.button === 0) {
      event.preventDefault();
      const start = point(pointer);
      drag = { pointerId: pointer.pointerId, start, end: start };
      send(Message.DraggedArea({ rect: dragRect() }));
      if ("setPointerCapture" in element && typeof element.setPointerCapture === "function") {
        try {
          element.setPointerCapture(pointer.pointerId);
        } catch {
          /* Pointer may already be released. */
        }
      }
    }
  });
  const pointerup = once((event) => {
    const pointer = event as PointerEvent;
    if (!drag || pointer.pointerId !== drag.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    drag.end = point(pointer);
    const rect = dragRect();
    drag = null;
    skipClickUntil = event.timeStamp + 400;
    send(Message.DraggedArea({ rect: null }));
    if (rect && rect.width >= 5 && rect.height >= 5)
      send(Message.SelectedTarget({ target: captureArea(rect, doc) }));
  });
  const pointercancel = once(() => {
    drag = null;
    send(Message.DraggedArea({ rect: null }));
  });
  const click = once((event) => {
    const element = candidate(event);
    if (!element) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.timeStamp < skipClickUntil || state.selectionMode === "area") return;
    try {
      send(Message.SelectedTarget({ target: captureTarget(element) }));
      hovered = null;
    } catch {
      send(
        Message.CompletedOperation({
          notice: "Could not inspect this element. Try another target.",
        }),
      );
    }
  });
  const scrolled = once(() => {
    hovered = null;
    send(Message.ScrolledPage({ x: win.scrollX, y: win.scrollY }));
  });
  function discover() {
    const current = new Set(inspectionRoots(doc));
    for (const [root, resources] of roots) {
      if (!current.has(root)) {
        resources.controller.abort();
        resources.observer.disconnect();
        roots.delete(root);
      }
    }
    for (const root of current) {
      if (roots.has(root)) continue;
      const controller = new AbortController();
      const opts = { capture: true, signal: controller.signal };
      root.addEventListener("pointermove", pointermove, opts);
      root.addEventListener("pointerdown", pointerdown, opts);
      root.addEventListener("pointerup", pointerup, opts);
      root.addEventListener("pointercancel", pointercancel, opts);
      root.addEventListener("click", click, opts);
      root.addEventListener("keydown", keydown, opts);
      root.addEventListener("scroll", scrolled, { ...opts, passive: true });
      root.addEventListener("load", queueDiscover, opts);
      const observer = new MutationObserver((records) => {
        if (records.some((record) => !isElement(record.target) || !isIgnoredElement(record.target)))
          queueDiscover();
      });
      observer.observe(root, { childList: true, subtree: true });
      roots.set(root, { controller, observer });
    }
  }
  discover();
  const controller = new AbortController();
  win.addEventListener("scroll", scrolled, { signal: controller.signal, passive: true });
  win.addEventListener("resize", scrolled, { signal: controller.signal, passive: true });
  const discoverTimer = setInterval(discover, 1000);
  // Observe SPA pushState without patching host-owned history methods.
  const routeTimer = setInterval(() => {
    const page = pageKey(win.location);
    if (page !== state.page) {
      drag = null;
      send(Message.ChangedPage({ page }));
    }
  }, 200);
  let geometryFrame = 0;
  let geometryKey = "";
  const liveRect = (target: Target) => {
    if (target.kind === "area") return target.rect;
    const element = resolveTarget(target, doc);
    if (!element?.isConnected || isIgnoredElement(element)) return null;
    const rect = documentRect(element, doc);
    return rect.width > 0 && rect.height > 0 ? rect : null;
  };
  const trackGeometry = () => {
    if (disposed) return;
    if (state.active || Option.isSome(state.maybeDraft) || state.panel === "notes") {
      const pins = openAnnotations(state).map((annotation) => {
        const bounds = annotationTargets(annotation).map(liveRect);
        const rect = unionRects(bounds.filter((bound): bound is Rect => bound !== null));
        return { id: annotation.id, rect, detached: bounds.some((bound) => bound === null) };
      });
      const draft = Option.match(state.maybeDraft, { onNone: () => null, onSome: liveRect });
      const next = JSON.stringify({ pins, draft });
      if (next !== geometryKey) {
        geometryKey = next;
        send(Message.TrackedPins({ pins, draft }));
      }
    }
    geometryFrame = requestAnimationFrame(trackGeometry);
  };
  geometryFrame = requestAnimationFrame(trackGeometry);
  return {
    getAnnotations: () => state.annotations,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      client?.dispose();
      screenshotController?.abort();
      controller.abort();
      for (const resources of roots.values()) {
        resources.controller.abort();
        resources.observer.disconnect();
      }
      roots.clear();
      clearInterval(routeTimer);
      clearInterval(discoverTimer);
      if (pollTimer) clearTimeout(pollTimer);
      cancelAnimationFrame(hoverFrame);
      cancelAnimationFrame(focusFrame);
      cancelAnimationFrame(geometryFrame);
      for (const [url, timer] of downloads) {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
      }
      downloads.clear();
      resumeAnimations();
      unsubscribe();
      runtime.dispose();
      host.remove();
    },
  };
}
