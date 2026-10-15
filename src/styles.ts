export const styles = `
:host { all: initial; position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; }
* { box-sizing: border-box; }
.foldmark { --fm-text:#26382f; --fm-muted:#6e7969; --fm-panel:#fffef9; --fm-input:#fff; --fm-border:#d9dfd4; --fm-soft:#f0f3e9; --fm-hover:#edf1eb; --fm-primary:#263f32; --fm-onprimary:#fffef9; --fm-selected:#e3edcc; --fm-selected-text:#344b20; --fm-focus:#93b959; --fm-danger:#975b4c; --fm-highlight:#789e42; --fm-shadow:#182f242b; --fm-label:#314a27; color-scheme:light; color:var(--fm-text); font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
.foldmark[data-theme="dark"] { --fm-text:#e4ecde; --fm-muted:#acb9a5; --fm-panel:#202b23; --fm-input:#18241d; --fm-border:#46543e; --fm-soft:#2c382b; --fm-hover:#344431; --fm-primary:#c6dca9; --fm-onprimary:#20301c; --fm-selected:#405734; --fm-selected-text:#dcecc9; --fm-focus:#b6d481; --fm-danger:#e4ac99; --fm-highlight:#aacd79; --fm-shadow:#0006; --fm-label:#314a27; color-scheme:dark; }
@media(prefers-color-scheme:dark) { .foldmark[data-theme="system"] { --fm-text:#e4ecde; --fm-muted:#acb9a5; --fm-panel:#202b23; --fm-input:#18241d; --fm-border:#46543e; --fm-soft:#2c382b; --fm-hover:#344431; --fm-primary:#c6dca9; --fm-onprimary:#20301c; --fm-selected:#405734; --fm-selected-text:#dcecc9; --fm-focus:#b6d481; --fm-danger:#e4ac99; --fm-highlight:#aacd79; --fm-shadow:#0006; --fm-label:#314a27; color-scheme:dark; } }
button,textarea { font:inherit; }
button { cursor:pointer; border:0; background:transparent; color:inherit; border-radius:8px; padding:9px 12px; transition:background .15s; }
button:hover { background:var(--fm-hover); }
button:disabled { opacity:.4; cursor:not-allowed; }
button:focus-visible,textarea:focus-visible { outline:3px solid var(--fm-focus); outline-offset:3px; }
h2,h3,p { margin:0; } h2 { font-size:20px; font-weight:600; letter-spacing:-.6px; } h3 { font-size:15px; font-weight:550; }
code { font:11px/1.6 ui-monospace,SFMono-Regular,monospace; overflow-wrap:anywhere; }
.dock-wrap { position:fixed; right:28px; bottom:24px; display:flex; flex-direction:column; align-items:flex-end; gap:10px; max-width:calc(100vw - 24px); }
.dock { pointer-events:auto; display:flex; align-items:center; gap:3px; padding:6px; background:var(--fm-panel); border:1px solid var(--fm-border); border-radius:14px; box-shadow:0 4px 8px #1b322c0a,0 12px 48px var(--fm-shadow); }
.brand-mark { font:italic 26px Georgia,serif; padding:0 12px; color:var(--fm-muted); }
.dock button { font-size:12px; font-weight:550; white-space:nowrap; }
.inspect.active { background:var(--fm-selected); color:var(--fm-selected-text); }
.divider { width:1px; height:22px; background:var(--fm-border); margin:0 4px; }
.dock .export-button { background:var(--fm-primary); color:var(--fm-onprimary); margin-left:4px; }
.dock .export-button:hover,.primary:hover { filter:brightness(1.13); background:var(--fm-primary); }
.selected { background:var(--fm-selected); color:var(--fm-selected-text); }
.hint,.notice { padding:9px 14px; border:1px solid var(--fm-border); background:var(--fm-panel); border-radius:10px; box-shadow:0 3px 16px #233b2710; max-width:400px; }
.hint span { margin-left:18px; font-size:11px; color:var(--fm-muted); }
.notice { position:fixed; top:18px; right:28px; max-width:calc(100vw - 24px); color:var(--fm-text); pointer-events:auto; }
.panel { position:fixed; pointer-events:auto; bottom:94px; right:28px; width:380px; max-width:calc(100vw - 24px); max-height:calc(100dvh - 120px); overflow:auto; padding:22px; background:var(--fm-panel); border:1px solid var(--fm-border); border-radius:18px; box-shadow:0 18px 70px var(--fm-shadow); }
.panel-heading { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; margin-bottom:21px; }
.panel-heading p { margin-top:4px; }
.icon-button { font-size:24px; padding:0 7px; line-height:1.2; }
.muted { color:var(--fm-muted); font-size:11px; }
.eyebrow { font-size:9px; letter-spacing:1.7px; font-weight:650; color:var(--fm-muted); }
.target-context { padding:13px 15px; border-radius:10px; background:var(--fm-soft); margin-bottom:18px; display:flex; flex-direction:column; gap:5px; }
.source { font:10px/1.5 ui-monospace,monospace; color:var(--fm-muted); overflow-wrap:anywhere; }
label { display:block; font-weight:550; margin-bottom:8px; }
textarea { display:block; resize:vertical; width:100%; padding:12px; border:1px solid var(--fm-border); border-radius:10px; background:var(--fm-input); color:var(--fm-text); line-height:1.6; }
textarea::placeholder { color:var(--fm-muted); }
.row { display:flex; align-items:center; gap:10px; justify-content:space-between; }
.actions { margin-top:16px; }
.primary { background:var(--fm-primary); color:var(--fm-onprimary); font-weight:550; }
.secondary { border:1px solid var(--fm-border); }
.full { width:100%; margin-top:16px; }
.filter-row { margin:-5px 0 10px; }
.text-button { padding:4px 6px; font-size:11px; color:var(--fm-muted); }
.danger { color:var(--fm-danger); margin-left:auto; }
.note-card { padding:15px 0; border-top:1px solid var(--fm-border); }
.note-card .row { justify-content:flex-start; align-items:flex-start; }
.note-number { font:11px ui-monospace,monospace; padding-top:3px; color:var(--fm-muted); }
.note-text { margin:9px 0; font-size:13px; white-space:pre-wrap; overflow-wrap:anywhere; }
.note-actions { display:flex; gap:8px; margin-top:8px; }
.resolved .note-text { color:var(--fm-muted); text-decoration:line-through; }
.notes-list { max-height:46vh; overflow-y:auto; }
.empty { padding:20px 5px 30px; text-align:center; color:var(--fm-muted); }
.empty h3 { color:var(--fm-text); margin:8px 0; }
.empty p { font-size:12px; }
.empty-symbol { font:38px Georgia,serif; color:var(--fm-muted); }
.tabs { display:flex; gap:4px; padding:4px; background:var(--fm-soft); border-radius:9px; margin-bottom:12px; }
.tabs button { flex:1; padding:6px; font-size:12px; }
.tabs .selected { background:var(--fm-panel); box-shadow:0 1px 4px #233b2710; }
.report { font:11px/1.65 ui-monospace,monospace; margin-bottom:12px; background:var(--fm-soft); max-height:40vh; }
.highlight { position:fixed; border:2px solid var(--fm-highlight); background:#adcc7020; border-radius:4px; pointer-events:none; }
.target-label { position:absolute; left:-2px; bottom:100%; margin-bottom:5px; padding:4px 8px; font:10px ui-monospace,monospace; background:var(--fm-label); color:#fff; border-radius:5px; white-space:nowrap; max-width:calc(100vw - 20px); overflow:hidden; text-overflow:ellipsis; }
.pin { position:fixed; pointer-events:auto; width:24px; height:24px; padding:0; background:var(--fm-label); color:#fff; border:2px solid var(--fm-panel); border-radius:50%; box-shadow:0 2px 8px #1c312733; font-size:10px; }
.pin:hover { background:var(--fm-highlight); } .pin.detached { border-style:dashed; }
.options-row { display:flex; flex-wrap:wrap; gap:6px; margin:10px 0 14px; }
.options-row button { border:1px solid var(--fm-border); font-size:12px; }
.settings h3 { margin-top:24px; } .settings h3:first-of-type { margin-top:0; }
.selection-bar { position:fixed; pointer-events:auto; right:28px; bottom:146px; display:flex; align-items:center; flex-wrap:wrap; gap:8px; padding:10px; border:1px solid var(--fm-border); background:var(--fm-panel); border-radius:12px; max-width:calc(100vw - 24px); box-shadow:0 6px 26px var(--fm-shadow); }
.selection-highlight { border-style:dashed; } .area-highlight { border-style:dashed; border-radius:0; }
.screenshot-preview { margin-top:14px; } .screenshot-preview img,.note-screenshot { display:block; width:100%; height:auto; max-height:170px; object-fit:contain; background:var(--fm-soft); border:1px solid var(--fm-border); border-radius:8px; }
.screenshot-help { margin-top:8px; } .note-screenshot { margin-top:10px; }
.detached-label { color:var(--fm-danger); font-size:11px; margin:6px 0; }
.feedback-status { margin-top:12px; } .request-status { padding:10px 0; border-top:1px solid var(--fm-border); font-size:11px; overflow-wrap:anywhere; }
.request-status strong { display:inline-block; margin-right:12px; } .request-status p { margin-top:5px; white-space:pre-wrap; }
.status-failed strong { color:var(--fm-danger); }
@media(max-width:520px) { .dock-wrap { right:12px; bottom:12px; } .panel { right:12px; bottom:80px; } .brand-mark { padding:0 4px; } .dock { gap:1px; } .dock button { padding:9px 6px; } .divider { margin:0 1px; } .hint span { display:none; } .selection-bar { right:12px; bottom:130px; } }
@media(max-width:340px) { .dock { flex-wrap:wrap; justify-content:flex-end; } .dock .brand-mark,.dock .divider { display:none; } .dock button { padding:7px 5px; } .panel { bottom:96px; max-height:calc(100dvh - 120px); } }
@media(prefers-reduced-motion:reduce) { *,*:before,*:after { transition:none !important; animation:none !important; scroll-behavior:auto !important; } }
`;
