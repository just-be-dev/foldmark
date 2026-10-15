import * as Schema from "effect/Schema";
import { Runtime, type Update } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { mountFoldmark, annotate } from "../src";
import "./style.css";

const Model = Schema.Struct({ completed: Schema.Array(Schema.String), tab: Schema.String });
type Model = typeof Model.Type;
const Message = defineMessageUnion({
  ClickedTask: { id: Schema.String },
  ClickedTab: { tab: Schema.String },
});
type Message = typeof Message.Type;
const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    ClickedTask: ({ id }) => ({
      model: {
        ...model,
        completed: model.completed.includes(id)
          ? model.completed.filter((item) => item !== id)
          : [...model.completed, id],
      },
    }),
    ClickedTab: ({ tab }) => ({ model: { ...model, tab } }),
  });
const tasks = [
  {
    id: "type",
    name: "Explore a quieter type scale",
    tag: "Design",
    initials: "JL",
    color: "lavender",
  },
  {
    id: "space",
    name: "Give the cards room to breathe",
    tag: "Interface",
    initials: "AK",
    color: "peach",
  },
  {
    id: "copy",
    name: "Make the empty state more human",
    tag: "Content",
    initials: "RM",
    color: "sage",
  },
];
function view(model: Model, h: HtmlBuilder<Message>) {
  const context = (modelPath: string, message?: string) =>
    annotate(h, { source: "demo/main.ts:view", modelPath, message });
  return h.div(
    [],
    [
      h.header(
        [h.Class("site-header")],
        [
          h.a(
            [h.Class("logo"), h.Href("#")],
            [
              h.span([h.Class("logo-icon")], ["ƒ"]),
              "foldmark",
              h.span([h.Class("beta")], ["EARLY PREVIEW"]),
            ],
          ),
          h.nav(
            [h.AriaLabel("Main navigation")],
            [
              h.a([h.Href("#playground")], ["Playground"]),
              h.a([h.Href("#integration")], ["Integration"]),
              h.a(
                [h.Href("https://foldkit.dev/"), h.Target("_blank"), h.Rel("noopener noreferrer")],
                ["Built for Foldkit ↗"],
              ),
            ],
          ),
        ],
      ),
      h.main(
        [],
        [
          h.section(
            [h.Class("hero")],
            [
              h.div(
                [h.Class("hero-copy")],
                [
                  h.div(
                    [h.Class("eyebrow")],
                    [h.span([h.Class("live-dot")]), "VISUAL FEEDBACK, IN THE UPDATE LOOP"],
                  ),
                  h.h1([], ["A clearer way", h.br([]), "to ", h.em([], ["point."])]),
                  h.p(
                    [h.Class("intro")],
                    [
                      "See something? Leave a mark. Turn the details you notice into precise, useful context for your coding agent.",
                    ],
                  ),
                  h.a(
                    [h.Class("hero-link"), h.Href("#playground")],
                    ["Try it on the playground", h.span([], ["↓"])],
                  ),
                ],
              ),
              h.div(
                [
                  h.Class("hero-visual"),
                  h.AriaLabel("From a selected element to structured feedback"),
                ],
                [
                  h.div([h.Class("orbit orbit-one")]),
                  h.div([h.Class("orbit orbit-two")]),
                  h.div([h.Class("visual-caption")], ["A SMALL MARK. A SHARED UNDERSTANDING."]),
                  h.div(
                    [h.Class("specimen")],
                    [
                      h.span([h.Class("specimen-tag")], ["button.primary"]),
                      h.div(
                        [h.Class("specimen-button")],
                        ["Let’s make this better", h.span([], ["↗"])],
                      ),
                      h.span([h.Class("specimen-pin")], ["1"]),
                    ],
                  ),
                  h.div(
                    [h.Class("floating-note")],
                    [
                      h.div(
                        [h.Class("note-top")],
                        [
                          h.span([h.Class("tiny-mark")], ["ƒ"]),
                          "A note with context",
                          h.span([h.Class("tiny-dot")]),
                        ],
                      ),
                      h.p([], ["“A little more breathing room here.”"]),
                      h.div(
                        [h.Class("note-meta")],
                        [
                          h.span([], ["view"]),
                          h.code([], ["Checkout.view"]),
                          h.span([], ["→ agent"]),
                        ],
                      ),
                    ],
                  ),
                  h.div(
                    [h.Class("visual-bottom")],
                    [
                      h.span([], ["SELECT"]),
                      h.span([], ["→"]),
                      h.span([], ["ANNOTATE"]),
                      h.span([], ["→"]),
                      h.span([], ["EXPORT"]),
                    ],
                  ),
                ],
              ),
            ],
          ),
          h.section(
            [h.Id("playground"), h.Class("playground")],
            [
              h.div(
                [h.Class("section-heading")],
                [
                  h.div(
                    [],
                    [
                      h.div([h.Class("eyebrow")], ["01 / THE PLAYGROUND"]),
                      h.h2([], ["Good feedback starts with a detail."]),
                    ],
                  ),
                  h.p(
                    [],
                    [
                      "An actual Foldkit app. Turn on Inspect",
                      h.br([]),
                      "in the toolbar, then pick something below.",
                    ],
                  ),
                ],
              ),
              h.div(
                [h.Class("workspace")],
                [
                  h.aside(
                    [h.Class("sidebar")],
                    [
                      h.div([h.Class("workspace-brand")], [h.span([], ["◈"]), "Fieldwork"]),
                      h.div([h.Class("workspace-label")], ["STUDIO WORKSPACE"]),
                      ...["Overview", "Projects", "Notes"].map((tab) =>
                        h.button(
                          [
                            h.Type("button"),
                            h.Class(`nav-item${model.tab === tab ? " current" : ""}`),
                            h.OnClick(Message.ClickedTab({ tab })),
                            ...context("tab", "ClickedTab"),
                          ],
                          [
                            h.span([], [tab === "Overview" ? "▦" : tab === "Projects" ? "◇" : "≡"]),
                            tab,
                          ],
                        ),
                      ),
                      h.div(
                        [h.Class("sidebar-bottom")],
                        [
                          h.span([h.Class("avatar sage")], ["S"]),
                          h.div([], ["Studio team", h.small([], ["A space for good work"])]),
                        ],
                      ),
                    ],
                  ),
                  h.div(
                    [h.Class("workspace-main")],
                    [
                      h.div(
                        [h.Class("workspace-top")],
                        [
                          h.span([], ["Workspace / ", h.strong([], [model.tab])]),
                          h.span([h.Class("avatar lavender")], ["JL"]),
                        ],
                      ),
                      h.div(
                        [h.Class("workspace-title")],
                        [
                          h.div(
                            [],
                            [
                              h.p([h.Class("date")], ["MONDAY, AT YOUR OWN PACE"]),
                              h.h3(
                                [...context("tab")],
                                [
                                  model.tab === "Overview"
                                    ? "Room for good ideas."
                                    : model.tab === "Projects"
                                      ? "Work taking shape."
                                      : "Things worth remembering.",
                                ],
                              ),
                            ],
                          ),
                          h.span([h.Class("pill")], ["↗ This week"]),
                        ],
                      ),
                      h.div(
                        [h.Class("stats")],
                        [
                          h.article(
                            [h.Class("stat-card"), ...context("completed")],
                            [
                              h.span([h.Class("stat-label")], ["A LITTLE PROGRESS"]),
                              h.div(
                                [h.Class("stat-number")],
                                [
                                  String(model.completed.length).padStart(2, "0"),
                                  h.small([], ["/ 03"]),
                                ],
                              ),
                              h.p([], ["Small steps still move you forward."]),
                              h.div(
                                [h.Class("progress-track")],
                                [
                                  h.div([
                                    h.Style({ width: `${(model.completed.length / 3) * 100}%` }),
                                  ]),
                                ],
                              ),
                            ],
                          ),
                          h.article(
                            [h.Class("quote-card")],
                            [
                              h.span([h.Class("sparkle")], ["✳"]),
                              h.p(
                                [],
                                [
                                  "Leave things a little",
                                  h.br([]),
                                  h.em([], ["better than you found them."]),
                                ],
                              ),
                              h.span([h.Class("quote-caption")], ["A NOTE TO OURSELVES"]),
                            ],
                          ),
                        ],
                      ),
                      h.div(
                        [h.Class("task-heading")],
                        [
                          h.h4(
                            [],
                            [model.tab === "Notes" ? "Notes to explore" : "On the drawing board"],
                          ),
                          h.span([], ["03 ITEMS"]),
                        ],
                      ),
                      h.div(
                        [h.Class("task-list")],
                        tasks.map((task) =>
                          h.keyed("div")(
                            task.id,
                            [h.Class("task-row")],
                            [
                              h.button(
                                [
                                  h.Type("button"),
                                  h.Class(
                                    `task-check${model.completed.includes(task.id) ? " checked" : ""}`,
                                  ),
                                  h.AriaLabel(`Complete ${task.name}`),
                                  h.AriaPressed(String(model.completed.includes(task.id))),
                                  h.DataAttribute("testid", `task-${task.id}`),
                                  h.OnClick(Message.ClickedTask({ id: task.id })),
                                  ...context("completed", "ClickedTask"),
                                ],
                                [model.completed.includes(task.id) ? "✓" : ""],
                              ),
                              h.span(
                                [
                                  h.Class(
                                    `task-name${model.completed.includes(task.id) ? " done" : ""}`,
                                  ),
                                ],
                                [task.name],
                              ),
                              h.span([h.Class("task-tag")], [task.tag]),
                              h.span([h.Class(`avatar ${task.color}`)], [task.initials]),
                            ],
                          ),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
              h.div(
                [h.Class("playground-footer")],
                [
                  h.span([], ["◉ Live, not a screenshot"]),
                  h.span([], ["Your notes stay in this browser. Nothing is sent automatically."]),
                ],
              ),
            ],
          ),
          h.section(
            [h.Id("integration"), h.Class("integration")],
            [
              h.div(
                [],
                [
                  h.div([h.Class("eyebrow")], ["02 / MADE FOR YOUR STACK"]),
                  h.h2([], ["One mount.", h.br([]), "A much shorter conversation."]),
                  h.p(
                    [],
                    [
                      "A Foldkit runtime with its own model, messages, and commands. Add source hints where they help. Give your agent the context it needs.",
                    ],
                  ),
                ],
              ),
              h.div(
                [h.Class("code-card")],
                [
                  h.div(
                    [h.Class("code-heading")],
                    [h.span([], ["entry.ts"]), h.span([], ["FOLDKIT + EFFECT"])],
                  ),
                  h.pre(
                    [],
                    [
                      h.code(
                        [],
                        [
                          "import { mountFoldmark } from 'foldmark'\n\nconst feedback = mountFoldmark({\n  enabled: import.meta.env.DEV,\n})\n\nimport.meta.hot?.dispose(() => {\n  feedback.dispose()\n})",
                        ],
                      ),
                    ],
                  ),
                  h.div([h.Class("code-footer")], ["Model → Message → Update → View"]),
                ],
              ),
            ],
          ),
        ],
      ),
      h.footer(
        [h.Class("site-footer")],
        [
          h.span([h.Class("logo")], [h.span([h.Class("logo-icon")], ["ƒ"]), "foldmark"]),
          h.span([], ["Less describing. More understanding."]),
          h.span([], ["An independent project for Foldkit."]),
        ],
      ),
    ],
  );
}
const app = Runtime.embed(
  Runtime.makeElement({
    Model,
    init: () => ({ model: { completed: [], tab: "Overview" } }),
    update,
    view,
    container: document.getElementById("app"),
  }),
);
const feedback = mountFoldmark();
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    feedback.dispose();
    app.dispose();
  });
