import { expect, test, type Page } from "@playwright/test";

const inspect = async (page: Page) => {
  await page.getByRole("button", { name: "⌖ Inspect", exact: true }).click();
  await expect(page.getByRole("button", { name: "⌖ Inspecting", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
};
const addNote = async (page: Page, note = "Give this control more breathing room.") => {
  await inspect(page);
  await page.getByTestId("task-type").click();
  await page.getByLabel("What should change?").fill(note);
  await page.getByRole("button", { name: "Save note ↗" }).click();
  await expect(page.getByText(note, { exact: true })).toBeVisible();
};
test.beforeEach(async ({ page }) => {
  // External font availability must not change layout or screenshot baselines.
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.abort());
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
});

test("captures without triggering host, persists, edits, resolves and exports", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await addNote(page);
  await expect(page.getByTestId("task-type")).toHaveAttribute("aria-pressed", "false");
  await page.reload();
  await page.getByRole("button", { name: "Notes 1", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("What should change?").fill("Make the hit area larger.");
  await page.getByLabel("What should change?").press("Control+Enter");
  await page.getByRole("button", { name: "Export feedback ↗" }).click();
  const report = page.getByLabel("Feedback report");
  await expect(report).toHaveValue(/data-testid="task-type"/);
  await expect(report).toHaveValue(/Model path: `completed`/);
  await expect(report).toHaveValue(/Message: `ClickedTask`/);
  await expect(report).toHaveValue(/Make the hit area larger/);
  // Firefox/WebKit do not expose Chromium's clipboard permission names. Exercise
  // the clipboard boundary deterministically in every engine instead.
  await page.evaluate(() => {
    let copied = "";
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) => {
          copied = text;
        },
        readText: async () => copied,
      },
      configurable: true,
    });
  });
  await page.getByRole("button", { name: "Copy report ↗" }).click();
  await expect(page.getByRole("status")).toHaveText("Copied. Ready for your agent.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "Make the hit area larger.",
  );
  await page.getByRole("button", { name: "JSON", exact: true }).click();
  await expect(report).toHaveValue(/^\{/);
  expect(JSON.parse(await report.inputValue()).annotations).toHaveLength(1);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  expect((await download).suggestedFilename()).toBe("foldmark-feedback.json");
  await page.getByRole("button", { name: "Notes 1", exact: true }).click();
  await page.getByRole("button", { name: "Resolve", exact: true }).click();
  await expect(page.getByRole("button", { name: "Notes 0", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Include resolved" }).click();
  await page.getByRole("button", { name: "Reopen", exact: true }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("button", { name: "Notes 0", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("host controls work normally, keyboard toggle and escape are reversible", async ({ page }) => {
  await page.getByTestId("task-type").click();
  await expect(page.getByTestId("task-type")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Alt+Shift+KeyA");
  await expect(page.getByRole("button", { name: "⌖ Inspecting", exact: true })).toBeVisible();
  await page.getByTestId("task-space").click();
  await expect(page.getByLabel("What should change?")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "⌖ Inspect", exact: true })).toBeVisible();
});

test("notes are scoped to route and survive navigation back", async ({ page }) => {
  await addNote(page);
  await page.evaluate(() => history.pushState({}, "", "/another"));
  await expect(page.getByRole("button", { name: "Notes 0", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("button", { name: "Notes 1", exact: true })).toBeVisible();
});

test("invalid storage recovers visibly and clipboard failures keep the report", async ({
  page,
}) => {
  await page.evaluate(() => localStorage.setItem("foldmark:v1", "{invalid"));
  await page.reload();
  await expect(page.getByRole("status")).toContainText("Could not restore");
  await addNote(page);
  await page.getByRole("button", { name: "Export feedback ↗" }).click();
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("denied")) },
      configurable: true,
    }),
  );
  await page.getByRole("button", { name: "Copy report ↗" }).click();
  await expect(page.getByRole("status")).toContainText("Clipboard unavailable");
  await expect(page.getByLabel("Feedback report")).toHaveValue(/Give this control/);
});

test("selectors distinguish duplicate IDs and escape punctuation; private text is excluded", async ({
  page,
}) => {
  const results = await page.evaluate(async () => {
    const path = "/src/capture.ts";
    const { selectorFor, capture } = await import(path);
    const fixture = document.createElement("section");
    fixture.innerHTML =
      '<button id="duplicate">One</button><button id="duplicate" class="a:b">Two</button><div id="private-test">Public <span data-foldmark-private>SECRET</span><input value="PASSWORD"></div>';
    document.body.append(fixture);
    const buttons = [...fixture.querySelectorAll("button")];
    const selectors = buttons.map((button) => selectorFor(button));
    const privateTarget = fixture.querySelector("#private-test");
    const result = {
      unique: selectors.every(
        (selector, index) =>
          document.querySelectorAll(selector).length === 1 &&
          document.querySelector(selector) === buttons[index],
      ),
      text: capture(privateTarget).text,
    };
    fixture.remove();
    return result;
  });
  expect(results.unique).toBe(true);
  expect(results.text).toBe("Public");
});

test("pause only resumes running animations, and mount/dispose removes listeners", async ({
  page,
}) => {
  await page.evaluate(() => {
    const fixture = document.createElement("div");
    fixture.id = "animation-fixture";
    document.body.append(fixture);
    fixture.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 10000, iterations: Infinity });
  });
  await page.getByRole("button", { name: "Pause animations", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.getElementById("animation-fixture")?.getAnimations()[0]?.playState,
      ),
    )
    .toBe("paused");
  await page.getByRole("button", { name: "Resume animations", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.getElementById("animation-fixture")?.getAnimations()[0]?.playState,
      ),
    )
    .toBe("running");
  // A separate page has no demo runtime; exercise the public lifecycle API.
  await page.goto("/tests/browser/blank.html");
  const result = await page.evaluate(async () => {
    const path = "/src/index.ts";
    const { mountFoldmark } = await import(path);
    const first = mountFoldmark({ storage: false });
    const mounted = document.querySelectorAll("[data-foldmark-root]").length;
    first.dispose();
    first.dispose();
    const removed = document.querySelectorAll("[data-foldmark-root]").length;
    const second = mountFoldmark({ storage: false });
    second.dispose();
    return {
      mounted,
      removed,
      remaining: document.querySelectorAll("[data-foldmark-root]").length,
    };
  });
  expect(result).toEqual({ mounted: 1, removed: 0, remaining: 0 });
});

test("mobile layout keeps toolbar and composer in the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await addNote(page);
  const panel = await page.getByRole("region", { name: "Feedback notes" }).boundingBox();
  expect(panel).not.toBeNull();
  if (panel) {
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(390);
  }
  await expect(page).toHaveScreenshot("foldmark-mobile.png", { fullPage: true });
});

test("desktop visual", async ({ page }) => {
  await expect(page.getByRole("toolbar")).toBeVisible();
  await expect(page).toHaveScreenshot("foldmark-desktop.png", { fullPage: true });
});
