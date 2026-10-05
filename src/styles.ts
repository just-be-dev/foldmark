export const styles = `
:host { all: initial; position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; color-scheme: light; }
* { box-sizing: border-box; }
.foldmark { color: #26382f; font: 13px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
button, textarea { font: inherit; }
button { cursor: pointer; border: 0; background: transparent; color: inherit; border-radius: 8px; padding: 9px 12px; transition: background .15s; }
button:hover { background: #edf1eb; }
button:disabled { opacity: .4; cursor: not-allowed; }
button:focus-visible, textarea:focus-visible { outline: 3px solid #b6d481; outline-offset: 3px; }
h2,h3,p { margin: 0; }
h2 { font-size: 20px; font-weight: 600; letter-spacing: -.6px; }
h3 { font-size: 15px; font-weight: 550; }
code { font: 11px/1.6 ui-monospace, SFMono-Regular, monospace; overflow-wrap: anywhere; }
.dock-wrap { position: fixed; right: 28px; bottom: 24px; display: flex; flex-direction: column; align-items: flex-end; gap: 10px; max-width: calc(100vw - 24px); }
.dock { pointer-events: auto; display: flex; align-items: center; gap: 3px; padding: 6px; background: #fffef9; border: 1px solid #d9dfd4; border-radius: 14px; box-shadow: 0 4px 8px #1b322c0a, 0 12px 48px #1b322c24; }
.brand-mark { font: italic 26px Georgia, serif; padding: 0 12px; color: #46604b; }
.dock button { font-size: 12px; font-weight: 550; white-space: nowrap; }
.inspect.active { background: #e3edcc; color: #344b20; }
.divider { width: 1px; height: 22px; background: #e2e7de; margin: 0 4px; }
.dock .export-button { background: #243e31; color: #fffef9; margin-left: 4px; }
.dock .export-button:hover { background: #3a5646; }
.selected { background: #edf1e7; }
.hint, .notice { padding: 9px 14px; border: 1px solid #d9dfd4; background: #fffef9; border-radius: 10px; box-shadow: 0 3px 16px #233b2710; max-width: 400px; }
.hint span { margin-left: 18px; font-size: 11px; color: #7b8279; }
.notice { position: fixed; top: 18px; right: 28px; max-width: calc(100vw - 24px); color: #4d653b; pointer-events: auto; }
.panel { position: fixed; pointer-events: auto; bottom: 94px; right: 28px; width: 380px; max-width: calc(100vw - 24px); max-height: calc(100dvh - 120px); overflow: auto; padding: 22px; background: #fffef9; border: 1px solid #d9dfd4; border-radius: 18px; box-shadow: 0 18px 70px #182f242b; }
.panel-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 21px; }
.panel-heading p { margin-top: 4px; }
.icon-button { font-size: 24px; padding: 0 7px; line-height: 1.2; }
.muted { color: #7a8379; font-size: 11px; }
.eyebrow { font-size: 9px; letter-spacing: 1.7px; font-weight: 650; color: #7a8379; }
.target-context { padding: 13px 15px; border-radius: 10px; background: #f0f3e9; margin-bottom: 18px; display: flex; flex-direction: column; gap: 5px; }
.source { font: 10px/1.5 ui-monospace, monospace; color: #718060; overflow-wrap: anywhere; }
label { display: block; font-weight: 550; margin-bottom: 8px; }
textarea { display: block; resize: vertical; width: 100%; padding: 12px; border: 1px solid #d3dccb; border-radius: 10px; background: #fff; color: #26382f; line-height: 1.6; }
textarea::placeholder { color: #a0a69b; }
.row { display: flex; align-items: center; gap: 10px; justify-content: space-between; }
.actions { margin-top: 16px; }
.primary { background: #263f32; color: #fffef9; font-weight: 550; }
.primary:hover { background: #3c5944; }
.secondary { border: 1px solid #d3dccb; }
.full { width: 100%; margin-top: 16px; }
.filter-row { margin: -5px 0 10px; }
.text-button { padding: 4px 6px; font-size: 11px; color: #6c7d61; }
.danger { color: #a16c60; margin-left: auto; }
.note-card { padding: 15px 0; border-top: 1px solid #e6e9de; }
.note-card .row { justify-content: flex-start; align-items: flex-start; }
.note-number { font: 11px ui-monospace, monospace; padding-top: 3px; color: #81916e; }
.note-text { margin: 9px 0; font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; }
.note-actions { display: flex; gap: 8px; margin-top: 8px; }
.resolved .note-text { color: #8e9888; text-decoration: line-through; }
.notes-list { max-height: 46vh; overflow-y: auto; }
.empty { padding: 20px 5px 30px; text-align: center; color: #7a8379; }
.empty h3 { color: #4d6145; margin: 8px 0; }
.empty p { font-size: 12px; }
.empty-symbol { font: 38px Georgia, serif; color: #93aa6e; }
.tabs { display: flex; gap: 4px; padding: 4px; background: #f1f3ec; border-radius: 9px; margin-bottom: 12px; }
.tabs button { flex: 1; padding: 6px; font-size: 12px; }
.tabs .selected { background: #fffef9; box-shadow: 0 1px 4px #233b2710; }
.report { font: 11px/1.65 ui-monospace, monospace; margin-bottom: 12px; background: #f7f8f3; max-height: 40vh; }
.highlight { position: fixed; border: 2px solid #789e42; background: #adcc7020; border-radius: 4px; pointer-events: none; }
.target-label { position: absolute; left: -2px; bottom: 100%; margin-bottom: 5px; padding: 4px 8px; font: 10px ui-monospace, monospace; background: #314a27; color: #fff; border-radius: 5px; white-space: nowrap; }
.pin { position: fixed; pointer-events: auto; width: 24px; height: 24px; padding: 0; background: #344e28; color: #fff; border: 2px solid #fffef9; border-radius: 50%; box-shadow: 0 2px 8px #1c312733; font-size: 10px; }
.pin:hover { background: #607d3d; }
@media(max-width: 520px) { .dock-wrap { right: 12px; bottom: 12px; } .panel { right: 12px; bottom: 80px; } .brand-mark { padding: 0 7px; } .dock button { padding: 9px 8px; } .hint span { display: none; } }
`
