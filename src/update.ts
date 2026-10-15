import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import * as Crypto from "effect/Crypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Port, type Update } from "foldkit";
import type { SourceContext } from "./capture";
import {
  Annotation,
  type CapturedImage,
  FeedbackSummary,
  Model,
  Screenshot,
  Target,
  Theme,
  annotationTargets,
  openAnnotations,
  targetKey,
} from "./model";
import { Message } from "./message";
import { toJson, toMarkdown } from "./report";

export const ports = {
  inbound: { event: Port.inbound(Message) },
  outbound: { state: Port.outbound(Model) },
};
export interface Operations {
  save: (annotations: readonly Annotation[], theme?: Theme) => string | void;
  copy: (text: string) => Promise<void>;
  download: (text: string, format: "markdown" | "json") => void;
  screenshot?: (targets: readonly Target[]) => Promise<CapturedImage>;
  resolveSource?: (target: Target) => Promise<SourceContext>;
  submit?: (annotations: readonly Annotation[], requestId: string) => Promise<FeedbackSummary>;
}
const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;
class ScreenshotCaptureError extends Schema.TaggedError<ScreenshotCaptureError>()(
  "ScreenshotCaptureError",
  { message: Schema.String },
) {}
const clearDraft = (m: Model): Model => ({
  ...m,
  maybeDraft: Option.none(),
  draftTargets: [],
  maybeDraftScreenshot: Option.none(),
  screenshotState: "idle",
  maybeEditingId: Option.none(),
  note: "",
  selection: [],
  maybeArea: Option.none(),
  maybeHover: Option.none(),
  revision: m.revision + 1,
  maybePendingSaveRevision: Option.none(),
});
const historyLimit = 30;
const mergeFeedback = (
  existing: readonly FeedbackSummary[],
  incoming: readonly FeedbackSummary[],
) => {
  const values = new Map(existing.map((item) => [item.id, item]));
  for (const item of incoming) {
    const previous = values.get(item.id);
    if (
      !previous ||
      item.revision > previous.revision ||
      (item.revision === previous.revision && item.updatedAt > previous.updatedAt)
    )
      values.set(item.id, item);
  }
  return [...values.values()];
};

export function makeUpdate(operations: Operations) {
  const SyncState = Command.define("SyncState", {
    args: { state: Model },
    messages: [Message.CompletedSync],
    execute: ({ state }) =>
      Port.emit(ports.outbound.state, state).pipe(Effect.as(Message.CompletedSync())),
  });
  const PersistSession = Command.define("PersistSession", {
    args: { annotations: Schema.Array(Annotation), theme: Theme },
    messages: [Message.CompletedOperation],
    execute: ({ annotations, theme }) =>
      Effect.try(() => operations.save(annotations, theme)).pipe(
        Effect.match({
          onSuccess: (notice) => Message.CompletedOperation({ notice: notice || "Saved" }),
          onFailure: () =>
            Message.CompletedOperation({
              notice: "Storage unavailable. Export your notes to keep them.",
            }),
        }),
      ),
  });
  const PrepareAnnotation = Command.define("PrepareAnnotation", {
    args: {
      target: Target,
      targets: Schema.Array(Target),
      note: Schema.String,
      editingId: Schema.NullOr(Schema.String),
      screenshot: Schema.NullOr(Screenshot),
      revision: Schema.Int,
    },
    messages: [Message.PreparedAnnotation, Message.CompletedOperation],
    execute: (args) =>
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        const id = yield* crypto.randomUUIDv4;
        const now = yield* Clock.currentTimeMillis;
        return Message.PreparedAnnotation({ ...args, id, createdAt: new Date(now).toISOString() });
      }).pipe(
        Effect.provide(BrowserCrypto.layer),
        Effect.catch(() =>
          Effect.succeed(Message.CompletedOperation({ notice: "Could not save the note." })),
        ),
      ),
  });
  const ResolveSource = Command.define("ResolveSource", {
    args: { target: Target, revision: Schema.Int },
    messages: [Message.ResolvedSource, Message.CompletedOperation],
    execute: ({ target, revision }) =>
      Effect.tryPromise(async () => {
        const context = await operations.resolveSource?.(target);
        return Message.ResolvedSource({
          revision,
          selector: targetKey(target),
          source: context?.source ?? target.source,
          modelPath: context?.modelPath ?? target.modelPath,
          message: context?.message ?? target.message,
        });
      }).pipe(
        Effect.catch(() =>
          Effect.succeed(
            Message.CompletedOperation({
              notice: "Source mapping unavailable; captured hints are retained.",
            }),
          ),
        ),
      ),
  });
  const CaptureScreenshot = Command.define("CaptureScreenshot", {
    args: { targets: Schema.Array(Target), revision: Schema.Int },
    messages: [Message.CompletedScreenshot, Message.FailedScreenshot],
    execute: ({ targets, revision }) =>
      Effect.tryPromise({
        try: async () => {
          if (!operations.screenshot) throw new Error("Screenshot capture is unavailable");
          return await operations.screenshot(targets);
        },
        catch: (error) =>
          new ScreenshotCaptureError({
            message: errorMessage(error, "Screenshot failed. Your note has not changed."),
          }),
      }).pipe(
        Effect.flatMap((image) =>
          Effect.map(Clock.currentTimeMillis, (now) => ({
            ...image,
            capturedAt: new Date(now).toISOString(),
          })),
        ),
        Effect.match({
          onSuccess: (screenshot) => Message.CompletedScreenshot({ revision, screenshot }),
          onFailure: (error) =>
            Message.FailedScreenshot({
              revision,
              notice: error.message,
            }),
        }),
      ),
  });
  const submissionFailedNotice = "Could not send feedback. Your notes are local; retry to send.";
  const SubmitFeedback = Command.define("SubmitFeedback", {
    args: {
      annotations: Schema.Array(Annotation),
      contentKey: Schema.String,
      maybeRequestId: Schema.Option(Schema.String),
    },
    messages: [Message.SubmittedFeedback, Message.FailedSubmission],
    execute: ({ annotations, contentKey, maybeRequestId }) =>
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        const requestId = yield* Option.match(maybeRequestId, {
          onNone: () => crypto.randomUUIDv4,
          onSome: (id) => Effect.succeed(id),
        });
        return yield* Effect.tryPromise(async () => {
          if (!operations.submit) throw new Error("Feedback server is not configured");
          return await operations.submit(annotations, requestId);
        }).pipe(
          Effect.match({
            onSuccess: (feedback) => Message.SubmittedFeedback({ feedback }),
            onFailure: () =>
              Message.FailedSubmission({
                notice: submissionFailedNotice,
                maybeRetry: Option.some({ requestId, contentKey }),
              }),
          }),
        );
      }).pipe(
        Effect.provide(BrowserCrypto.layer),
        Effect.catch(() =>
          Effect.succeed(
            Message.FailedSubmission({ notice: submissionFailedNotice, maybeRetry: Option.none() }),
          ),
        ),
      ),
  });
  const CopyReport = Command.define("CopyReport", {
    args: { text: Schema.String },
    messages: [Message.CompletedOperation],
    execute: ({ text }) =>
      Effect.tryPromise(() => operations.copy(text)).pipe(
        Effect.match({
          onSuccess: () => Message.CompletedOperation({ notice: "Copied. Ready for your agent." }),
          onFailure: () =>
            Message.CompletedOperation({
              notice: "Clipboard unavailable. Select the report or download it.",
            }),
        }),
      ),
  });
  const DownloadReport = Command.define("DownloadReport", {
    args: { text: Schema.String, format: Schema.Literals(["markdown", "json"]) },
    messages: [Message.CompletedOperation],
    execute: ({ text, format }) =>
      Effect.try(() => operations.download(text, format)).pipe(
        Effect.match({
          onSuccess: () => Message.CompletedOperation({ notice: "Report downloaded" }),
          onFailure: () =>
            Message.CompletedOperation({
              notice: "Download failed. Select the report to copy it.",
            }),
        }),
      ),
  });
  const persist = (m: Model) => PersistSession({ annotations: m.annotations, theme: m.theme });
  const commit = (m: Model, annotations: readonly Annotation[]): Update.Return<Model, Message> => {
    const model = {
      ...clearDraft(m),
      annotations,
      past: [...m.past, m.annotations].slice(-historyLimit),
      future: [],
    };
    return { model, commands: [persist(model)] };
  };
  const sourceCommands = (targets: readonly Target[], revision: number) =>
    operations.resolveSource ? targets.map((target) => ResolveSource({ target, revision })) : [];
  const compose = (m: Model, targets: readonly Target[]): Update.Return<Model, Message> => {
    const first = targets[0];
    if (!first) return { model: m };
    const model = {
      ...clearDraft(m),
      maybeDraft: Option.some(first),
      draftTargets: targets,
      panel: "closed" as const,
      notice: "",
    };
    return { model, commands: sourceCommands(targets, model.revision) };
  };
  const report = (m: Model) => (m.format === "markdown" ? toMarkdown : toJson)(openAnnotations(m));
  const reduce = (m: Model, msg: Message): Update.Return<Model, Message> =>
    Message.match<Update.Return<Model, Message>>(msg, {
      ClickedToggle: () => ({
        model: { ...clearDraft(m), active: !m.active, notice: "" },
      }),
      HoveredTarget: ({ target }) => ({
        model:
          m.active && Option.isNone(m.maybeDraft) && Option.isNone(m.maybeArea)
            ? { ...m, maybeHover: Option.fromNullOr(target) }
            : m,
      }),
      SelectedTarget: ({ target }) => {
        if (!m.active || Option.isSome(m.maybeDraft) || m.screenshotState === "capturing")
          return { model: m };
        if (m.selectionMode !== "multi") return compose(m, [target]);
        const exists = m.selection.some((t) => targetKey(t) === targetKey(target));
        const selection = exists
          ? m.selection.filter((t) => targetKey(t) !== targetKey(target))
          : [...m.selection, target].slice(0, 100);
        return { model: { ...m, selection, maybeHover: Option.none(), notice: "" } };
      },
      ChangedSelectionMode: ({ mode }) => ({
        model: { ...clearDraft(m), active: true, selectionMode: mode, panel: "closed" },
      }),
      DraggedArea: ({ rect }) => ({
        model:
          m.active && Option.isNone(m.maybeDraft) && m.selectionMode === "area"
            ? { ...m, maybeArea: Option.fromNullOr(rect), maybeHover: Option.none() }
            : m,
      }),
      ClickedComposeSelection: () =>
        m.active && Option.isNone(m.maybeDraft) ? compose(m, m.selection) : { model: m },
      ClickedClearSelection: () => ({
        model: { ...m, selection: [], maybeArea: Option.none(), maybeHover: Option.none() },
      }),
      ChangedNote: ({ note }) => ({ model: { ...m, note: note.slice(0, 4000) } }),
      CancelledDraft: () => ({ model: clearDraft(m) }),
      ClickedSave: () =>
        Option.match(m.maybeDraft, {
          onNone: () => ({ model: m }),
          onSome: (draft) => {
            if (!m.note.trim() || m.screenshotState === "capturing") return { model: m };
            const revision = m.revision + 1;
            return {
              model: {
                ...clearDraft(m),
                maybePendingSaveRevision: Option.some(revision),
                panel: "notes",
              },
              commands: [
                PrepareAnnotation({
                  target: draft,
                  targets: m.draftTargets.length ? m.draftTargets : [draft],
                  note: m.note.trim(),
                  editingId: Option.getOrNull(m.maybeEditingId),
                  screenshot: Option.getOrNull(m.maybeDraftScreenshot),
                  revision,
                }),
              ],
            };
          },
        }),
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
        if (
          revision !== undefined &&
          !Option.exists(m.maybePendingSaveRevision, (pending) => pending === revision)
        )
          return { model: m };
        if (editingId && !m.annotations.some((a) => a.id === editingId)) return { model: m };
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
            ];
        // Keep exact optional-property semantics: removal is absence, not an undefined value.
        const clean = annotations.map((a) => {
          if (a.screenshot !== undefined) return a;
          const { screenshot: _removed, ...rest } = a;
          return rest;
        });
        return commit(m, clean);
      },
      ClickedEdit: ({ id }) => {
        const annotation = m.annotations.find((a) => a.id === id);
        return {
          model: annotation
            ? {
                ...clearDraft(m),
                maybeDraft: Option.some(annotation.target),
                draftTargets: annotationTargets(annotation),
                maybeDraftScreenshot: Option.fromUndefinedOr(annotation.screenshot),
                maybeEditingId: Option.some(id),
                note: annotation.note,
                panel: "closed",
              }
            : m,
        };
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
        const annotations = m.past.at(-1);
        if (!annotations) return { model: m };
        const model = {
          ...clearDraft(m),
          annotations,
          past: m.past.slice(0, -1),
          future: [m.annotations, ...m.future].slice(0, historyLimit),
          notice: "Undone",
        };
        return { model, commands: [persist(model)] };
      },
      ClickedRedo: () => {
        const annotations = m.future[0];
        if (!annotations) return { model: m };
        const model = {
          ...clearDraft(m),
          annotations,
          past: [...m.past, m.annotations].slice(-historyLimit),
          future: m.future.slice(1),
          notice: "Redone",
        };
        return { model, commands: [persist(model)] };
      },
      ClickedNotes: () => ({
        model: { ...clearDraft(m), panel: m.panel === "notes" ? "closed" : "notes" },
      }),
      ClickedExport: () => ({ model: { ...clearDraft(m), panel: "export", notice: "" } }),
      ClickedSettings: () => ({
        model: { ...clearDraft(m), panel: m.panel === "settings" ? "closed" : "settings" },
      }),
      ChangedTheme: ({ theme }) => {
        const model = { ...m, theme };
        return { model, commands: [persist(model)] };
      },
      ClickedClosePanel: () => ({ model: { ...m, panel: "closed" } }),
      ClickedFilter: () => ({ model: { ...m, showResolved: !m.showResolved } }),
      ChangedFormat: ({ format }) => ({ model: { ...m, format, notice: "" } }),
      ClickedCopy: () => ({ model: m, commands: [CopyReport({ text: report(m) })] }),
      ClickedDownload: () => ({
        model: m,
        commands: [DownloadReport({ text: report(m), format: m.format })],
      }),
      ClickedPause: () => ({ model: { ...m, paused: !m.paused } }),
      ClickedScreenshot: () =>
        Option.match(m.maybeDraft, {
          onNone: () => ({ model: m }),
          onSome: (draft) =>
            m.screenshotState === "idle"
              ? {
                  model: {
                    ...m,
                    screenshotState: "capturing",
                    notice: "Choose this tab to attach a redacted screenshot.",
                  },
                  commands: [
                    CaptureScreenshot({
                      targets: m.draftTargets.length ? m.draftTargets : [draft],
                      revision: m.revision,
                    }),
                  ],
                }
              : { model: m },
        }),
      CompletedScreenshot: ({ revision, screenshot }) => ({
        model:
          Option.isSome(m.maybeDraft) &&
          revision === m.revision &&
          m.screenshotState === "capturing"
            ? {
                ...m,
                maybeDraftScreenshot: Option.some(screenshot),
                screenshotState: "idle",
                notice: "Screenshot attached. Review it before sharing.",
              }
            : m,
      }),
      FailedScreenshot: ({ revision, notice }) => ({
        model: revision === m.revision ? { ...m, screenshotState: "idle", notice } : m,
      }),
      ClickedRemoveScreenshot: () => ({ model: { ...m, maybeDraftScreenshot: Option.none() } }),
      ResolvedSource: ({ revision, selector, source, modelPath, message }) => {
        if (Option.isNone(m.maybeDraft) || revision !== m.revision) return { model: m };
        const mapped = (target: Target) =>
          targetKey(target) === selector ? { ...target, source, modelPath, message } : target;
        return {
          model: {
            ...m,
            maybeDraft: Option.map(m.maybeDraft, mapped),
            draftTargets: m.draftTargets.map(mapped),
          },
        };
      },
      ClickedSend: () => {
        const annotations = openAnnotations(m);
        if (!m.feedbackEnabled || m.sending || !annotations.length) return { model: m };
        const contentKey = JSON.stringify(annotations);
        return {
          model: { ...m, sending: true, notice: "" },
          commands: [
            SubmitFeedback({
              annotations,
              contentKey,
              maybeRequestId: Option.flatMap(m.maybeRetrySubmission, (retry) =>
                retry.contentKey === contentKey ? Option.some(retry.requestId) : Option.none(),
              ),
            }),
          ],
        };
      },
      SubmittedFeedback: ({ feedback }) => ({
        model: {
          ...m,
          sending: false,
          maybeRetrySubmission: Option.none(),
          feedback: mergeFeedback(m.feedback, [feedback]),
          notice: "Feedback sent. The agent can now read this request.",
        },
      }),
      FailedSubmission: ({ notice, maybeRetry }) => ({
        model: { ...m, sending: false, notice, maybeRetrySubmission: maybeRetry },
      }),
      ReceivedFeedback: ({ feedback }) => ({
        model: { ...m, feedback: mergeFeedback(m.feedback, feedback) },
      }),
      PressedEscape: () => ({
        model: {
          ...clearDraft(m),
          panel: "closed",
          active:
            Option.isSome(m.maybeDraft) || m.selection.length || Option.isSome(m.maybeArea)
              ? m.active
              : false,
        },
      }),
      ChangedPage: ({ page }) => ({ model: { ...clearDraft(m), page, livePins: [] } }),
      ScrolledPage: ({ x, y }) => ({
        model: { ...m, scrollX: x, scrollY: y, maybeHover: Option.none() },
      }),
      TrackedPins: ({ pins, draft }) => ({
        model: {
          ...m,
          livePins: pins,
          maybeDraft:
            draft === null
              ? m.maybeDraft
              : Option.map(m.maybeDraft, (target) => ({ ...target, rect: draft })),
        },
      }),
      CompletedOperation: ({ notice }) => ({ model: { ...m, notice } }),
      CompletedSync: () => ({ model: m }),
    });
  const update = (model: Model, message: Message): Update.Return<Model, Message> => {
    const result = reduce(model, message);
    if (result.model === model) return result;
    const next = { ...result.model, sequence: model.sequence + 1 };
    return {
      ...result,
      model: next,
      commands: [...(result.commands ?? []), SyncState({ state: next })],
    };
  };
  return { update, report };
}
