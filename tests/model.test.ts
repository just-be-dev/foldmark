import { describe, expect, test } from 'vitest'
import * as Schema from 'effect/Schema'
import {
  initialModel,
  Message,
  SavedSession,
  openAnnotations,
  type Annotation,
  type Target,
} from '../src/model'
import { makeUpdate } from '../src/update'
import { toJson, toMarkdown } from '../src/report'

const target: Target = {
  selector: '#save',
  tag: 'button',
  text: 'Save',
  selectedText: '',
  source: 'src/editor.ts:view',
  modelPath: 'editor.draft',
  message: 'ClickedSave',
  rect: { x: 10, y: 20, width: 80, height: 30 },
  font: '400 14px sans-serif',
  color: 'black',
  background: 'white',
  page: 'https://app.test/',
  title: 'Editor',
  viewport: '1440×900',
}
const annotation: Annotation = {
  id: 'one',
  target,
  note: 'Increase the spacing',
  resolved: false,
  createdAt: '2026-10-04T00:00:00Z',
}
const { update } = makeUpdate({ save() {}, copy: async () => {}, download() {} })
describe('annotation workflow', () => {
  test('requires inspect mode and ignores selection while composing', () => {
    const initial = initialModel(target.page)
    expect(update(initial, Message.SelectedTarget({ target })).model.draft).toBeNull()
    const active = update(initial, Message.ClickedToggle()).model
    const selected = update(active, Message.SelectedTarget({ target })).model
    const changed = { ...target, selector: '#another' }
    expect(update(selected, Message.SelectedTarget({ target: changed })).model.draft).toEqual(
      target,
    )
    expect(update(selected, Message.ClickedSave()).commands).toBeUndefined()
  })
  test('editing preserves capture context and identity', () => {
    const initial = initialModel(target.page, [annotation])
    const result = update(
      initial,
      Message.PreparedAnnotation({
        target,
        note: 'Edited',
        id: 'unused',
        createdAt: 'unused',
        editingId: 'one',
      }),
    ).model
    expect(result.annotations).toEqual([{ ...annotation, note: 'Edited' }])
  })
  test('resolve, reopen, and delete preserve other pages', () => {
    const other = {
      ...annotation,
      id: 'two',
      target: { ...target, page: 'https://app.test/other' },
    }
    const initial = initialModel(target.page, [annotation, other])
    const resolved = update(initial, Message.ClickedResolve({ id: 'one' })).model
    expect(openAnnotations(resolved)).toHaveLength(0)
    const reopened = update(resolved, Message.ClickedResolve({ id: 'one' })).model
    expect(openAnnotations(reopened)).toHaveLength(1)
    expect(update(reopened, Message.ClickedDelete({ id: 'one' })).model.annotations).toEqual([
      other,
    ])
  })
  test('route changes cancel stale drafts but keep notes', () => {
    const initial = {
      ...initialModel(target.page, [annotation]),
      active: true,
      draft: target,
      note: 'Unfinished',
    }
    const changed = update(initial, Message.ChangedPage({ page: 'https://app.test/other' })).model
    expect(changed.draft).toBeNull()
    expect(openAnnotations(changed)).toHaveLength(0)
    expect(changed.annotations).toEqual([annotation])
  })
  test('escape cancels draft first, then leaves inspect mode', () => {
    const initial = { ...initialModel(target.page), active: true, draft: target }
    const first = update(initial, Message.PressedEscape()).model
    expect(first.active).toBe(true)
    expect(first.draft).toBeNull()
    expect(update(first, Message.PressedEscape()).model.active).toBe(false)
  })
})
describe('agent reports and persistence boundaries', () => {
  test('exports selectors and explicit Foldkit context', () => {
    const markdown = toMarkdown([annotation])
    for (const value of [
      '#save',
      'src/editor.ts:view',
      'editor.draft',
      'ClickedSave',
      '> Increase the spacing',
    ])
      expect(markdown).toContain(value)
    expect(JSON.parse(toJson([annotation])).annotations).toEqual([annotation])
  })
  test('rejects corrupt or incompatible persisted data', () => {
    const decode = Schema.decodeUnknownSync(SavedSession)
    expect(decode({ version: 1, annotations: [annotation] }).annotations).toHaveLength(1)
    expect(() => decode({ version: 2, annotations: [] })).toThrow()
    expect(() =>
      decode({
        version: 1,
        annotations: [
          { ...annotation, target: { ...target, rect: { ...target.rect, x: Infinity } } },
        ],
      }),
    ).toThrow()
  })
})
