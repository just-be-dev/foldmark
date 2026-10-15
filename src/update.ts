import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { Command, Port, type Update } from 'foldkit'
import type { SourceContext } from './capture'
import {
  Annotation,
  FeedbackSummary,
  Message,
  Model,
  Screenshot,
  Target,
  Theme,
  annotationTargets,
  openAnnotations,
  targetKey,
} from './model'
import { toJson, toMarkdown } from './report'

export const ports = {
  inbound: { event: Port.inbound(Message) },
  outbound: { state: Port.outbound(Model) },
}
export interface Operations {
  save: (annotations: readonly Annotation[], theme?: Theme) => string | void
  copy: (text: string) => Promise<void>
  download: (text: string, format: 'markdown' | 'json') => void
  screenshot?: (targets: readonly Target[]) => Promise<Screenshot>
  resolveSource?: (target: Target) => Promise<SourceContext>
  submit?: (annotations: readonly Annotation[]) => Promise<FeedbackSummary>
}
const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback
class ScreenshotCaptureError extends Schema.TaggedError<ScreenshotCaptureError>()(
  'ScreenshotCaptureError',
  { message: Schema.String },
) {}
const clearDraft = (m: Model): Model => ({
  ...m,
  draft: null,
  draftTargets: [],
  draftScreenshot: null,
  screenshotState: 'idle',
  editingId: null,
  note: '',
  selection: [],
  area: null,
  hover: null,
  revision: m.revision + 1,
  pendingSaveRevision: null,
})
const historyLimit = 30
const mergeFeedback = (
  existing: readonly FeedbackSummary[],
  incoming: readonly FeedbackSummary[],
) => {
  const values = new Map(existing.map((item) => [item.id, item]))
  for (const item of incoming) {
    const previous = values.get(item.id)
    if (
      !previous ||
      item.revision > previous.revision ||
      (item.revision === previous.revision && item.updatedAt > previous.updatedAt)
    )
      values.set(item.id, item)
  }
  return [...values.values()]
}

export function makeUpdate(operations: Operations) {
  const Sync = Command.define('Foldmark.Sync', {
    args: { state: Model },
    messages: [Message.CompletedSync],
    execute: ({ state }) =>
      Port.emit(ports.outbound.state, state).pipe(Effect.as(Message.CompletedSync())),
  })
  const Save = Command.define('Foldmark.Persist', {
    args: { annotations: Schema.Array(Annotation), theme: Theme },
    messages: [Message.CompletedOperation],
    execute: ({ annotations, theme }) =>
      Effect.try(() => operations.save(annotations, theme)).pipe(
        Effect.match({
          onSuccess: (notice) => Message.CompletedOperation({ notice: notice || 'Saved' }),
          onFailure: () =>
            Message.CompletedOperation({
              notice: 'Storage unavailable. Export your notes to keep them.',
            }),
        }),
      ),
  })
  const Prepare = Command.define('Foldmark.PrepareAnnotation', {
    args: {
      target: Target,
      targets: Schema.Array(Target),
      note: Schema.String,
      editingId: Schema.NullOr(Schema.String),
      screenshot: Schema.NullOr(Screenshot),
      revision: Schema.Int,
    },
    messages: [Message.PreparedAnnotation],
    execute: (args) =>
      Effect.sync(() =>
        Message.PreparedAnnotation({
          ...args,
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
        }),
      ),
  })
  const ResolveSource = Command.define('Foldmark.ResolveSource', {
    args: { target: Target, revision: Schema.Int },
    messages: [Message.ResolvedSource, Message.CompletedOperation],
    execute: ({ target, revision }) =>
      Effect.tryPromise(async () => {
        const context = await operations.resolveSource?.(target)
        return Message.ResolvedSource({
          revision,
          selector: targetKey(target),
          source: context?.source ?? target.source,
          modelPath: context?.modelPath ?? target.modelPath,
          message: context?.message ?? target.message,
        })
      }).pipe(
        Effect.catch(() =>
          Effect.succeed(
            Message.CompletedOperation({
              notice: 'Source mapping unavailable; captured hints are retained.',
            }),
          ),
        ),
      ),
  })
  const CaptureScreenshot = Command.define('Foldmark.CaptureScreenshot', {
    args: { targets: Schema.Array(Target), revision: Schema.Int },
    messages: [Message.CompletedScreenshot, Message.FailedScreenshot],
    execute: ({ targets, revision }) =>
      Effect.tryPromise({
        try: async () => {
          if (!operations.screenshot) throw new Error('Screenshot capture is unavailable')
          return await operations.screenshot(targets)
        },
        catch: (error) =>
          new ScreenshotCaptureError({
            message: errorMessage(error, 'Screenshot failed. Your note has not changed.'),
          }),
      }).pipe(
        Effect.match({
          onSuccess: (screenshot) => Message.CompletedScreenshot({ revision, screenshot }),
          onFailure: (error) =>
            Message.FailedScreenshot({
              revision,
              notice: error.message,
            }),
        }),
      ),
  })
  const Submit = Command.define('Foldmark.SubmitFeedback', {
    args: { annotations: Schema.Array(Annotation) },
    messages: [Message.SubmittedFeedback, Message.FailedSubmission],
    execute: ({ annotations }) =>
      Effect.tryPromise(async () => {
        if (!operations.submit) throw new Error('Feedback server is not configured')
        return await operations.submit(annotations)
      }).pipe(
        Effect.match({
          onSuccess: (feedback) => Message.SubmittedFeedback({ feedback }),
          onFailure: () =>
            Message.FailedSubmission({
              notice: 'Could not send feedback. Your notes are local; retry to send.',
            }),
        }),
      ),
  })
  const Copy = Command.define('Foldmark.Copy', {
    args: { text: Schema.String },
    messages: [Message.CompletedOperation],
    execute: ({ text }) =>
      Effect.tryPromise(() => operations.copy(text)).pipe(
        Effect.match({
          onSuccess: () => Message.CompletedOperation({ notice: 'Copied. Ready for your agent.' }),
          onFailure: () =>
            Message.CompletedOperation({
              notice: 'Clipboard unavailable. Select the report or download it.',
            }),
        }),
      ),
  })
  const Download = Command.define('Foldmark.Download', {
    args: { text: Schema.String, format: Schema.Literals(['markdown', 'json']) },
    messages: [Message.CompletedOperation],
    execute: ({ text, format }) =>
      Effect.try(() => operations.download(text, format)).pipe(
        Effect.match({
          onSuccess: () => Message.CompletedOperation({ notice: 'Report downloaded' }),
          onFailure: () =>
            Message.CompletedOperation({
              notice: 'Download failed. Select the report to copy it.',
            }),
        }),
      ),
  })
  const persist = (m: Model) => Save({ annotations: m.annotations, theme: m.theme })
  const commit = (m: Model, annotations: readonly Annotation[]): Update.Return<Model, Message> => {
    const model = {
      ...clearDraft(m),
      annotations,
      past: [...m.past, m.annotations].slice(-historyLimit),
      future: [],
    }
    return { model, commands: [persist(model)] }
  }
  const sourceCommands = (targets: readonly Target[], revision: number) =>
    operations.resolveSource ? targets.map((target) => ResolveSource({ target, revision })) : []
  const compose = (m: Model, targets: readonly Target[]): Update.Return<Model, Message> => {
    const first = targets[0]
    if (!first) return { model: m }
    const model = {
      ...clearDraft(m),
      draft: first,
      draftTargets: targets,
      panel: 'closed' as const,
      notice: '',
    }
    return { model, commands: sourceCommands(targets, model.revision) }
  }
  const report = (m: Model) => (m.format === 'markdown' ? toMarkdown : toJson)(openAnnotations(m))
  const reduce = (m: Model, msg: Message): Update.Return<Model, Message> =>
    Message.match<Update.Return<Model, Message>>(msg, {
      ClickedToggle: () => ({
        model: { ...clearDraft(m), active: !m.active, notice: '' },
      }),
      HoveredTarget: ({ target }) => ({
        model: m.active && !m.draft && !m.area ? { ...m, hover: target } : m,
      }),
      SelectedTarget: ({ target }) => {
        if (!m.active || m.draft || m.screenshotState === 'capturing') return { model: m }
        if (m.selectionMode !== 'multi') return compose(m, [target])
        const exists = m.selection.some((t) => targetKey(t) === targetKey(target))
        const selection = exists
          ? m.selection.filter((t) => targetKey(t) !== targetKey(target))
          : [...m.selection, target].slice(0, 100)
        return { model: { ...m, selection, hover: null, notice: '' } }
      },
      ChangedSelectionMode: ({ mode }) => ({
        model: { ...clearDraft(m), active: true, selectionMode: mode, panel: 'closed' },
      }),
      DraggedArea: ({ rect }) => ({
        model:
          m.active && !m.draft && m.selectionMode === 'area'
            ? { ...m, area: rect, hover: null }
            : m,
      }),
      ClickedComposeSelection: () =>
        m.active && !m.draft ? compose(m, m.selection) : { model: m },
      ClickedClearSelection: () => ({ model: { ...m, selection: [], area: null, hover: null } }),
      ChangedNote: ({ note }) => ({ model: { ...m, note: note.slice(0, 4000) } }),
      CancelledDraft: () => ({ model: clearDraft(m) }),
      ClickedSave: () => {
        if (!m.draft || !m.note.trim() || m.screenshotState === 'capturing') return { model: m }
        const revision = m.revision + 1
        return {
          model: { ...clearDraft(m), pendingSaveRevision: revision, panel: 'notes' },
          commands: [
            Prepare({
              target: m.draft,
              targets: m.draftTargets.length ? m.draftTargets : [m.draft],
              note: m.note.trim(),
              editingId: m.editingId,
              screenshot: m.draftScreenshot,
              revision,
            }),
          ],
        }
      },
      PreparedAnnotation: ({
        target,
        targets,
        note,
        id,
        createdAt,
        editingId,
        screenshot,
        revision,
      }) => {
        if (revision !== undefined && revision !== m.pendingSaveRevision) return { model: m }
        if (editingId && !m.annotations.some((a) => a.id === editingId)) return { model: m }
        const annotations = editingId
          ? m.annotations.map((a) =>
              a.id === editingId
                ? {
                    ...a,
                    note,
                    ...(screenshot === undefined ? {} : { screenshot: screenshot ?? undefined }),
                  }
                : a,
            )
          : [
              ...m.annotations,
              {
                id,
                target,
                note,
                createdAt,
                resolved: false,
                ...(targets && targets.length > 1 ? { targets } : {}),
                ...(screenshot ? { screenshot } : {}),
              },
            ]
        // Keep exact optional-property semantics: removal is absence, not an undefined value.
        const clean = annotations.map((a) => {
          if (a.screenshot !== undefined) return a
          const { screenshot: _removed, ...rest } = a
          return rest
        })
        return commit(m, clean)
      },
      ClickedEdit: ({ id }) => {
        const annotation = m.annotations.find((a) => a.id === id)
        return {
          model: annotation
            ? {
                ...clearDraft(m),
                draft: annotation.target,
                draftTargets: annotationTargets(annotation),
                draftScreenshot: annotation.screenshot ?? null,
                editingId: id,
                note: annotation.note,
                panel: 'closed',
              }
            : m,
        }
      },
      ClickedResolve: ({ id }) =>
        m.annotations.some((a) => a.id === id)
          ? commit(
              m,
              m.annotations.map((a) => (a.id === id ? { ...a, resolved: !a.resolved } : a)),
            )
          : { model: m },
      ClickedDelete: ({ id }) =>
        m.annotations.some((a) => a.id === id)
          ? commit(
              m,
              m.annotations.filter((a) => a.id !== id),
            )
          : { model: m },
      ClickedUndo: () => {
        const annotations = m.past.at(-1)
        if (!annotations) return { model: m }
        const model = {
          ...clearDraft(m),
          annotations,
          past: m.past.slice(0, -1),
          future: [m.annotations, ...m.future].slice(0, historyLimit),
          notice: 'Undone',
        }
        return { model, commands: [persist(model)] }
      },
      ClickedRedo: () => {
        const annotations = m.future[0]
        if (!annotations) return { model: m }
        const model = {
          ...clearDraft(m),
          annotations,
          past: [...m.past, m.annotations].slice(-historyLimit),
          future: m.future.slice(1),
          notice: 'Redone',
        }
        return { model, commands: [persist(model)] }
      },
      ClickedNotes: () => ({
        model: { ...clearDraft(m), panel: m.panel === 'notes' ? 'closed' : 'notes' },
      }),
      ClickedExport: () => ({ model: { ...clearDraft(m), panel: 'export', notice: '' } }),
      ClickedSettings: () => ({
        model: { ...clearDraft(m), panel: m.panel === 'settings' ? 'closed' : 'settings' },
      }),
      ChangedTheme: ({ theme }) => {
        const model = { ...m, theme }
        return { model, commands: [persist(model)] }
      },
      ClickedClosePanel: () => ({ model: { ...m, panel: 'closed' } }),
      ClickedFilter: () => ({ model: { ...m, showResolved: !m.showResolved } }),
      ChangedFormat: ({ format }) => ({ model: { ...m, format, notice: '' } }),
      ClickedCopy: () => ({ model: m, commands: [Copy({ text: report(m) })] }),
      ClickedDownload: () => ({
        model: m,
        commands: [Download({ text: report(m), format: m.format })],
      }),
      ClickedPause: () => ({ model: { ...m, paused: !m.paused } }),
      ClickedScreenshot: () =>
        m.draft && m.screenshotState === 'idle'
          ? {
              model: {
                ...m,
                screenshotState: 'capturing',
                notice: 'Choose this tab to attach a redacted screenshot.',
              },
              commands: [
                CaptureScreenshot({
                  targets: m.draftTargets.length ? m.draftTargets : [m.draft],
                  revision: m.revision,
                }),
              ],
            }
          : { model: m },
      CompletedScreenshot: ({ revision, screenshot }) => ({
        model:
          m.draft && revision === m.revision && m.screenshotState === 'capturing'
            ? {
                ...m,
                draftScreenshot: screenshot,
                screenshotState: 'idle',
                notice: 'Screenshot attached. Review it before sharing.',
              }
            : m,
      }),
      FailedScreenshot: ({ revision, notice }) => ({
        model: revision === m.revision ? { ...m, screenshotState: 'idle', notice } : m,
      }),
      ClickedRemoveScreenshot: () => ({ model: { ...m, draftScreenshot: null } }),
      ResolvedSource: ({ revision, selector, source, modelPath, message }) => {
        if (!m.draft || revision !== m.revision) return { model: m }
        const mapped = (target: Target) =>
          targetKey(target) === selector ? { ...target, source, modelPath, message } : target
        return { model: { ...m, draft: mapped(m.draft), draftTargets: m.draftTargets.map(mapped) } }
      },
      ClickedSend: () =>
        m.feedbackEnabled && !m.sending && openAnnotations(m).length
          ? {
              model: { ...m, sending: true, notice: '' },
              commands: [Submit({ annotations: openAnnotations(m) })],
            }
          : { model: m },
      SubmittedFeedback: ({ feedback }) => ({
        model: {
          ...m,
          sending: false,
          feedback: mergeFeedback(m.feedback, [feedback]),
          notice: 'Feedback sent. The agent can now read this request.',
        },
      }),
      FailedSubmission: ({ notice }) => ({ model: { ...m, sending: false, notice } }),
      ReceivedFeedback: ({ feedback }) => ({
        model: { ...m, feedback: mergeFeedback(m.feedback, feedback) },
      }),
      PressedEscape: () => ({
        model: {
          ...clearDraft(m),
          panel: 'closed',
          active: m.draft || m.selection.length || m.area ? m.active : false,
        },
      }),
      ChangedPage: ({ page }) => ({ model: { ...clearDraft(m), page, livePins: [] } }),
      ScrolledPage: ({ x, y }) => ({ model: { ...m, scrollX: x, scrollY: y, hover: null } }),
      TrackedPins: ({ pins, draft }) => ({
        model: {
          ...m,
          livePins: pins,
          ...(draft && m.draft ? { draft: { ...m.draft, rect: draft } } : {}),
        },
      }),
      CompletedOperation: ({ notice }) => ({ model: { ...m, notice } }),
      CompletedSync: () => ({ model: m }),
    })
  const update = (model: Model, message: Message): Update.Return<Model, Message> => {
    const result = reduce(model, message)
    if (result.model === model) return result
    const next = { ...result.model, sequence: model.sequence + 1 }
    return { ...result, model: next, commands: [...(result.commands ?? []), Sync({ state: next })] }
  }
  return { update, report }
}
