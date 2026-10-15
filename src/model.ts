import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const Rect = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
});
export interface Rect extends Schema.Schema.Type<typeof Rect> {}
/** Selectors are local to each root; each boundary opens the next root. */
export const TargetBoundary = Schema.Struct({
  kind: Schema.Literals(["shadow", "frame"]),
  selector: Schema.String,
});
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
  kind: Schema.optionalKey(Schema.Literals(["element", "area"])),
  framePage: Schema.optionalKey(Schema.String),
});
export interface Target extends Schema.Schema.Type<typeof Target> {}
/** A validated, redacted raster ready to attach to a note. */
export const CapturedImage = Schema.Struct({
  dataUrl: Schema.String.check(
    Schema.isPattern(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/),
    Schema.isMaxLength(700_000),
  ),
  width: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1920)),
  height: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1920)),
});
export interface CapturedImage extends Schema.Schema.Type<typeof CapturedImage> {}
export const Screenshot = Schema.Struct({ ...CapturedImage.fields, capturedAt: Schema.String });
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
});
export interface Annotation extends Schema.Schema.Type<typeof Annotation> {}
export const Theme = Schema.Literals(["system", "light", "dark"]);
export type Theme = typeof Theme.Type;
export const SelectionMode = Schema.Literals(["element", "multi", "area"]);
export const SavedSession = Schema.Struct({
  version: Schema.Literal(1),
  annotations: Schema.Array(Annotation),
  theme: Schema.optionalKey(Theme),
});
export const LivePin = Schema.Struct({
  id: Schema.String,
  rect: Schema.NullOr(Rect),
  detached: Schema.Boolean,
});
export const FeedbackSummary = Schema.Struct({
  id: Schema.String,
  revision: Schema.Int,
  status: Schema.Literals(["pending", "claimed", "completed", "failed"]),
  page: Schema.String,
  message: Schema.String,
  updatedAt: Schema.String,
});
export interface FeedbackSummary extends Schema.Schema.Type<typeof FeedbackSummary> {}
/** A failed submission's idempotency key, reused when the same notes are sent again. */
export const RetrySubmission = Schema.Struct({
  requestId: Schema.String,
  contentKey: Schema.String,
});
export interface RetrySubmission extends Schema.Schema.Type<typeof RetrySubmission> {}
const History = Schema.Array(Schema.Array(Annotation));
export const Model = Schema.Struct({
  sequence: Schema.Int,
  active: Schema.Boolean,
  paused: Schema.Boolean,
  maybeHover: Schema.Option(Target),
  maybeDraft: Schema.Option(Target),
  draftTargets: Schema.Array(Target),
  maybeDraftScreenshot: Schema.Option(Screenshot),
  screenshotState: Schema.Literals(["idle", "capturing"]),
  revision: Schema.Int,
  maybePendingSaveRevision: Schema.Option(Schema.Int),
  maybeEditingId: Schema.Option(Schema.String),
  note: Schema.String,
  annotations: Schema.Array(Annotation),
  past: History,
  future: History,
  theme: Theme,
  selectionMode: SelectionMode,
  selection: Schema.Array(Target),
  maybeArea: Schema.Option(Rect),
  livePins: Schema.Array(LivePin),
  panel: Schema.Literals(["closed", "notes", "export", "settings"]),
  showResolved: Schema.Boolean,
  format: Schema.Literals(["markdown", "json"]),
  notice: Schema.String,
  page: Schema.String,
  scrollX: Schema.Finite,
  scrollY: Schema.Finite,
  feedbackEnabled: Schema.Boolean,
  sending: Schema.Boolean,
  maybeRetrySubmission: Schema.Option(RetrySubmission),
  feedback: Schema.Array(FeedbackSummary),
});
export interface Model extends Schema.Schema.Type<typeof Model> {}
export const initialModel = (page: string, annotations: readonly Annotation[] = []): Model => ({
  sequence: 0,
  active: false,
  paused: false,
  maybeHover: Option.none(),
  maybeDraft: Option.none(),
  draftTargets: [],
  maybeDraftScreenshot: Option.none(),
  screenshotState: "idle",
  revision: 0,
  maybePendingSaveRevision: Option.none(),
  maybeEditingId: Option.none(),
  note: "",
  annotations,
  past: [],
  future: [],
  theme: "system",
  selectionMode: "element",
  selection: [],
  maybeArea: Option.none(),
  livePins: [],
  panel: "closed",
  showResolved: false,
  format: "markdown",
  notice: "",
  page,
  scrollX: 0,
  scrollY: 0,
  feedbackEnabled: false,
  sending: false,
  maybeRetrySubmission: Option.none(),
  feedback: [],
});
export const pageAnnotations = (model: Model) =>
  model.annotations.filter((a) => a.target.page === model.page);
export const openAnnotations = (model: Model) => pageAnnotations(model).filter((a) => !a.resolved);
export const annotationTargets = (annotation: Annotation): readonly Target[] =>
  annotation.targets?.length ? annotation.targets : [annotation.target];
export const targetKey = (target: Target) =>
  `${JSON.stringify(target.path ?? [])}:${target.selector}:${target.page}:${target.framePage ?? ""}`;
