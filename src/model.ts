import * as Schema from 'effect/Schema'
import { defineMessageUnion } from 'foldkit/message'

export const Rect = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
})
export const Target = Schema.Struct({
  selector: Schema.String,
  tag: Schema.String,
  text: Schema.String,
  selectedText: Schema.String,
  source: Schema.String,
  modelPath: Schema.String,
  message: Schema.String,
  rect: Rect,
  font: Schema.String,
  color: Schema.String,
  background: Schema.String,
  page: Schema.String,
  title: Schema.String,
  viewport: Schema.String,
})
export interface Target extends Schema.Schema.Type<typeof Target> {}
export const Annotation = Schema.Struct({
  id: Schema.String,
  target: Target,
  note: Schema.String,
  resolved: Schema.Boolean,
  createdAt: Schema.String,
})
export interface Annotation extends Schema.Schema.Type<typeof Annotation> {}
export const SavedSession = Schema.Struct({
  version: Schema.Literal(1),
  annotations: Schema.Array(Annotation),
})
export const Model = Schema.Struct({
  active: Schema.Boolean,
  paused: Schema.Boolean,
  hover: Schema.NullOr(Target),
  draft: Schema.NullOr(Target),
  editingId: Schema.NullOr(Schema.String),
  note: Schema.String,
  annotations: Schema.Array(Annotation),
  panel: Schema.Literals(['closed', 'notes', 'export']),
  showResolved: Schema.Boolean,
  format: Schema.Literals(['markdown', 'json']),
  notice: Schema.String,
  page: Schema.String,
  scrollX: Schema.Finite,
  scrollY: Schema.Finite,
})
export interface Model extends Schema.Schema.Type<typeof Model> {}
export const Message = defineMessageUnion({
  ClickedToggle: {},
  HoveredTarget: { target: Schema.NullOr(Target) },
  SelectedTarget: { target: Target },
  ChangedNote: { note: Schema.String },
  CancelledDraft: {},
  ClickedSave: {},
  PreparedAnnotation: {
    id: Schema.String,
    createdAt: Schema.String,
    target: Target,
    note: Schema.String,
    editingId: Schema.NullOr(Schema.String),
  },
  ClickedEdit: { id: Schema.String },
  ClickedResolve: { id: Schema.String },
  ClickedDelete: { id: Schema.String },
  ClickedNotes: {},
  ClickedExport: {},
  ClickedClosePanel: {},
  ClickedFilter: {},
  ChangedFormat: { format: Schema.Literals(['markdown', 'json']) },
  ClickedCopy: {},
  ClickedDownload: {},
  ClickedPause: {},
  PressedEscape: {},
  ChangedPage: { page: Schema.String },
  ScrolledPage: { x: Schema.Finite, y: Schema.Finite },
  CompletedOperation: { notice: Schema.String },
  CompletedSync: {},
})
export type Message = typeof Message.Type
export const initialModel = (page: string, annotations: readonly Annotation[] = []): Model => ({
  active: false,
  paused: false,
  hover: null,
  draft: null,
  editingId: null,
  note: '',
  annotations,
  panel: 'closed',
  showResolved: false,
  format: 'markdown',
  notice: '',
  page,
  scrollX: 0,
  scrollY: 0,
})
export const pageAnnotations = (model: Model) =>
  model.annotations.filter((a) => a.target.page === model.page)
export const openAnnotations = (model: Model) => pageAnnotations(model).filter((a) => !a.resolved)
