import * as Schema from 'effect/Schema'
import { defineMessageUnion } from 'foldkit/message'

export const Rect = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
})
export interface Rect extends Schema.Schema.Type<typeof Rect> {}
/** Selectors are local to each root; each boundary opens the next root. */
export const TargetBoundary = Schema.Struct({
  kind: Schema.Literals(['shadow', 'frame']),
  selector: Schema.String,
})
export interface TargetBoundary extends Schema.Schema.Type<typeof TargetBoundary> {}
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
  path: Schema.optionalKey(Schema.Array(TargetBoundary)),
  kind: Schema.optionalKey(Schema.Literals(['element', 'area'])),
  framePage: Schema.optionalKey(Schema.String),
})
export interface Target extends Schema.Schema.Type<typeof Target> {}
export const Screenshot = Schema.Struct({
  dataUrl: Schema.String.check(
    Schema.isPattern(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/),
    Schema.isMaxLength(700_000),
  ),
  width: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1920)),
  height: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1920)),
  capturedAt: Schema.String,
})
export interface Screenshot extends Schema.Schema.Type<typeof Screenshot> {}
export const Annotation = Schema.Struct({
  id: Schema.String,
  target: Target,
  note: Schema.String,
  resolved: Schema.Boolean,
  createdAt: Schema.String,
  /** Additional selected elements; target is always the first member. */
  targets: Schema.optionalKey(Schema.Array(Target).check(Schema.isMaxLength(100))),
  screenshot: Schema.optionalKey(Screenshot),
})
export interface Annotation extends Schema.Schema.Type<typeof Annotation> {}
export const Theme = Schema.Literals(['system', 'light', 'dark'])
export type Theme = typeof Theme.Type
export const SelectionMode = Schema.Literals(['element', 'multi', 'area'])
export const SavedSession = Schema.Struct({
  version: Schema.Literal(1),
  annotations: Schema.Array(Annotation),
  theme: Schema.optionalKey(Theme),
})
export const LivePin = Schema.Struct({
  id: Schema.String,
  rect: Schema.NullOr(Rect),
  detached: Schema.Boolean,
})
export const FeedbackSummary = Schema.Struct({
  id: Schema.String,
  revision: Schema.Int,
  status: Schema.Literals(['pending', 'claimed', 'completed', 'failed']),
  page: Schema.String,
  message: Schema.String,
  updatedAt: Schema.String,
})
export interface FeedbackSummary extends Schema.Schema.Type<typeof FeedbackSummary> {}
const History = Schema.Array(Schema.Array(Annotation))
export const Model = Schema.Struct({
  sequence: Schema.Int,
  active: Schema.Boolean,
  paused: Schema.Boolean,
  hover: Schema.NullOr(Target),
  draft: Schema.NullOr(Target),
  draftTargets: Schema.Array(Target),
  draftScreenshot: Schema.NullOr(Screenshot),
  screenshotState: Schema.Literals(['idle', 'capturing']),
  revision: Schema.Int,
  pendingSaveRevision: Schema.NullOr(Schema.Int),
  editingId: Schema.NullOr(Schema.String),
  note: Schema.String,
  annotations: Schema.Array(Annotation),
  past: History,
  future: History,
  theme: Theme,
  selectionMode: SelectionMode,
  selection: Schema.Array(Target),
  area: Schema.NullOr(Rect),
  livePins: Schema.Array(LivePin),
  panel: Schema.Literals(['closed', 'notes', 'export', 'settings']),
  showResolved: Schema.Boolean,
  format: Schema.Literals(['markdown', 'json']),
  notice: Schema.String,
  page: Schema.String,
  scrollX: Schema.Finite,
  scrollY: Schema.Finite,
  feedbackEnabled: Schema.Boolean,
  sending: Schema.Boolean,
  feedback: Schema.Array(FeedbackSummary),
})
export interface Model extends Schema.Schema.Type<typeof Model> {}
export const Message = defineMessageUnion({
  ClickedToggle: {},
  HoveredTarget: { target: Schema.NullOr(Target) },
  SelectedTarget: { target: Target },
  ChangedSelectionMode: { mode: SelectionMode },
  DraggedArea: { rect: Schema.NullOr(Rect) },
  ClickedComposeSelection: {},
  ClickedClearSelection: {},
  ChangedNote: { note: Schema.String },
  CancelledDraft: {},
  ClickedSave: {},
  PreparedAnnotation: {
    id: Schema.String,
    createdAt: Schema.String,
    target: Target,
    note: Schema.String,
    editingId: Schema.NullOr(Schema.String),
    targets: Schema.optionalKey(Schema.Array(Target)),
    screenshot: Schema.optionalKey(Schema.NullOr(Screenshot)),
    revision: Schema.optionalKey(Schema.Int),
  },
  ClickedEdit: { id: Schema.String },
  ClickedResolve: { id: Schema.String },
  ClickedDelete: { id: Schema.String },
  ClickedUndo: {},
  ClickedRedo: {},
  ClickedNotes: {},
  ClickedExport: {},
  ClickedSettings: {},
  ChangedTheme: { theme: Theme },
  ClickedClosePanel: {},
  ClickedFilter: {},
  ChangedFormat: { format: Schema.Literals(['markdown', 'json']) },
  ClickedCopy: {},
  ClickedDownload: {},
  ClickedPause: {},
  ClickedScreenshot: {},
  CompletedScreenshot: { revision: Schema.Int, screenshot: Screenshot },
  FailedScreenshot: { revision: Schema.Int, notice: Schema.String },
  ClickedRemoveScreenshot: {},
  ResolvedSource: {
    revision: Schema.Int,
    selector: Schema.String,
    source: Schema.String,
    modelPath: Schema.String,
    message: Schema.String,
  },
  ClickedSend: {},
  SubmittedFeedback: { feedback: FeedbackSummary },
  FailedSubmission: { notice: Schema.String },
  ReceivedFeedback: { feedback: Schema.Array(FeedbackSummary) },
  PressedEscape: {},
  ChangedPage: { page: Schema.String },
  ScrolledPage: { x: Schema.Finite, y: Schema.Finite },
  TrackedPins: { pins: Schema.Array(LivePin), draft: Schema.NullOr(Rect) },
  CompletedOperation: { notice: Schema.String },
  CompletedSync: {},
})
export type Message = typeof Message.Type
export const initialModel = (page: string, annotations: readonly Annotation[] = []): Model => ({
  sequence: 0,
  active: false,
  paused: false,
  hover: null,
  draft: null,
  draftTargets: [],
  draftScreenshot: null,
  screenshotState: 'idle',
  revision: 0,
  pendingSaveRevision: null,
  editingId: null,
  note: '',
  annotations,
  past: [],
  future: [],
  theme: 'system',
  selectionMode: 'element',
  selection: [],
  area: null,
  livePins: [],
  panel: 'closed',
  showResolved: false,
  format: 'markdown',
  notice: '',
  page,
  scrollX: 0,
  scrollY: 0,
  feedbackEnabled: false,
  sending: false,
  feedback: [],
})
export const pageAnnotations = (model: Model) =>
  model.annotations.filter((a) => a.target.page === model.page)
export const openAnnotations = (model: Model) => pageAnnotations(model).filter((a) => !a.resolved)
export const annotationTargets = (annotation: Annotation): readonly Target[] =>
  annotation.targets?.length ? annotation.targets : [annotation.target]
export const targetKey = (target: Target) =>
  `${JSON.stringify(target.path ?? [])}:${target.selector}:${target.page}:${target.framePage ?? ''}`
