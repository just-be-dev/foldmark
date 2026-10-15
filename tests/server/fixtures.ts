import type { Annotation } from '../../src/model'
export const annotation: Annotation = {
  id: 'note-one',
  target: {
    selector: '#save',
    tag: 'button',
    text: 'Save',
    selectedText: '',
    source: 'src/checkout.ts:42',
    modelPath: 'checkout',
    message: 'ClickedSave',
    rect: { x: 10, y: 20, width: 80, height: 30 },
    font: '14px sans-serif',
    color: 'black',
    background: 'white',
    page: 'http://localhost:5173/',
    title: 'Checkout',
    viewport: '1440×900',
  },
  note: 'Add more space above this button.',
  resolved: false,
  createdAt: '2026-10-01T00:00:00.000Z',
}
export const submission = (requestId = 'request-one') => ({
  version: 1 as const,
  requestId,
  annotations: [annotation],
})
export const token = 'test_pairing_token_with_at_least_32_characters'
export const deferred = <T = void>() => {
  let resolve: (value: T | PromiseLike<T>) => void = () => {}
  let reject: (reason?: unknown) => void = () => {}
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
