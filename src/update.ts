import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { Command, Port, type Update } from 'foldkit'
import { Annotation, Message, Model, Target, openAnnotations } from './model'
import { toJson, toMarkdown } from './report'

export const ports = {
  inbound: { event: Port.inbound(Message) },
  outbound: { state: Port.outbound(Model) },
}

export interface Operations {
  save: (annotations: readonly Annotation[]) => void
  copy: (text: string) => Promise<void>
  download: (text: string, format: 'markdown' | 'json') => void
}

export function makeUpdate(operations: Operations) {
  const Sync = Command.define('Foldmark.Sync', {
    args: { state: Model },
    messages: [Message.CompletedSync],
    execute: ({ state }) =>
      Port.emit(ports.outbound.state, state).pipe(Effect.as(Message.CompletedSync())),
  })
  const Save = Command.define('Foldmark.Persist', {
    args: { annotations: Schema.Array(Annotation) },
    messages: [Message.CompletedOperation],
    execute: ({ annotations }) =>
      Effect.try(() => operations.save(annotations)).pipe(
        Effect.match({
          onSuccess: () => Message.CompletedOperation({ notice: 'Saved' }),
          onFailure: () =>
            Message.CompletedOperation({
              notice: 'Storage unavailable. Export your notes to keep them.',
            }),
        }),
      ),
  })
  const Prepare = Command.define('Foldmark.PrepareAnnotation', {
    args: { target: Target, note: Schema.String, editingId: Schema.NullOr(Schema.String) },
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
  const report = (m: Model) => (m.format === 'markdown' ? toMarkdown : toJson)(openAnnotations(m))
  const reduce = (m: Model, msg: Message): Update.Return<Model, Message> =>
    Message.match<Update.Return<Model, Message>>(msg, {
      ClickedToggle: () => ({
        model: {
          ...m,
          active: !m.active,
          hover: null,
          draft: null,
          editingId: null,
          note: '',
          notice: '',
        },
      }),
      HoveredTarget: ({ target }) => ({
        model: m.active && !m.draft ? { ...m, hover: target } : m,
      }),
      SelectedTarget: ({ target }) => ({
        model:
          m.active && !m.draft
            ? {
                ...m,
                draft: target,
                hover: null,
                note: '',
                editingId: null,
                panel: 'closed',
                notice: '',
              }
            : m,
      }),
      ChangedNote: ({ note }) => ({ model: { ...m, note: note.slice(0, 4000) } }),
      CancelledDraft: () => ({ model: { ...m, draft: null, editingId: null, note: '' } }),
      ClickedSave: () =>
        m.draft && m.note.trim()
          ? {
              model: { ...m, draft: null, note: '', editingId: null, panel: 'notes' },
              commands: [Prepare({ target: m.draft, note: m.note.trim(), editingId: m.editingId })],
            }
          : { model: m },
      PreparedAnnotation: ({ target, note, id, createdAt, editingId }) => {
        const annotations = editingId
          ? m.annotations.map((a) => (a.id === editingId ? { ...a, note } : a))
          : [...m.annotations, { id, target, note, createdAt, resolved: false }]
        return { model: { ...m, annotations }, commands: [Save({ annotations })] }
      },
      ClickedEdit: ({ id }) => {
        const annotation = m.annotations.find((a) => a.id === id)
        return {
          model: annotation
            ? {
                ...m,
                draft: annotation.target,
                editingId: id,
                note: annotation.note,
                hover: null,
                panel: 'closed',
              }
            : m,
        }
      },
      ClickedResolve: ({ id }) => {
        const annotations = m.annotations.map((a) =>
          a.id === id ? { ...a, resolved: !a.resolved } : a,
        )
        return { model: { ...m, annotations }, commands: [Save({ annotations })] }
      },
      ClickedDelete: ({ id }) => {
        const annotations = m.annotations.filter((a) => a.id !== id)
        return { model: { ...m, annotations }, commands: [Save({ annotations })] }
      },
      ClickedNotes: () => ({
        model: { ...m, panel: m.panel === 'notes' ? 'closed' : 'notes', draft: null, note: '' },
      }),
      ClickedExport: () => ({
        model: { ...m, panel: 'export', draft: null, hover: null, notice: '' },
      }),
      ClickedClosePanel: () => ({ model: { ...m, panel: 'closed' } }),
      ClickedFilter: () => ({ model: { ...m, showResolved: !m.showResolved } }),
      ChangedFormat: ({ format }) => ({ model: { ...m, format, notice: '' } }),
      ClickedCopy: () => ({ model: m, commands: [Copy({ text: report(m) })] }),
      ClickedDownload: () => ({
        model: m,
        commands: [Download({ text: report(m), format: m.format })],
      }),
      ClickedPause: () => ({ model: { ...m, paused: !m.paused } }),
      PressedEscape: () => ({
        model: {
          ...m,
          draft: null,
          hover: null,
          note: '',
          editingId: null,
          panel: 'closed',
          active: m.draft ? m.active : false,
        },
      }),
      ChangedPage: ({ page }) => ({
        model: { ...m, page, draft: null, hover: null, editingId: null, note: '' },
      }),
      ScrolledPage: ({ x, y }) => ({ model: { ...m, scrollX: x, scrollY: y, hover: null } }),
      CompletedOperation: ({ notice }) => ({ model: { ...m, notice } }),
      CompletedSync: () => ({ model: m }),
    })
  const update = (model: Model, message: Message): Update.Return<Model, Message> => {
    const result = reduce(model, message)
    if (result.model === model) return result
    return { ...result, commands: [...(result.commands ?? []), Sync({ state: result.model })] }
  }
  return { update, report }
}
