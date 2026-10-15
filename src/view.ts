import * as Option from "effect/Option";
import type { HtmlBuilder } from "foldkit/html";
import { Message } from "./message";
import { type Model, type Rect, openAnnotations, pageAnnotations } from "./model";
import { toJson, toMarkdown } from "./report";

export function view(m: Model, h: HtmlBuilder<Message>) {
  const button = (label: string, message: Message, className = "", disabled = false) =>
    h.button(
      [h.Type("button"), h.Class(className), h.OnClick(message), h.Disabled(disabled)],
      [label],
    );
  const option = (label: string, message: Message, selected: boolean) =>
    h.button(
      [
        h.Type("button"),
        h.Class(selected ? "selected" : ""),
        h.AriaPressed(String(selected)),
        h.OnClick(message),
      ],
      [label],
    );
  const open = openAnnotations(m);
  const all = pageAnnotations(m);
  const maybeTarget = Option.orElse(m.maybeDraft, () => m.maybeHover);
  const box = (rect: Rect) => ({
    left: `${rect.x - m.scrollX}px`,
    top: `${rect.y - m.scrollY}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  });
  const highlight = (rect: Rect, label: string, className = "") =>
    h.div(
      [h.Class(`highlight ${className}`), h.AriaHidden(true), h.Style(box(rect))],
      [h.span([h.Class("target-label")], [label.slice(0, 70)])],
    );
  const header = (title: string, sub: string, close: Message = Message.ClickedClosePanel()) =>
    h.div(
      [h.Class("panel-heading")],
      [
        h.div([], [h.h2([], [title]), h.p([h.Class("muted")], [sub])]),
        h.button(
          [h.Type("button"), h.Class("icon-button"), h.AriaLabel("Close panel"), h.OnClick(close)],
          ["×"],
        ),
      ],
    );
  const feedback = m.feedback.filter((item) => item.page === m.page);
  const send = () =>
    button(
      m.sending ? "Sending…" : "Send to agent",
      Message.ClickedSend(),
      "primary full",
      m.sending || !open.length,
    );
  const feedbackStatus = () =>
    h.div(
      [
        h.Class("feedback-status"),
        h.Role("region"),
        h.AriaLabel("Agent requests"),
        h.AriaLive("polite"),
      ],
      feedback.length
        ? feedback
            .slice(-5)
            .reverse()
            .map((item) =>
              h.keyed("div")(
                item.id,
                [h.Class(`request-status status-${item.status}`)],
                [
                  h.strong(
                    [],
                    [
                      item.status === "claimed"
                        ? "Agent working"
                        : item.status[0]?.toUpperCase() + item.status.slice(1),
                    ],
                  ),
                  h.code([], [item.id.slice(0, 12)]),
                  ...(item.message ? [h.p([], [item.message])] : []),
                ],
              ),
            )
        : [
            h.p(
              [h.Class("muted")],
              ["Nothing sent. Notes stay local until you choose Send to agent."],
            ),
          ],
    );
  return h.div(
    [h.Class("foldmark"), h.DataAttribute("theme", m.theme)],
    [
      ...(m.active
        ? Option.match(maybeTarget, {
            onNone: () => [],
            onSome: (target) => [highlight(target.rect, target.selector)],
          })
        : []),
      ...(m.active
        ? m.selection.map((selected, index) =>
            highlight(selected.rect, `Selected ${index + 1}`, "selection-highlight"),
          )
        : []),
      ...(m.active
        ? Option.match(m.maybeArea, {
            onNone: () => [],
            onSome: (area) => [highlight(area, "Area selection", "area-highlight")],
          })
        : []),
      ...(m.active
        ? open.flatMap((a, i) => {
            const pin = m.livePins.find((item) => item.id === a.id);
            if (pin?.rect === null) return [];
            const rect = pin?.rect ?? a.target.rect;
            return [
              h.button(
                [
                  h.Type("button"),
                  h.Class(`pin${pin?.detached ? " detached" : ""}`),
                  h.AriaLabel(`Edit annotation ${i + 1}`),
                  h.Title(
                    pin?.detached ? `${a.note} · Some selected elements are detached` : a.note,
                  ),
                  h.Style({
                    left: `${rect.x - m.scrollX - 10}px`,
                    top: `${rect.y - m.scrollY - 10}px`,
                  }),
                  h.OnClick(Message.ClickedEdit({ id: a.id })),
                ],
                [String(i + 1)],
              ),
            ];
          })
        : []),
      ...Option.match(m.maybeDraft, {
        onNone: () => [],
        onSome: (draft) => [
          h.section(
            [
              h.Class("panel composer"),
              h.Role("dialog"),
              h.AriaLabel("Annotate element"),
              h.AriaBusy(m.screenshotState === "capturing"),
            ],
            [
              header(
                Option.isSome(m.maybeEditingId) ? "Edit feedback" : "Leave a mark",
                "A little context goes a long way.",
                Message.CancelledDraft(),
              ),
              h.div(
                [h.Class("target-context")],
                [
                  h.span(
                    [h.Class("eyebrow")],
                    [
                      m.draftTargets.length > 1
                        ? `${m.draftTargets.length} SELECTED ELEMENTS`
                        : draft.kind === "area"
                          ? "SELECTED AREA"
                          : "SELECTED ELEMENT",
                    ],
                  ),
                  h.code([], [draft.selector]),
                  ...(m.draftTargets.length > 1
                    ? m.draftTargets.slice(1).map((selected) => h.code([], [selected.selector]))
                    : []),
                  ...(draft.path?.length
                    ? [
                        h.p(
                          [h.Class("muted")],
                          [draft.path.map((part) => `${part.kind}: ${part.selector}`).join(" → ")],
                        ),
                      ]
                    : []),
                  ...(draft.source ? [h.p([h.Class("source")], [draft.source])] : []),
                  ...(draft.modelPath
                    ? [h.p([h.Class("muted")], [`Model · ${draft.modelPath}`])]
                    : []),
                  ...(draft.message
                    ? [h.p([h.Class("muted")], [`Message · ${draft.message}`])]
                    : []),
                ],
              ),
              h.label([h.For("foldmark-note")], ["What should change?"]),
              h.textarea([
                h.Id("foldmark-note"),
                h.Rows(5),
                h.Value(m.note),
                h.Placeholder("Describe the change and why it matters…"),
                h.OnInput((note) => Message.ChangedNote({ note })),
                h.Attribute("maxlength", "4000"),
              ]),
              ...Option.match(m.maybeDraftScreenshot, {
                onNone: () => [],
                onSome: (screenshot) => [
                  h.div(
                    [h.Class("screenshot-preview")],
                    [
                      h.img([h.Src(screenshot.dataUrl), h.Alt("Redacted screenshot attachment")]),
                      button("Remove screenshot", Message.ClickedRemoveScreenshot(), "text-button"),
                    ],
                  ),
                ],
              }),
              button(
                m.screenshotState === "capturing"
                  ? "Capturing…"
                  : Option.isSome(m.maybeDraftScreenshot)
                    ? "Replace screenshot"
                    : "Attach screenshot",
                Message.ClickedScreenshot(),
                "secondary full",
                m.screenshotState === "capturing",
              ),
              h.p(
                [h.Class("muted screenshot-help")],
                [
                  "Optional. Captures only the visible selection after consent; private regions, forms, and embedded frames are masked.",
                ],
              ),
              h.div(
                [h.Class("row actions")],
                [
                  h.span([h.Class("muted")], ["⌘ / Ctrl + Enter to save"]),
                  button(
                    "Save note ↗",
                    Message.ClickedSave(),
                    "primary",
                    !m.note.trim() || m.screenshotState === "capturing",
                  ),
                ],
              ),
            ],
          ),
        ],
      }),
      ...(m.panel === "notes"
        ? [
            h.section(
              [h.Class("panel"), h.AriaLabel("Feedback notes")],
              [
                header("Your marks", `${open.length} open · ${all.length} total on this page`),
                h.div(
                  [h.Class("row filter-row")],
                  [
                    h.span([h.Class("eyebrow")], ["FEEDBACK"]),
                    button(
                      m.showResolved ? "Show open" : "Include resolved",
                      Message.ClickedFilter(),
                      "text-button",
                    ),
                  ],
                ),
                h.div(
                  [h.Class("notes-list")],
                  [
                    ...all
                      .filter((a) => m.showResolved || !a.resolved)
                      .map((a, i) => {
                        const pin = m.livePins.find((item) => item.id === a.id);
                        return h.keyed("article")(
                          a.id,
                          [h.Class(`note-card${a.resolved ? " resolved" : ""}`)],
                          [
                            h.div(
                              [h.Class("row")],
                              [
                                h.span([h.Class("note-number")], [String(i + 1).padStart(2, "0")]),
                                h.code([], [a.target.selector]),
                              ],
                            ),
                            h.p([h.Class("note-text")], [a.note]),
                            ...(a.targets?.length
                              ? [
                                  h.p(
                                    [h.Class("muted")],
                                    [`${a.targets.length} elements in this mark`],
                                  ),
                                ]
                              : []),
                            ...(a.target.kind === "area"
                              ? [
                                  h.p(
                                    [h.Class("muted")],
                                    [
                                      "Area coordinates are fixed to this document, not an element.",
                                    ],
                                  ),
                                ]
                              : []),
                            ...(pin?.detached
                              ? [
                                  h.p(
                                    [h.Class("detached-label")],
                                    ["Target detached or no longer accessible"],
                                  ),
                                ]
                              : []),
                            ...(a.target.source
                              ? [h.p([h.Class("source")], [a.target.source])]
                              : []),
                            ...(a.screenshot
                              ? [
                                  h.img([
                                    h.Class("note-screenshot"),
                                    h.Src(a.screenshot.dataUrl),
                                    h.Alt("Redacted screenshot attachment"),
                                  ]),
                                ]
                              : []),
                            h.div(
                              [h.Class("note-actions")],
                              [
                                button("Edit", Message.ClickedEdit({ id: a.id }), "text-button"),
                                button(
                                  a.resolved ? "Reopen" : "Resolve",
                                  Message.ClickedResolve({ id: a.id }),
                                  "text-button",
                                ),
                                button(
                                  "Delete",
                                  Message.ClickedDelete({ id: a.id }),
                                  "text-button danger",
                                ),
                              ],
                            ),
                          ],
                        );
                      }),
                    ...(all.filter((a) => m.showResolved || !a.resolved).length === 0
                      ? [
                          h.div(
                            [h.Class("empty")],
                            [
                              h.div([h.Class("empty-symbol")], ["⌖"]),
                              h.h3([], ["A fresh perspective starts here."]),
                              h.p(
                                [],
                                [
                                  "Turn on inspect, then click anything on the page to leave feedback.",
                                ],
                              ),
                            ],
                          ),
                        ]
                      : []),
                  ],
                ),
                button("Export feedback ↗", Message.ClickedExport(), "primary full", !open.length),
                ...(m.feedbackEnabled ? [send(), feedbackStatus()] : []),
              ],
            ),
          ]
        : []),
      ...(m.panel === "export"
        ? [
            h.section(
              [h.Class("panel export"), h.AriaLabel("Export feedback")],
              [
                header(
                  "From seeing to shipping.",
                  `${open.length} open note${open.length === 1 ? "" : "s"} · ready for your agent`,
                ),
                h.div(
                  [h.Class("tabs")],
                  [
                    button(
                      "Markdown",
                      Message.ChangedFormat({ format: "markdown" }),
                      m.format === "markdown" ? "selected" : "",
                    ),
                    button(
                      "JSON",
                      Message.ChangedFormat({ format: "json" }),
                      m.format === "json" ? "selected" : "",
                    ),
                  ],
                ),
                h.textarea([
                  h.Class("report"),
                  h.AriaLabel("Feedback report"),
                  h.Attribute("readonly", ""),
                  h.Rows(13),
                  h.Value((m.format === "markdown" ? toMarkdown : toJson)(open)),
                ]),
                h.p(
                  [h.Class("muted")],
                  [
                    "Includes selectors, notes, source hints, and any attached images. Review before sharing.",
                  ],
                ),
                h.div(
                  [h.Class("row actions")],
                  [
                    button("Download", Message.ClickedDownload(), "secondary"),
                    button("Copy report ↗", Message.ClickedCopy(), "primary"),
                  ],
                ),
                ...(m.feedbackEnabled ? [send(), feedbackStatus()] : []),
              ],
            ),
          ]
        : []),
      ...(m.panel === "settings"
        ? [
            h.section(
              [h.Class("panel settings"), h.AriaLabel("Foldmark options")],
              [
                header("Make it yours.", "Selection, appearance, and recent changes."),
                h.h3([], ["Selection mode"]),
                h.div(
                  [h.Class("options-row")],
                  [
                    option(
                      "Single element",
                      Message.ChangedSelectionMode({ mode: "element" }),
                      m.selectionMode === "element",
                    ),
                    option(
                      "Select multiple",
                      Message.ChangedSelectionMode({ mode: "multi" }),
                      m.selectionMode === "multi",
                    ),
                    option(
                      "Select area",
                      Message.ChangedSelectionMode({ mode: "area" }),
                      m.selectionMode === "area",
                    ),
                  ],
                ),
                h.p(
                  [h.Class("muted")],
                  [
                    "Multi-select toggles elements by click. Area mode creates a fixed document rectangle by dragging.",
                  ],
                ),
                h.h3([], ["Appearance"]),
                h.div(
                  [h.Class("options-row")],
                  [
                    option(
                      "System theme",
                      Message.ChangedTheme({ theme: "system" }),
                      m.theme === "system",
                    ),
                    option(
                      "Light theme",
                      Message.ChangedTheme({ theme: "light" }),
                      m.theme === "light",
                    ),
                    option(
                      "Dark theme",
                      Message.ChangedTheme({ theme: "dark" }),
                      m.theme === "dark",
                    ),
                  ],
                ),
                h.h3([], ["Annotation history"]),
                h.div(
                  [h.Class("options-row")],
                  [
                    button("Undo", Message.ClickedUndo(), "secondary", !m.past.length),
                    button("Redo", Message.ClickedRedo(), "secondary", !m.future.length),
                  ],
                ),
                h.p(
                  [h.Class("muted")],
                  ["Up to 30 changes in this session. Undo/redo also updates saved notes."],
                ),
                ...(m.feedbackEnabled ? [h.h3([], ["Agent connection"]), feedbackStatus()] : []),
              ],
            ),
          ]
        : []),
      ...(m.active &&
      m.selectionMode === "multi" &&
      Option.isNone(m.maybeDraft) &&
      m.selection.length
        ? [
            h.section(
              [h.Class("selection-bar"), h.AriaLabel("Selected elements")],
              [
                h.span([], [`${m.selection.length} selected`]),
                button("Clear selection", Message.ClickedClearSelection(), "text-button"),
                button("Annotate selection", Message.ClickedComposeSelection(), "primary"),
              ],
            ),
          ]
        : []),
      h.div(
        [h.Class("dock-wrap")],
        [
          ...(m.notice
            ? [h.div([h.Class("notice"), h.Role("status"), h.AriaLive("polite")], [m.notice])]
            : []),
          ...(m.active && Option.isNone(m.maybeDraft) && m.panel === "closed"
            ? [
                h.div(
                  [h.Class("hint")],
                  [
                    m.selectionMode === "multi"
                      ? "Click elements, then annotate selection"
                      : m.selectionMode === "area"
                        ? "Drag an area to annotate"
                        : "Click an element to annotate",
                    h.span([], ["Esc to exit"]),
                  ],
                ),
              ]
            : []),
          h.div(
            [h.Class("dock"), h.Role("toolbar"), h.AriaLabel("Foldmark toolbar")],
            [
              h.span([h.Class("brand-mark"), h.Title("Foldmark")], ["ƒ"]),
              h.button(
                [
                  h.Type("button"),
                  h.Class(`inspect${m.active ? " active" : ""}`),
                  h.AriaPressed(String(m.active)),
                  h.OnClick(Message.ClickedToggle()),
                  h.Title("Toggle inspect · Alt+Shift+A"),
                ],
                [m.active ? "⌖ Inspecting" : "⌖ Inspect"],
              ),
              h.span([h.Class("divider")]),
              button(
                `Notes ${open.length}`,
                Message.ClickedNotes(),
                m.panel === "notes" ? "selected" : "",
              ),
              h.button(
                [
                  h.Type("button"),
                  h.Class("pause"),
                  h.AriaPressed(String(m.paused)),
                  h.AriaLabel(m.paused ? "Resume animations" : "Pause animations"),
                  h.OnClick(Message.ClickedPause()),
                ],
                [m.paused ? "▶" : "Ⅱ"],
              ),
              h.button(
                [
                  h.Type("button"),
                  h.Class(m.panel === "settings" ? "selected" : ""),
                  h.AriaLabel("Foldmark options"),
                  h.OnClick(Message.ClickedSettings()),
                  h.Title("Selection, theme, undo and redo"),
                ],
                ["⚙"],
              ),
              button("Export ↗", Message.ClickedExport(), "export-button", !open.length),
            ],
          ),
        ],
      ),
    ],
  );
}
