import type { HtmlBuilder } from 'foldkit/html'
import { Message, type Model, openAnnotations, pageAnnotations } from './model'
import { toJson, toMarkdown } from './report'

export function view(m: Model, h: HtmlBuilder<Message>) {
  const button = (label: string, message: Message, className = '', disabled = false) =>
    h.button(
      [h.Type('button'), h.Class(className), h.OnClick(message), h.Disabled(disabled)],
      [label],
    )
  const open = openAnnotations(m)
  const all = pageAnnotations(m)
  const target = m.draft ?? m.hover
  const header = (title: string, sub: string, close: Message = Message.ClickedClosePanel()) =>
    h.div(
      [h.Class('panel-heading')],
      [
        h.div([], [h.h2([], [title]), h.p([h.Class('muted')], [sub])]),
        h.button(
          [h.Type('button'), h.Class('icon-button'), h.AriaLabel('Close panel'), h.OnClick(close)],
          ['×'],
        ),
      ],
    )
  return h.div(
    [h.Class('foldmark')],
    [
      ...(target && m.active
        ? [
            h.div(
              [
                h.Class('highlight'),
                h.AriaHidden(true),
                h.Style({
                  left: `${target.rect.x - m.scrollX}px`,
                  top: `${target.rect.y - m.scrollY}px`,
                  width: `${target.rect.width}px`,
                  height: `${target.rect.height}px`,
                }),
              ],
              [h.span([h.Class('target-label')], [target.selector.slice(0, 70)])],
            ),
          ]
        : []),
      ...(m.active
        ? open.map((a, i) =>
            h.button(
              [
                h.Type('button'),
                h.Class('pin'),
                h.AriaLabel(`Edit annotation ${i + 1}`),
                h.Title(a.note),
                h.Style({
                  left: `${a.target.rect.x - m.scrollX - 10}px`,
                  top: `${a.target.rect.y - m.scrollY - 10}px`,
                }),
                h.OnClick(Message.ClickedEdit({ id: a.id })),
              ],
              [String(i + 1)],
            ),
          )
        : []),
      ...(m.draft
        ? [
            h.section(
              [h.Class('panel composer'), h.Role('dialog'), h.AriaLabel('Annotate element')],
              [
                header(
                  m.editingId ? 'Edit feedback' : 'Leave a mark',
                  'A little context goes a long way.',
                  Message.CancelledDraft(),
                ),
                h.div(
                  [h.Class('target-context')],
                  [
                    h.span([h.Class('eyebrow')], ['SELECTED ELEMENT']),
                    h.code([], [m.draft.selector]),
                    ...(m.draft.source ? [h.p([h.Class('source')], [m.draft.source])] : []),
                    ...(m.draft.modelPath
                      ? [h.p([h.Class('muted')], [`Model · ${m.draft.modelPath}`])]
                      : []),
                    ...(m.draft.message
                      ? [h.p([h.Class('muted')], [`Message · ${m.draft.message}`])]
                      : []),
                  ],
                ),
                h.label([h.For('foldmark-note')], ['What should change?']),
                h.textarea([
                  h.Id('foldmark-note'),
                  h.Rows(5),
                  h.Value(m.note),
                  h.Placeholder('Describe the change and why it matters…'),
                  h.OnInput((note) => Message.ChangedNote({ note })),
                  h.Attribute('maxlength', '4000'),
                ]),
                h.div(
                  [h.Class('row actions')],
                  [
                    h.span([h.Class('muted')], ['⌘ / Ctrl + Enter to save']),
                    button('Save note ↗', Message.ClickedSave(), 'primary', !m.note.trim()),
                  ],
                ),
              ],
            ),
          ]
        : []),
      ...(m.panel === 'notes'
        ? [
            h.section(
              [h.Class('panel'), h.AriaLabel('Feedback notes')],
              [
                header('Your marks', `${open.length} open · ${all.length} total on this page`),
                h.div(
                  [h.Class('row filter-row')],
                  [
                    h.span([h.Class('eyebrow')], ['FEEDBACK']),
                    button(
                      m.showResolved ? 'Show open' : 'Include resolved',
                      Message.ClickedFilter(),
                      'text-button',
                    ),
                  ],
                ),
                h.div(
                  [h.Class('notes-list')],
                  [
                    ...all
                      .filter((a) => m.showResolved || !a.resolved)
                      .map((a, i) =>
                        h.article(
                          [h.Class(`note-card${a.resolved ? ' resolved' : ''}`)],
                          [
                            h.div(
                              [h.Class('row')],
                              [
                                h.span([h.Class('note-number')], [String(i + 1).padStart(2, '0')]),
                                h.code([], [a.target.selector]),
                              ],
                            ),
                            h.p([h.Class('note-text')], [a.note]),
                            ...(a.target.source
                              ? [h.p([h.Class('source')], [a.target.source])]
                              : []),
                            h.div(
                              [h.Class('note-actions')],
                              [
                                button('Edit', Message.ClickedEdit({ id: a.id }), 'text-button'),
                                button(
                                  a.resolved ? 'Reopen' : 'Resolve',
                                  Message.ClickedResolve({ id: a.id }),
                                  'text-button',
                                ),
                                button(
                                  'Delete',
                                  Message.ClickedDelete({ id: a.id }),
                                  'text-button danger',
                                ),
                              ],
                            ),
                          ],
                        ),
                      ),
                    ...(all.filter((a) => m.showResolved || !a.resolved).length === 0
                      ? [
                          h.div(
                            [h.Class('empty')],
                            [
                              h.div([h.Class('empty-symbol')], ['⌖']),
                              h.h3([], ['A fresh perspective starts here.']),
                              h.p(
                                [],
                                [
                                  'Turn on inspect, then click anything on the page to leave feedback.',
                                ],
                              ),
                            ],
                          ),
                        ]
                      : []),
                  ],
                ),
                button(
                  'Export feedback ↗',
                  Message.ClickedExport(),
                  'primary full',
                  open.length === 0,
                ),
              ],
            ),
          ]
        : []),
      ...(m.panel === 'export'
        ? [
            h.section(
              [h.Class('panel export'), h.AriaLabel('Export feedback')],
              [
                header(
                  'From seeing to shipping.',
                  `${open.length} open note${open.length === 1 ? '' : 's'} · ready for your agent`,
                ),
                h.div(
                  [h.Class('tabs')],
                  [
                    button(
                      'Markdown',
                      Message.ChangedFormat({ format: 'markdown' }),
                      m.format === 'markdown' ? 'selected' : '',
                    ),
                    button(
                      'JSON',
                      Message.ChangedFormat({ format: 'json' }),
                      m.format === 'json' ? 'selected' : '',
                    ),
                  ],
                ),
                h.textarea([
                  h.Class('report'),
                  h.AriaLabel('Feedback report'),
                  h.Attribute('readonly', ''),
                  h.Rows(13),
                  h.Value((m.format === 'markdown' ? toMarkdown : toJson)(open)),
                ]),
                h.p(
                  [h.Class('muted')],
                  [
                    'Includes selectors, notes, and explicit Foldkit context. Review before sharing.',
                  ],
                ),
                h.div(
                  [h.Class('row actions')],
                  [
                    button('Download', Message.ClickedDownload(), 'secondary'),
                    button('Copy report ↗', Message.ClickedCopy(), 'primary'),
                  ],
                ),
              ],
            ),
          ]
        : []),
      h.div(
        [h.Class('dock-wrap')],
        [
          ...(m.notice
            ? [h.div([h.Class('notice'), h.Role('status'), h.AriaLive('polite')], [m.notice])]
            : []),
          ...(m.active && !m.draft && m.panel === 'closed'
            ? [
                h.div(
                  [h.Class('hint')],
                  ['Click an element to annotate', h.span([], ['Esc to exit'])],
                ),
              ]
            : []),
          h.div(
            [h.Class('dock'), h.Role('toolbar'), h.AriaLabel('Foldmark toolbar')],
            [
              h.span([h.Class('brand-mark'), h.Title('Foldmark')], ['ƒ']),
              h.button(
                [
                  h.Type('button'),
                  h.Class(`inspect${m.active ? ' active' : ''}`),
                  h.AriaPressed(String(m.active)),
                  h.OnClick(Message.ClickedToggle()),
                  h.Title('Toggle inspect · Alt+Shift+A'),
                ],
                [m.active ? '⌖ Inspecting' : '⌖ Inspect'],
              ),
              h.span([h.Class('divider')], []),
              button(
                `Notes ${open.length}`,
                Message.ClickedNotes(),
                m.panel === 'notes' ? 'selected' : '',
              ),
              h.button(
                [
                  h.Type('button'),
                  h.Class('pause'),
                  h.AriaPressed(String(m.paused)),
                  h.AriaLabel(m.paused ? 'Resume animations' : 'Pause animations'),
                  h.OnClick(Message.ClickedPause()),
                ],
                [m.paused ? '▶' : 'Ⅱ'],
              ),
              button('Export ↗', Message.ClickedExport(), 'export-button', open.length === 0),
            ],
          ),
        ],
      ),
    ],
  )
}
