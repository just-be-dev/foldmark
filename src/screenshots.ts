import * as Schema from "effect/Schema";
import { privateRects, unionRects } from "./capture";
import { CapturedImage, type Rect, type Target } from "./model";

export interface ScreenshotRequest {
  /** Visible portion of the selection, in mounting-document coordinates. */
  bounds: Rect;
  targets: readonly Target[];
  masks: readonly Rect[];
  signal: AbortSignal;
}
export interface ScreenshotImage {
  /** Raster-only data URL. The image must be cropped to request.bounds. */
  dataUrl: string;
  width: number;
  height: number;
}
export type ScreenshotProvider = (request: ScreenshotRequest) => Promise<ScreenshotImage>;
const aborted = (signal: AbortSignal) => {
  if (signal.aborted) throw new DOMException("Screenshot cancelled", "AbortError");
};
const raster = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
interface RegionCaptureFactory {
  fromElement: (element: Element) => unknown;
}
interface RegionCaptureTrack extends MediaStreamTrack {
  cropTo: (target: unknown) => unknown;
}
const isRegionCaptureFactory = (value: unknown): value is RegionCaptureFactory =>
  ((typeof value === "object" && value !== null) || typeof value === "function") &&
  "fromElement" in value &&
  typeof value.fromElement === "function";
const isRegionCaptureTrack = (track: MediaStreamTrack): track is RegionCaptureTrack =>
  "cropTo" in track && typeof track.cropTo === "function";

/** Only invoked by the screenshot button. Native capture requires explicit browser consent. */
export async function takeScreenshot(
  targets: readonly Target[],
  signal: AbortSignal,
  options: {
    document?: Document;
    provider?: ScreenshotProvider;
    hideWidget?: () => () => void;
  } = {},
): Promise<CapturedImage> {
  const doc = options.document ?? document;
  const win = doc.defaultView;
  if (!win) throw new Error("Screenshot capture requires a browser window");
  aborted(signal);
  const full = unionRects(targets.map((target) => target.rect));
  if (!full) throw new Error("Select an element or area before taking a screenshot");
  const x = Math.max(full.x, win.scrollX);
  const y = Math.max(full.y, win.scrollY);
  const right = Math.min(full.x + full.width, win.scrollX + win.innerWidth);
  const bottom = Math.min(full.y + full.height, win.scrollY + win.innerHeight);
  const bounds = { x, y, width: right - x, height: bottom - y };
  if (bounds.width < 1 || bounds.height < 1)
    throw new Error("Scroll the selection into view before taking a screenshot");
  const request = { bounds, targets, masks: privateRects(doc), signal };
  const restore = options.hideWidget?.() ?? (() => {});
  try {
    const image = options.provider
      ? await options.provider(request)
      : await captureCurrentTab(request, doc);
    aborted(signal);
    if (!raster.test(image.dataUrl) || image.dataUrl.length > 12_000_000)
      throw new Error("The screenshot provider must return a reasonably sized PNG, JPEG, or WebP");
    const bitmap = doc.createElement("img");
    bitmap.src = image.dataUrl;
    await bitmap.decode();
    aborted(signal);
    if (
      bitmap.naturalWidth !== image.width ||
      bitmap.naturalHeight !== image.height ||
      image.width * image.height > 20_000_000 ||
      image.width < 1 ||
      image.height < 1
    )
      throw new Error("Screenshot dimensions are invalid or too large");
    let scale = Math.min(1, 1280 / Math.max(image.width, image.height));
    for (let attempt = 0; attempt < 6; attempt++) {
      const canvas = doc.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Screenshot rendering is not available");
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#26382f";
      // Re-read masks after capture as layout or privacy markers may have changed during consent.
      for (const mask of [...request.masks, ...privateRects(doc)]) {
        const left = Math.max(bounds.x, mask.x);
        const top = Math.max(bounds.y, mask.y);
        const width = Math.min(bounds.x + bounds.width, mask.x + mask.width) - left;
        const height = Math.min(bounds.y + bounds.height, mask.y + mask.height) - top;
        if (width <= 0 || height <= 0) continue;
        const sx = canvas.width / bounds.width;
        const sy = canvas.height / bounds.height;
        // Expand by one pixel to avoid leaking anti-aliased edges.
        ctx.fillRect(
          Math.floor((left - bounds.x) * sx) - 1,
          Math.floor((top - bounds.y) * sy) - 1,
          Math.ceil(width * sx) + 2,
          Math.ceil(height * sy) + 2,
        );
      }
      const dataUrl = canvas.toDataURL("image/jpeg", 0.78);
      if (dataUrl.length <= 700_000)
        return Schema.decodeUnknownSync(CapturedImage)({
          dataUrl,
          width: canvas.width,
          height: canvas.height,
        });
      scale *= 0.7;
    }
    throw new Error("Screenshot is too large. Select a smaller area or use fewer elements");
  } finally {
    restore();
  }
}

async function captureCurrentTab(
  request: ScreenshotRequest,
  doc: Document,
): Promise<ScreenshotImage> {
  const win = doc.defaultView;
  if (!win || !win.navigator.mediaDevices?.getDisplayMedia)
    throw new Error(
      "Screen capture is unavailable. Configure a screenshotProvider for this browser",
    );
  const cropType: unknown = "CropTarget" in win ? win.CropTarget : undefined;
  if (!isRegionCaptureFactory(cropType))
    throw new Error(
      "Safe current-tab capture requires Region Capture (Chromium). Configure a screenshotProvider otherwise",
    );
  const options: DisplayMediaStreamOptions & {
    preferCurrentTab: boolean;
    selfBrowserSurface: "include";
    surfaceSwitching: "exclude";
  } = {
    video: { displaySurface: "browser" },
    audio: false,
    preferCurrentTab: true,
    selfBrowserSurface: "include",
    surfaceSwitching: "exclude",
  };
  // This call is made only in response to the explicit Attach screenshot action.
  const stream = await win.navigator.mediaDevices.getDisplayMedia(options);
  try {
    aborted(request.signal);
    const track = stream.getVideoTracks()[0];
    if (!track || track.getSettings().displaySurface !== "browser")
      throw new Error("Choose the current browser tab, not a window or screen");
    if (!isRegionCaptureTrack(track))
      throw new Error("This browser cannot verify current-tab capture");
    const cropTarget = await cropType.fromElement(doc.documentElement);
    // cropTo rejects targets from another tab. Do not read any pixels until it succeeds.
    await track.cropTo(cropTarget);
    aborted(request.signal);
    const video = doc.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    try {
      await video.play();
      await waitForFrame(video, request.signal);
      aborted(request.signal);
      const sx = video.videoWidth / win.innerWidth;
      const sy = video.videoHeight / win.innerHeight;
      const canvas = doc.createElement("canvas");
      canvas.width = Math.max(1, Math.round(request.bounds.width * sx));
      canvas.height = Math.max(1, Math.round(request.bounds.height * sy));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Screenshot rendering is not available");
      ctx.drawImage(
        video,
        (request.bounds.x - win.scrollX) * sx,
        (request.bounds.y - win.scrollY) * sy,
        request.bounds.width * sx,
        request.bounds.height * sy,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      return { dataUrl: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height };
    } finally {
      video.pause();
      video.srcObject = null;
    }
  } finally {
    // Also release a stream that resolved after the widget was disposed or the draft was cancelled.
    for (const track of stream.getTracks()) track.stop();
  }
}
function waitForFrame(video: HTMLVideoElement, signal: AbortSignal): Promise<void> {
  if (video.readyState >= 2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(new Error("Screen capture produced no video frame")),
      5000,
    );
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      video.removeEventListener("loadeddata", ready);
      signal.removeEventListener("abort", cancel);
      if (error) reject(error);
      else resolve();
    };
    const ready = () => finish();
    const cancel = () => finish(new DOMException("Screenshot cancelled", "AbortError"));
    video.addEventListener("loadeddata", ready, { once: true });
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
}
