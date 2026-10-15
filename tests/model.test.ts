import { describe, expect, test } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  initialModel,
  SavedSession,
  openAnnotations,
  type Annotation,
  type Target,
} from "../src/model";
import { Message } from "../src/message";
import { makeUpdate } from "../src/update";
import { toJson, toMarkdown } from "../src/report";

const target: Target = {
  selector: "#save",
  tag: "button",
  text: "Save",
  selectedText: "",
  source: "src/editor.ts:view",
  modelPath: "editor.draft",
  message: "ClickedSave",
  rect: { x: 10, y: 20, width: 80, height: 30 },
  font: "400 14px sans-serif",
  color: "black",
  background: "white",
  page: "https://app.test/",
  title: "Editor",
  viewport: "1440×900",
};
const annotation: Annotation = {
  id: "one",
  target,
  note: "Increase the spacing",
  resolved: false,
  createdAt: "2026-10-04T00:00:00Z",
};
const { update } = makeUpdate({ save() {}, copy: async () => {}, download() {} });
describe("annotation workflow", () => {
  test("requires inspect mode and ignores selection while composing", () => {
    const initial = initialModel(target.page);
    expect(
      Option.isNone(update(initial, Message.SelectedTarget({ target })).model.maybeDraft),
    ).toBe(true);
    const active = update(initial, Message.ClickedToggle()).model;
    const selected = update(active, Message.SelectedTarget({ target })).model;
    const changed = { ...target, selector: "#another" };
    expect(update(selected, Message.SelectedTarget({ target: changed })).model.maybeDraft).toEqual(
      Option.some(target),
    );
    expect(update(selected, Message.ClickedSave()).commands).toBeUndefined();
  });
  test("editing preserves capture context and identity", () => {
    const initial = initialModel(target.page, [annotation]);
    const result = update(
      initial,
      Message.PreparedAnnotation({
        target,
        note: "Edited",
        id: "unused",
        createdAt: "unused",
        editingId: "one",
      }),
    ).model;
    expect(result.annotations).toEqual([{ ...annotation, note: "Edited" }]);
  });
  test("resolve, reopen, and delete preserve other pages", () => {
    const other = {
      ...annotation,
      id: "two",
      target: { ...target, page: "https://app.test/other" },
    };
    const initial = initialModel(target.page, [annotation, other]);
    const resolved = update(initial, Message.ClickedResolve({ id: "one" })).model;
    expect(openAnnotations(resolved)).toHaveLength(0);
    const reopened = update(resolved, Message.ClickedResolve({ id: "one" })).model;
    expect(openAnnotations(reopened)).toHaveLength(1);
    expect(update(reopened, Message.ClickedDelete({ id: "one" })).model.annotations).toEqual([
      other,
    ]);
  });
  test("route changes cancel stale drafts but keep notes", () => {
    const initial = {
      ...initialModel(target.page, [annotation]),
      active: true,
      maybeDraft: Option.some(target),
      note: "Unfinished",
    };
    const changed = update(initial, Message.ChangedPage({ page: "https://app.test/other" })).model;
    expect(Option.isNone(changed.maybeDraft)).toBe(true);
    expect(openAnnotations(changed)).toHaveLength(0);
    expect(changed.annotations).toEqual([annotation]);
  });
  test("escape cancels draft first, then leaves inspect mode", () => {
    const initial = { ...initialModel(target.page), active: true, maybeDraft: Option.some(target) };
    const first = update(initial, Message.PressedEscape()).model;
    expect(first.active).toBe(true);
    expect(Option.isNone(first.maybeDraft)).toBe(true);
    expect(update(first, Message.PressedEscape()).model.active).toBe(false);
  });
});
describe("agent reports and persistence boundaries", () => {
  test("exports selectors and explicit Foldkit context", () => {
    const markdown = toMarkdown([annotation]);
    for (const value of [
      "#save",
      "src/editor.ts:view",
      "editor.draft",
      "ClickedSave",
      "> Increase the spacing",
    ])
      expect(markdown).toContain(value);
    expect(JSON.parse(toJson([annotation])).annotations).toEqual([annotation]);
  });
  test("rejects corrupt or incompatible persisted data", () => {
    const decode = Schema.decodeUnknownSync(SavedSession);
    expect(decode({ version: 1, annotations: [annotation] }).annotations).toHaveLength(1);
    expect(() => decode({ version: 2, annotations: [] })).toThrow();
    expect(() =>
      decode({
        version: 1,
        annotations: [
          { ...annotation, target: { ...target, rect: { ...target.rect, x: Infinity } } },
        ],
      }),
    ).toThrow();
  });
});

describe("history, grouped captures, and client features", () => {
  test("undo and redo cover create/edit/resolve/delete and persist snapshots", () => {
    let model = initialModel(target.page);
    model = update(
      model,
      Message.PreparedAnnotation({
        target,
        note: "New",
        id: "new",
        createdAt: "now",
        editingId: null,
      }),
    ).model;
    expect(model.annotations).toHaveLength(1);
    model = update(model, Message.ClickedResolve({ id: "new" })).model;
    expect(model.annotations[0]?.resolved).toBe(true);
    const undone = update(model, Message.ClickedUndo());
    expect(undone.model.annotations[0]?.resolved).toBe(false);
    expect(undone.commands?.some((command) => command.name === "PersistSession")).toBe(true);
    model = update(undone.model, Message.ClickedRedo()).model;
    expect(model.annotations[0]?.resolved).toBe(true);
    model = update(model, Message.ClickedDelete({ id: "new" })).model;
    expect(model.annotations).toHaveLength(0);
    model = update(model, Message.ClickedUndo()).model;
    expect(model.annotations[0]?.note).toBe("New");
    model = update(
      model,
      Message.PreparedAnnotation({
        target,
        note: "Edited",
        id: "unused",
        createdAt: "unused",
        editingId: "new",
      }),
    ).model;
    expect(model.future).toHaveLength(0);
    expect(model.annotations[0]?.id).toBe("new");
    expect(update(model, Message.ClickedUndo()).model.annotations[0]?.note).toBe("New");
  });
  test("history is bounded and undo clears stale composer state", () => {
    let model = initialModel(target.page, [annotation]);
    for (let i = 0; i < 45; i++)
      model = update(model, Message.ClickedResolve({ id: annotation.id })).model;
    expect(model.past).toHaveLength(30);
    model = update(model, Message.ClickedEdit({ id: annotation.id })).model;
    const undone = update(model, Message.ClickedUndo()).model;
    expect(Option.isNone(undone.maybeDraft)).toBe(true);
    expect(Option.isNone(undone.maybeEditingId)).toBe(true);
    expect(undone.note).toBe("");
  });
  test("multi-select toggles by root-aware identity and composes a grouped note", () => {
    let model = update(
      initialModel(target.page),
      Message.ChangedSelectionMode({ mode: "multi" }),
    ).model;
    const shadow = { ...target, path: [{ kind: "shadow" as const, selector: "#host" }] };
    model = update(model, Message.SelectedTarget({ target })).model;
    model = update(model, Message.SelectedTarget({ target: shadow })).model;
    expect(model.selection).toHaveLength(2);
    expect(Option.isNone(model.maybeDraft)).toBe(true);
    model = update(model, Message.SelectedTarget({ target })).model;
    expect(model.selection).toEqual([shadow]);
    model = update(model, Message.SelectedTarget({ target })).model;
    const composed = update(model, Message.ClickedComposeSelection()).model;
    expect(composed.draftTargets).toEqual([shadow, target]);
    expect(composed.selection).toHaveLength(0);
    const saved = update(
      composed,
      Message.PreparedAnnotation({
        target: shadow,
        targets: [shadow, target],
        note: "Align these",
        id: "group",
        createdAt: "now",
        editingId: null,
      }),
    ).model;
    expect(saved.annotations[0]?.targets).toHaveLength(2);
  });
  test("an async save cannot recreate notes after route changes", async () => {
    const { runPromise } = await import("effect/Effect");
    let model = update(initialModel(target.page), Message.ClickedToggle()).model;
    model = update(model, Message.SelectedTarget({ target })).model;
    model = update(model, Message.ChangedNote({ note: "Pending" })).model;
    const saving = update(model, Message.ClickedSave());
    const prepare = saving.commands?.find((command) => command.name === "PrepareAnnotation");
    expect(prepare).toBeDefined();
    if (!prepare) throw new Error("Missing prepare command");
    const prepared = await runPromise(prepare.effect);
    const changed = update(
      saving.model,
      Message.ChangedPage({ page: "https://app.test/other" }),
    ).model;
    expect(update(changed, prepared).model.annotations).toHaveLength(0);
  });
  test("late screenshots and source lookup cannot attach to a replacement draft", () => {
    let model = update(initialModel(target.page), Message.ClickedToggle()).model;
    model = update(model, Message.SelectedTarget({ target })).model;
    const revision = model.revision;
    model = update(model, Message.CancelledDraft()).model;
    model = update(
      model,
      Message.SelectedTarget({ target: { ...target, selector: "#next" } }),
    ).model;
    model = update(model, Message.FailedScreenshot({ revision, notice: "Old error" })).model;
    expect(model.notice).not.toBe("Old error");
    model = update(
      model,
      Message.ResolvedSource({
        revision,
        selector: target.selector,
        source: "stale.ts:1",
        modelPath: "",
        message: "",
      }),
    ).model;
    expect(Option.getOrUndefined(model.maybeDraft)?.source).not.toBe("stale.ts:1");
  });
  test("themes are persisted without adding an annotation history entry", () => {
    const changed = update(
      initialModel(target.page, [annotation]),
      Message.ChangedTheme({ theme: "dark" }),
    );
    expect(changed.model.theme).toBe("dark");
    expect(changed.model.past).toHaveLength(0);
    expect(
      changed.commands?.find((command) => command.name === "PersistSession")?.args,
    ).toMatchObject({ theme: "dark" });
    const decode = Schema.decodeUnknownSync(SavedSession);
    expect(decode({ version: 1, annotations: [annotation] }).theme).toBeUndefined();
    expect(decode({ version: 1, annotations: [annotation], theme: "dark" }).theme).toBe("dark");
  });
  test("submission is opt-in and scoped to open notes on the current route", () => {
    const other = {
      ...annotation,
      id: "other",
      target: { ...target, page: "https://app.test/other" },
    };
    const model = initialModel(target.page, [annotation, other]);
    expect(update(model, Message.ClickedSend()).commands).toBeUndefined();
    const sending = update({ ...model, feedbackEnabled: true }, Message.ClickedSend());
    expect(sending.model.sending).toBe(true);
    expect(sending.commands?.find((command) => command.name === "SubmitFeedback")?.args).toEqual({
      annotations: [annotation],
      contentKey: JSON.stringify([annotation]),
      maybeRequestId: Option.none(),
    });
    expect(update(sending.model, Message.ClickedSend()).commands).toBeUndefined();
  });
  test("a failed submission reuses its request id only while the same notes are resent", () => {
    const model = { ...initialModel(target.page, [annotation]), feedbackEnabled: true };
    const contentKey = JSON.stringify([annotation]);
    const failed = update(
      { ...model, sending: true },
      Message.FailedSubmission({
        notice: "Could not send",
        maybeRetry: Option.some({ requestId: "retry-id", contentKey }),
      }),
    ).model;
    const submitArgs = (state: typeof model) =>
      update(state, Message.ClickedSend()).commands?.find(
        (command) => command.name === "SubmitFeedback",
      )?.args;
    expect(submitArgs(failed)).toMatchObject({ maybeRequestId: Option.some("retry-id") });
    const edited = { ...failed, annotations: [{ ...annotation, note: "Changed note" }] };
    expect(submitArgs(edited)).toMatchObject({ maybeRequestId: Option.none() });
    const sent = update(
      { ...failed, sending: true },
      Message.SubmittedFeedback({
        feedback: {
          id: "retry-id",
          revision: 1,
          status: "pending",
          page: target.page,
          message: "",
          updatedAt: "2026-10-15T00:00:00Z",
        },
      }),
    ).model;
    expect(Option.isNone(sent.maybeRetrySubmission)).toBe(true);
  });
  test("saved target paths and screenshot schemas remain strict and backwards compatible", async () => {
    const { Screenshot } = await import("../src/model");
    expect(() =>
      Schema.decodeUnknownSync(Screenshot)({
        dataUrl: "data:image/svg+xml;base64,AAA=",
        width: 10,
        height: 10,
        capturedAt: "now",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(Screenshot)({
        dataUrl: "data:image/png;base64,AAA=",
        width: 2000,
        height: 10,
        capturedAt: "now",
      }),
    ).toThrow();
    const decode = Schema.decodeUnknownSync(SavedSession);
    const captured = {
      ...annotation,
      target: {
        ...target,
        path: [
          { kind: "frame", selector: "#preview" },
          { kind: "shadow", selector: "#editor" },
        ],
      },
    };
    expect(
      decode({ version: 1, annotations: [captured] }).annotations[0]?.target.path,
    ).toHaveLength(2);
  });
});

test("feedback updates merge by revision without dropping new requests or regressing completion", () => {
  const completed = {
    id: "old",
    revision: 3,
    status: "completed" as const,
    page: target.page,
    message: "Done",
    updatedAt: "2026-10-15T00:03:00Z",
  };
  const pending = {
    id: "new",
    revision: 1,
    status: "pending" as const,
    page: target.page,
    message: "",
    updatedAt: "2026-10-15T00:04:00Z",
  };
  const current = { ...initialModel(target.page), feedback: [completed, pending] };
  const stale = {
    ...completed,
    revision: 1,
    status: "pending" as const,
    updatedAt: "2026-10-15T00:01:00Z",
  };
  const merged = update(current, Message.ReceivedFeedback({ feedback: [stale] })).model;
  expect(merged.feedback).toEqual([completed, pending]);
  const staleSubmission = update(merged, Message.SubmittedFeedback({ feedback: stale })).model;
  expect(staleSubmission.feedback).toEqual([completed, pending]);
});
