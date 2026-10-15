# Widget features and browser limits

The toolbar's **Foldmark options** button opens selection, appearance, and history controls. Existing `mountFoldmark()` integration remains supported. Persisted sessions keep version `1`; the new fields are optional so old notes restore without migration.

## Selection and history

- **Single element** captures one element and opens the composer.
- **Select multiple** toggles elements by clicking them. Choose **Annotate selection** to write one note about up to 100 targets. The report keeps a root-aware address for each target. Clear or Escape cancels the unfinished selection.
- **Select area** lets you drag a rectangle. A region is a fixed set of coordinates in the mounting document, not a synthetic CSS selector or automatic screenshot. Area capture does not extract the text or state inside the region. Regions must be at least 5×5 pixels.
- **Undo / Redo** covers note creation, editing, resolve/reopen, deletion, and screenshot replacement/removal as part of a saved note. The last 30 changes are available for this widget session. A new change clears redo. History is not persisted; restoring notes does not restore undo history. Undo and route changes cancel stale drafts and asynchronous screenshot/source results.
- **System / Light / Dark theme** affects only the isolated widget and is saved with notes. `mountFoldmark({ theme: 'dark' })` overrides the initial saved preference. `storage: false` keeps appearance and notes in memory.

Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z operate Foldmark history while inspecting or focused in the widget, except in text-editing controls, which retain their normal text undo. Alt+Shift+A toggles inspection. Escape cancels a draft/selection before leaving inspection. Cmd/Ctrl+Enter saves a nonempty note.

## Frame and shadow-root addresses

Open shadow roots and same-origin iframe documents can be inspected, including frames inside shadow roots and shadows inside frames. A target stores a local `selector`, an optional `path` of `{ kind: 'frame' | 'shadow', selector }` segments, and an optional `framePage` containing the embedded document's origin/path/hash. `resolveTarget(target)` follows those segments; a selector is not flattened into an invalid cross-root CSS selector.

Reports and route filtering use the mounting document's origin/path/hash. `framePage` records the selected embedded page separately. Resolving a note refuses to attach it to a different iframe page after navigation, even if that page has the same selector. Query strings are deliberately omitted from captured page identifiers.

Element pins re-resolve their targets as layout, viewport, nested scrolling, and accessible frame geometry change. Missing, hidden, inaccessible, or ignored targets are marked **detached**, and an entirely detached mark has no pin. Partially detached grouped notes retain their remaining pin with a detached warning. Area pins remain fixed document coordinates. Reports retain historical captured bounds rather than rewriting old notes on every layout change.

Cross-origin iframe contents and closed shadow roots cannot be traversed. Frame coordinates account for nested frame borders and axis-aligned CSS scaling; arbitrary rotated/skewed embedded frames are not a pixel-exact coordinate system. DOM discovery is bounded to 200 accessible roots and 24 nesting levels. Existing host capture listeners registered before Foldmark can still run first.

## Explicit screenshot attachments

**Attach screenshot** is optional and is the only widget action that initiates screenshot capture. Native capture requires browser consent and Chromium's Region Capture support. The user must choose the current browser tab. Foldmark verifies the tab by cropping the returned track to a `CropTarget` from the current document **before reading pixels**. Window/screen capture and a different tab are rejected. Browsers without that capability show an explanatory error instead of silently capturing the DOM.

A host can supply an explicit screenshot provider for other browsers or an existing screenshot integration:

```ts
import { mountFoldmark, type ScreenshotProvider } from "foldmark";

const screenshotProvider: ScreenshotProvider = async ({ bounds, masks, targets, signal }) => {
  // Use your trusted host screenshot facility. Respect signal and return a real raster image
  // cropped to bounds (mounting-document coordinates), not a fabricated DOM approximation.
  return myScreenshotFacility.capture({ bounds, masks, targets, signal });
};

const feedback = mountFoldmark({ screenshotProvider });
```

Providers are host-owned integrations; Foldmark does not contact a screenshot service by default. Their raster-only data URLs are checked, decoded, resized to a maximum 1280-pixel side, and compressed to at most 700,000 data-URL characters. Large/invalid images fail visibly without discarding the note. Only the visible intersection of the selection and the mounting viewport is captured. Every selected element is re-resolved immediately before capture; detached/hidden selections are rejected rather than screenshotting stale coordinates. Areas deliberately retain their fixed coordinates.

Private/ignored regions, form controls, editable content, and embedded frames are conservatively masked. Redaction also walks ignored roots and overflow descendants, including `display: contents` shadow hosts: selection exclusion is not a privacy exemption. The entire iframe rectangle is masked in screenshots even when its document is accessible for text/selector capture. The widget is hidden during image creation. Returned provider images are masked again, using rectangles from before and after capture. Hosts must return the exact requested crop for these masks to line up correctly.

Review the preview before saving and the report before sharing. Redaction is not a general-purpose data-loss-prevention system: arbitrary canvas/WebGL pixels, browser overlays, unmarked text, user-authored notes, selectors, and host-provider output can contain sensitive content. Mask privacy-sensitive application regions explicitly. Interactive screen permission dialogs and real display-capture devices require manual verification; automated tests exercise the host-provider raster/redaction path.

A storage-budget or quota failure retries persistence without image data. Notes and appearance are kept when possible; full images remain in memory and explicit Markdown/JSON exports for the current session, with a visible warning. If even the metadata cannot be saved, export remains available. Removing/replacing an image takes effect when its note is saved. Capture streams, pending work, URLs, and widget listeners are released on disposal; late screenshot/source results cannot attach to a replacement draft.

## Source hints and original sources

`annotate(h, { source, modelPath, message })` and the synchronous `context(element)` callback remain supported. Hints inherit through accessible shadow hosts/frame owners. Automatic source hints are an opt-in development build feature, not a claim that arbitrary rendered DOM has recoverable source maps. See [source mapping](source-mapping.md) for the Vite plugin and host-owned map loader.

An optional asynchronous resolver receives the selected element and its captured/instrumented hints:

```ts
mountFoldmark({
  sourceResolver: async (element, captured) => ({
    ...captured,
    source: await resolveOriginalLocation(element, captured.source),
  }),
});
```

A result updates only the matching live draft revision. Failures retain the captured hints with a visible notice. The default widget does not fetch source files/maps or capture the host application's Model state.

## Animation pause

Pause discovers running Web Animations, CSS animations/transitions, and video/audio in accessible documents/roots. It preserves work that was already paused, catches newly discovered animations/media while paused, and resumes only the work it paused. CSS animation play-state rules are scoped to discovered documents/roots and removed on resume/dispose; transitions are paused via Web Animations instead of being cancelled and snapped to their end values.

This does not stop application JavaScript, timers, canvas/WebGL drawing, animated raster images, cross-origin media, or animations inside closed roots. New animation discovery can take a frame, and a newly attached root may require a discovery pass. Host code can still change layout while paused. Browser autoplay policy can prevent resuming media; no permission bypass is attempted.

## Agent feedback loop

```ts
mountFoldmark({
  feedback: {
    endpoint: "http://127.0.0.1:4781",
    token: pairedToken,
    projectId: "my-app",
  },
});
```

Pairing configuration is memory-only; it is never included in local note persistence or reports. Constructing/mounting a paired client performs **no network I/O**. Only **Send to agent** submits the current route's open notes, including explicitly attached images. Failed submissions remain local and can be retried with the same idempotency ID. Status polling starts after a successful explicit submission and stops after its requests reach a terminal status or the widget is disposed. Concurrent submissions and delayed status snapshots merge by request revision instead of erasing or regressing newer work. A failed status read retains the last known state and retries visibly; it does not pretend the agent has finished.

The widget shows pending, agent-working, completed, and failed states with the agent's result message. Notes are not automatically resolved just because an agent reports completion. Request-status history is scoped to submissions from the current mounted handle; server requests remain durable across browser restarts. Generic MCP clients may require an explicit request to process feedback; a resource notification alone does not grant tool permissions or guarantee an agent turn. See [feedback server](feedback-server.md) and the optional Pi integration for transport and approval behavior.
