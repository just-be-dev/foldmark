import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { FoldmarkHandle } from "../../src/index";
import type { Rect } from "../../src/model";
import type { FeedbackRequest } from "../../src/feedback";
import { createFeedbackStore } from "../../server/store";
import { startFeedbackHttpServer } from "../../server/http";

declare global {
  interface Window {
    foldmarkFeatureTest: FoldmarkHandle;
    foldmarkScreenshotCalls: number;
    foldmarkScreenshotBounds: Rect | null;
    foldmarkScreenshotTargets: readonly Rect[];
    foldmarkRaceRequests: FeedbackRequest[];
    foldmarkRaceLists: number;
    foldmarkReleaseList: () => void;
  }
}
async function mount(
  page: Page,
  options: {
    memory?: boolean;
    provider?: boolean;
    sourceResolver?: boolean;
    feedback?: { endpoint: string; token: string; projectId: string };
  } = {},
) {
  await page.goto("/tests/browser/blank.html");
  await page.evaluate(async (options) => {
    document.body.innerHTML = `
      <style>
        body { margin:20px; font:16px sans-serif; min-height:1100px; }
        main { width:500px; max-width:calc(100vw - 40px); }
        button { padding:12px; margin:4px; }
        #capture-region { position:relative; width:320px; height:200px; margin-top:20px; background:#edf1eb; }
        #private { position:absolute; left:40px; top:40px; width:80px; height:40px; }
        #ignored { position:absolute; left:150px; top:40px; width:100px; height:40px; }
        #scroller { width:300px; height:110px; overflow:auto; border:1px solid; margin-top:20px; }
        #moving { margin-top:70px; height:30px; }
        iframe { display:block; width:420px; height:150px; border:4px solid #888; margin-top:20px; }
      </style>
      <main>
        <button id="first" data-foldmark-source="compiled/view.js:4:1">First target</button>
        <button id="second">Second target</button>
        <div id="capture-region"><span>Visible context</span><span id="private" data-foldmark-private>Private text</span><input id="ignored" data-foldmark-ignore value="Hidden form value"></div>
        <div id="scroller"><button id="moving">Moving target</button><div style="height:200px"></div></div>
        <div id="outer-root"></div>
        <iframe id="preview" title="Preview"></iframe>
      </main>`;
    const outer = document.getElementById("outer-root");
    const shadow = outer?.attachShadow({ mode: "open" });
    if (shadow) shadow.innerHTML = '<button id="first">Shadow target</button>';
    const frame = document.querySelector<HTMLIFrameElement>("#preview");
    if (frame)
      frame.srcdoc =
        '<!doctype html><html><body><div id="inner-root"></div><script>document.getElementById("inner-root").attachShadow({mode:"open"}).innerHTML = \'<button id="inside">Frame shadow target</button>\'</script></body></html>';
    const modulePath = "/src/index.ts";
    const { mountFoldmark }: typeof import("../../src/index") = await import(modulePath);
    window.foldmarkScreenshotCalls = 0;
    window.foldmarkScreenshotBounds = null;
    window.foldmarkScreenshotTargets = [];
    window.foldmarkFeatureTest = mountFoldmark({
      ...(options.memory ? { storage: false } : {}),
      ...(options.feedback ? { feedback: options.feedback } : {}),
      ...(options.provider
        ? {
            screenshotProvider: async ({ bounds, targets }) => {
              window.foldmarkScreenshotCalls++;
              window.foldmarkScreenshotBounds = bounds;
              window.foldmarkScreenshotTargets = targets.map((target) => target.rect);
              const canvas = document.createElement("canvas");
              canvas.width = Math.max(1, Math.round(bounds.width));
              canvas.height = Math.max(1, Math.round(bounds.height));
              const context = canvas.getContext("2d");
              if (!context) throw new Error("Missing test canvas");
              context.fillStyle = "#f08060";
              context.fillRect(0, 0, canvas.width, canvas.height);
              return {
                dataUrl: canvas.toDataURL("image/png"),
                width: canvas.width,
                height: canvas.height,
              };
            },
          }
        : {}),
      ...(options.sourceResolver
        ? {
            sourceResolver: async (_element, context) => ({
              ...context,
              source: "src/original/view.ts:42:3",
            }),
          }
        : {}),
    });
  }, options);
  await expect(page.getByRole("toolbar")).toBeVisible();
}
async function inspect(page: Page) {
  await page.getByRole("button", { name: "⌖ Inspect", exact: true }).click();
  await expect(page.getByRole("button", { name: "⌖ Inspecting", exact: true })).toBeVisible();
}
async function save(page: Page, note: string) {
  await page.getByLabel("What should change?").fill(note);
  await page.getByRole("button", { name: "Save note ↗" }).click();
  await expect(page.getByText(note, { exact: true })).toBeVisible();
}
async function options(page: Page) {
  await page.getByRole("button", { name: "Foldmark options", exact: true }).click();
  await expect(page.getByRole("region", { name: "Foldmark options", exact: true })).toBeVisible();
}

test("multi-select, undo/redo and persisted themes work through the widget", async ({ page }) => {
  await mount(page);
  await options(page);
  await page.getByRole("button", { name: "Dark theme", exact: true }).click();
  await expect(page.locator(".foldmark")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Select multiple", exact: true }).click();
  await page.getByRole("button", { name: "First target", exact: true }).click();
  await page.locator("#second").click();
  await expect(page.getByRole("region", { name: "Selected elements" })).toContainText("2 selected");
  await page.getByRole("button", { name: "Annotate selection", exact: true }).click();
  await save(page, "Align these two controls");
  expect(
    await page.evaluate(() => window.foldmarkFeatureTest.getAnnotations()[0]?.targets?.length),
  ).toBe(2);
  await options(page);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect(await page.evaluate(() => window.foldmarkFeatureTest.getAnnotations().length)).toBe(0);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  expect(await page.evaluate(() => window.foldmarkFeatureTest.getAnnotations().length)).toBe(1);
  await page.evaluate(() => window.foldmarkFeatureTest.dispose());
  await page.evaluate(async () => {
    const modulePath = "/src/index.ts";
    const { mountFoldmark }: typeof import("../../src/index") = await import(modulePath);
    window.foldmarkFeatureTest = mountFoldmark();
  });
  await expect(page.locator(".foldmark")).toHaveAttribute("data-theme", "dark");
  expect(
    await page.evaluate(() => window.foldmarkFeatureTest.getAnnotations()[0]?.targets?.length),
  ).toBe(2);
  await page.getByRole("button", { name: "Foldmark options", exact: true }).click();
  await page.getByRole("button", { name: "System theme", exact: true }).click();
  await expect(page.locator(".foldmark")).toHaveAttribute("data-theme", "system");
});

test("dragging an area captures a document rectangle without collecting its text", async ({
  page,
}) => {
  await mount(page, { memory: true });
  await options(page);
  await page.getByRole("button", { name: "Select area", exact: true }).click();
  const region = await page.locator("#capture-region").boundingBox();
  if (!region) throw new Error("Missing capture region");
  await page.mouse.move(region.x + 10, region.y + 10);
  await page.mouse.down();
  await page.mouse.move(region.x + 290, region.y + 180, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByRole("dialog", { name: "Annotate element" })).toBeVisible();
  await save(page, "Rebalance this region");
  const target = await page.evaluate(() => window.foldmarkFeatureTest.getAnnotations()[0]?.target);
  expect(target?.kind).toBe("area");
  expect(target?.text).toBe("");
  expect(target?.rect.width).toBeCloseTo(280, 0);
  expect(target?.rect.height).toBeCloseTo(170, 0);
});

test("open shadow roots and same-origin nested frame roots have resolvable paths and top-document coordinates", async ({
  page,
}) => {
  await mount(page, { memory: true });
  await inspect(page);
  await page
    .locator("#outer-root")
    .getByRole("button", { name: "Shadow target", exact: true })
    .click();
  await save(page, "Shadow feedback");
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  const frameButton = page
    .frameLocator("#preview")
    .getByRole("button", { name: "Frame shadow target", exact: true });
  await expect(frameButton).toBeVisible();
  const bounds = await frameButton.boundingBox();
  await frameButton.click();
  await save(page, "Frame feedback");
  const result = await page.evaluate(async () => {
    const modulePath = "/src/capture.ts";
    const { resolveTarget }: typeof import("../../src/capture") = await import(modulePath);
    return window.foldmarkFeatureTest.getAnnotations().map((annotation) => ({
      target: annotation.target,
      resolved: resolveTarget(annotation.target)?.textContent,
    }));
  });
  expect(result[0]?.target.path?.map((part) => part.kind)).toEqual(["shadow"]);
  expect(result[1]?.target.path?.map((part) => part.kind)).toEqual(["frame", "shadow"]);
  expect(result[1]?.resolved).toBe("Frame shadow target");
  expect(result[1]?.target.page).toBe(new URL(page.url()).origin + "/tests/browser/blank.html");
  expect(result[1]?.target.framePage).toBeDefined();
  expect(result[1]?.target.rect.x).toBeCloseTo(bounds?.x ?? -1, 0);
  expect(result[1]?.target.rect.y).toBeCloseTo(bounds?.y ?? -1, 0);
});

test("live pins follow nested scrolling and layout changes, and expose detached targets", async ({
  page,
}) => {
  await mount(page, { memory: true });
  await inspect(page);
  await page.locator("#moving").click();
  await save(page, "Keep this aligned");
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  const pin = page.getByRole("button", { name: "Edit annotation 1", exact: true });
  await expect(pin).toBeVisible();
  const initial = await pin.boundingBox();
  await page.locator("#scroller").evaluate((element) => {
    element.scrollTop = 40;
  });
  await expect
    .poll(async () => (await pin.boundingBox())?.y)
    .toBeCloseTo((initial?.y ?? 0) - 40, 0);
  await page.locator("#moving").evaluate((element) => {
    element.style.marginTop = "85px";
  });
  await expect
    .poll(async () => (await pin.boundingBox())?.y)
    .toBeCloseTo((initial?.y ?? 0) - 25, 0);
  await page.locator("#moving").evaluate((element) => element.remove());
  await expect(pin).toHaveCount(0);
  await page.getByRole("button", { name: "Notes 1", exact: true }).click();
  await expect(
    page.getByText("Target detached or no longer accessible", { exact: true }),
  ).toBeVisible();
});

test("screenshots run only on explicit action, redact private and ignored content, and survive exports", async ({
  page,
}) => {
  await mount(page, { memory: true, provider: true });
  expect(await page.evaluate(() => window.foldmarkScreenshotCalls)).toBe(0);
  await inspect(page);
  await page.locator("#capture-region").click({ position: { x: 5, y: 190 } });
  expect(await page.evaluate(() => window.foldmarkScreenshotCalls)).toBe(0);
  await page.getByRole("button", { name: "Attach screenshot", exact: true }).click();
  await expect(page.getByAltText("Redacted screenshot attachment", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.foldmarkScreenshotCalls)).toBe(1);
  await save(page, "Review this redacted screenshot");
  const pixels = await page.evaluate(async () => {
    const screenshot = window.foldmarkFeatureTest.getAnnotations()[0]?.screenshot;
    if (!screenshot) throw new Error("Missing screenshot");
    const image = document.createElement("img");
    image.src = screenshot.dataUrl;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No image context");
    context.drawImage(image, 0, 0);
    const sample = (x: number, y: number) => [...context.getImageData(x, y, 1, 1).data].slice(0, 3);
    return { visible: sample(10, 150), private: sample(70, 60), ignoredInput: sample(180, 60) };
  });
  expect(pixels.visible[0]).toBeGreaterThan(200);
  for (const sample of [pixels.private, pixels.ignoredInput]) {
    expect(sample[0]).toBeLessThan(70);
    expect(sample[1]).toBeLessThan(90);
    expect(sample[2]).toBeLessThan(80);
  }
  await page.getByRole("button", { name: "Export feedback ↗", exact: true }).click();
  await page.getByRole("button", { name: "JSON", exact: true }).click();
  const reportBox = page.getByRole("textbox", { name: "Feedback report" });
  await expect(reportBox).toHaveValue(/^\{/);
  const report = JSON.parse(await reportBox.inputValue());
  expect(report.annotations[0]?.screenshot?.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
});

test("ignored/private shadow hosts with display:contents do not bypass screenshot redaction", async ({
  page,
}) => {
  await mount(page, { memory: true });
  const result = await page.evaluate(async () => {
    const region = document.getElementById("capture-region");
    if (!region) throw new Error("Missing region");
    const ignored = document.createElement("span");
    ignored.setAttribute("data-foldmark-ignore", "");
    ignored.setAttribute("data-foldmark-private", "");
    ignored.style.display = "contents";
    const shadow = ignored.attachShadow({ mode: "open" });
    shadow.innerHTML =
      '<span style="position:absolute;left:30px;top:120px;width:80px;height:40px;display:block">Secret overflow</span>';
    region.append(ignored);
    const capturePath = "/src/capture.ts";
    const screenshotPath = "/src/screenshots.ts";
    const { capture }: typeof import("../../src/capture") = await import(capturePath);
    const { takeScreenshot }: typeof import("../../src/screenshots") = await import(screenshotPath);
    const screenshot = await takeScreenshot([capture(region)], new AbortController().signal, {
      provider: async ({ bounds }) => {
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(bounds.width);
        canvas.height = Math.round(bounds.height);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("No canvas context");
        context.fillStyle = "#fff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        return { dataUrl: canvas.toDataURL(), width: canvas.width, height: canvas.height };
      },
    });
    const image = document.createElement("img");
    image.src = screenshot.dataUrl;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No canvas context");
    context.drawImage(image, 0, 0);
    return [...context.getImageData(60, 140, 1, 1).data].slice(0, 3);
  });
  expect(result[0]).toBeLessThan(70);
  expect(result[1]).toBeLessThan(90);
});

test("host source resolver maps a captured hint without changing the annotation identity", async ({
  page,
}) => {
  await mount(page, { memory: true, sourceResolver: true });
  await inspect(page);
  await page.getByRole("button", { name: "First target", exact: true }).click();
  await expect(page.getByText("src/original/view.ts:42:3", { exact: true })).toBeVisible();
  await save(page, "Mapped source feedback");
  expect(
    await page.evaluate(() => window.foldmarkFeatureTest.getAnnotations()[0]?.target.source),
  ).toBe("src/original/view.ts:42:3");
});

test("pausing freezes new animations too, preserves already-paused work, and disposes frame listeners", async ({
  page,
}) => {
  await mount(page, { memory: true });
  await page.evaluate(() => {
    const first = document.getElementById("first");
    const second = document.getElementById("second");
    first?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 10000, iterations: Infinity });
    const paused = second?.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 10000,
      iterations: Infinity,
    });
    paused?.pause();
  });
  await page.getByRole("button", { name: "Pause animations", exact: true }).click();
  await expect
    .poll(() =>
      page
        .getByRole("button", { name: "First target", exact: true })
        .evaluate((element) => element.getAnimations()[0]?.playState),
    )
    .toBe("paused");
  await page.locator("#capture-region").evaluate((element) => {
    element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 10000, iterations: Infinity });
  });
  await expect
    .poll(() =>
      page.locator("#capture-region").evaluate((element) => element.getAnimations()[0]?.playState),
    )
    .toBe("paused");
  await page.getByRole("button", { name: "Resume animations", exact: true }).click();
  await expect
    .poll(() =>
      page
        .getByRole("button", { name: "First target", exact: true })
        .evaluate((element) => element.getAnimations()[0]?.playState),
    )
    .toBe("running");
  expect(
    await page.locator("#second").evaluate((element) => element.getAnimations()[0]?.playState),
  ).toBe("paused");
  await expect
    .poll(() =>
      page.locator("#capture-region").evaluate((element) => element.getAnimations()[0]?.playState),
    )
    .toBe("running");
  await page.evaluate(() => window.foldmarkFeatureTest.dispose());
  await expect(page.locator("[data-foldmark-root]")).toHaveCount(0);
  await page
    .frameLocator("#preview")
    .getByRole("button", { name: "Frame shadow target", exact: true })
    .click();
  await expect(page.locator("[data-foldmark-root]")).toHaveCount(0);
});

test("explicit Send to agent round-trips through the authenticated HTTP companion and renders completion", async ({
  page,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Missing browser test origin");
  const dataDir = await mkdtemp(join(tmpdir(), "foldmark-browser-feedback-"));
  const token = randomBytes(32).toString("base64url");
  const store = await createFeedbackStore({ dataDir, projectId: "browser-project" });
  const server = await startFeedbackHttpServer({
    store,
    token,
    port: 0,
    allowedOrigins: [new URL(baseURL).origin],
  });
  let requests = 0;
  page.on("request", (request) => {
    if (request.url().startsWith(server.endpoint)) requests++;
  });
  try {
    await mount(page, {
      memory: true,
      feedback: { endpoint: server.endpoint, token, projectId: "browser-project" },
    });
    await inspect(page);
    await page.getByRole("button", { name: "First target", exact: true }).click();
    await save(page, "Agent: increase the control spacing");
    expect(await store.list()).toHaveLength(0);
    expect(requests).toBe(0);
    await page.getByRole("button", { name: "Send to agent", exact: true }).click();
    await expect(page.getByRole("region", { name: "Agent requests" })).toContainText("Pending");
    await expect.poll(async () => (await store.list()).length).toBe(1);
    const request = (await store.list())[0];
    if (!request) throw new Error("Missing server request");
    expect(request.annotations[0]?.note).toBe("Agent: increase the control spacing");
    const claimed = await store.claim(request.id, { owner: "browser-test-agent" });
    await expect(page.getByRole("region", { name: "Agent requests" })).toContainText(
      "Agent working",
    );
    await store.complete(request.id, {
      claimToken: claimed.claimToken,
      status: "completed",
      message: "Control spacing updated and checked.",
    });
    await expect(page.getByRole("region", { name: "Agent requests" })).toContainText("Completed");
    await expect(page.getByRole("region", { name: "Agent requests" })).toContainText(
      "Control spacing updated and checked.",
    );
    const saved = await page.evaluate(() => localStorage.getItem("foldmark:v1"));
    expect(saved ?? "").not.toContain(token);
    await page.getByRole("button", { name: "Export feedback ↗", exact: true }).click();
    expect(await page.getByRole("textbox", { name: "Feedback report" }).inputValue()).not.toContain(
      token,
    );
    await page.evaluate(() => window.foldmarkFeatureTest.dispose());
    expect(requests).toBeGreaterThan(0);
  } finally {
    await page.evaluate(() => window.foldmarkFeatureTest?.dispose()).catch(() => {});
    await server.close();
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("screenshots resolve fresh geometry for moved single and grouped targets, and reject detached targets", async ({
  page,
}) => {
  await mount(page, { memory: true, provider: true });
  await inspect(page);
  const first = page.getByRole("button", { name: "First target", exact: true });
  await first.click();
  await first.evaluate((element) => {
    element.style.transform = "translate(100px,40px)";
  });
  const moved = await first.boundingBox();
  await page.getByRole("button", { name: "Attach screenshot", exact: true }).click();
  await expect(page.getByAltText("Redacted screenshot attachment", { exact: true })).toBeVisible();
  const single = await page.evaluate(() => window.foldmarkScreenshotTargets[0]);
  expect(single?.x).toBeCloseTo(moved?.x ?? -1, 0);
  expect(single?.y).toBeCloseTo(moved?.y ?? -1, 0);
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await options(page);
  await page.getByRole("button", { name: "Select multiple", exact: true }).click();
  await first.click();
  const second = page.getByRole("button", { name: "Second target", exact: true });
  await second.click();
  await page.getByRole("button", { name: "Annotate selection", exact: true }).click();
  await first.evaluate((element) => {
    element.style.transform = "translate(40px,80px)";
  });
  await second.evaluate((element) => {
    element.style.transform = "translate(120px,120px)";
  });
  const expected = [await first.boundingBox(), await second.boundingBox()];
  await page.getByRole("button", { name: "Attach screenshot", exact: true }).click();
  await expect(page.getByAltText("Redacted screenshot attachment", { exact: true })).toBeVisible();
  const grouped = await page.evaluate(() => window.foldmarkScreenshotTargets);
  for (let index = 0; index < 2; index++) {
    expect(grouped[index]?.x).toBeCloseTo(expected[index]?.x ?? -1, 0);
    expect(grouped[index]?.y).toBeCloseTo(expected[index]?.y ?? -1, 0);
  }
  await page.getByRole("button", { name: "Remove screenshot", exact: true }).click();
  await first.evaluate((element) => element.remove());
  const calls = await page.evaluate(() => window.foldmarkScreenshotCalls);
  await page.getByRole("button", { name: "Attach screenshot", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("A selected element is detached");
  expect(await page.evaluate(() => window.foldmarkScreenshotCalls)).toBe(calls);
});

test("a note in a frame detaches when that frame navigates to another same-origin page with the same selector", async ({
  page,
}) => {
  await mount(page, { memory: true });
  await page.locator("#preview").evaluate((element) => {
    if (element instanceof HTMLIFrameElement) {
      element.removeAttribute("srcdoc");
      element.src = "/tests/browser/blank.html#frame-a";
    }
  });
  const target = page
    .frameLocator("#preview")
    .getByRole("button", { name: "Host button", exact: true });
  await expect(target).toBeVisible();
  await inspect(page);
  await target.click();
  await save(page, "Feedback belongs to frame A");
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit annotation 1", exact: true })).toBeVisible();
  await page.locator("#preview").evaluate((element) => {
    if (element instanceof HTMLIFrameElement) element.src = "/tests/browser/blank.html#frame-b";
  });
  await expect(target).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const modulePath = "/src/capture.ts";
        const { resolveTarget }: typeof import("../../src/capture") = await import(modulePath);
        const annotation = window.foldmarkFeatureTest.getAnnotations()[0];
        return annotation ? resolveTarget(annotation.target) === null : false;
      }),
    )
    .toBe(true);
  await expect(page.getByRole("button", { name: "Edit annotation 1", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Notes 1", exact: true }).click();
  await expect(
    page.getByText("Target detached or no longer accessible", { exact: true }),
  ).toBeVisible();
});

test("a delayed list snapshot cannot erase a concurrently submitted request or stop its status polling", async ({
  page,
}) => {
  await mount(page, { memory: true });
  await page.evaluate(async () => {
    window.foldmarkFeatureTest.dispose();
    window.foldmarkRaceRequests = [];
    window.foldmarkRaceLists = 0;
    const modulePath = "/src/index.ts";
    const { mountFoldmark }: typeof import("../../src/index") = await import(modulePath);
    const response = (value: unknown) =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    window.foldmarkFeatureTest = mountFoldmark({
      storage: false,
      feedback: {
        endpoint: "http://127.0.0.1:8899",
        token: "a".repeat(43),
        projectId: "race-project",
        fetch: async (_url, init) => {
          if (init?.method === "POST") {
            const input = JSON.parse(String(init.body));
            const request: FeedbackRequest = {
              id: input.requestId,
              projectId: "race-project",
              status: "pending",
              annotations: input.annotations,
              createdAt: "2026-10-15T00:00:00Z",
              updatedAt: "2026-10-15T00:00:00Z",
              revision: 1,
              claim: null,
              result: null,
            };
            window.foldmarkRaceRequests.push(request);
            return response(request);
          }
          window.foldmarkRaceLists++;
          const values = window.foldmarkRaceRequests.map((request) => ({
            ...request,
            status: "completed" as const,
            revision: 2,
            updatedAt: "2026-10-15T00:01:00Z",
            result: { message: "Checked and complete" },
          }));
          const snapshot = structuredClone({ requests: values });
          if (window.foldmarkRaceLists === 1)
            return await new Promise<Response>((resolve) => {
              window.foldmarkReleaseList = () => resolve(response(snapshot));
            });
          return response(snapshot);
        },
      },
    });
  });
  await inspect(page);
  await page.getByRole("button", { name: "First target", exact: true }).click();
  await save(page, "First agent request");
  await page.getByRole("button", { name: "Send to agent", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.foldmarkRaceLists)).toBe(1);
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await page.getByRole("button", { name: "Second target", exact: true }).click();
  await save(page, "Second agent request");
  await page.getByRole("button", { name: "Send to agent", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.foldmarkRaceRequests.length)).toBe(2);
  const secondId = await page.evaluate(() => window.foldmarkRaceRequests[1]?.id.slice(0, 12));
  if (!secondId) throw new Error("Missing second submission");
  await expect(page.getByRole("region", { name: "Agent requests" })).toContainText(secondId);
  await page.evaluate(() => window.foldmarkReleaseList());
  await expect(page.getByRole("region", { name: "Agent requests" })).toContainText(secondId);
  await expect(page.locator(".request-status.status-completed")).toHaveCount(2);
  expect(await page.evaluate(() => window.foldmarkRaceLists)).toBeGreaterThanOrEqual(2);
});
