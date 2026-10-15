import assert from "node:assert/strict";
import { createServer, preview } from "vite";
import { foldkit } from "@foldkit/vite-plugin";
import { chromium, expect, firefox, webkit } from "@playwright/test";

const engines = { chromium, firefox, webkit };
const requested = (process.env.FOLDMARK_CONSUMER_BROWSERS ?? "chromium").split(",");

const verifyBrowserWorkflow = async (url, mode) => {
  for (const name of requested) {
    const engine = engines[name];
    if (!engine) throw new Error(`Unknown consumer browser: ${name}`);
    const browser = await engine.launch();
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      await page.locator('#consumer-status[data-result="ready"]').waitFor();
      await page.getByRole("toolbar").waitFor();
      const initiallyMounted = await page.evaluate(() => {
        let duplicateRejected = false;
        try {
          window.foldmarkConsumer.mountDuplicate();
        } catch {
          duplicateRejected = true;
        }
        return {
          roots: document.querySelectorAll("[data-foldmark-root]").length,
          notes: window.foldmarkConsumer.handle.getAnnotations().length,
          duplicateRejected,
        };
      });
      assert.deepEqual(initiallyMounted, { roots: 1, notes: 0, duplicateRejected: true });
      await page.getByRole("button", { name: "⌖ Inspect", exact: true }).click();
      await page.locator("#consumer-target").click();
      await page.getByLabel("What should change?").waitFor();
      await page.getByLabel("What should change?").fill("Installed package note");
      await page.getByRole("button", { name: "Save note ↗" }).click();
      await page.getByText("Installed package note", { exact: true }).waitFor();
      assert.equal(
        await page.evaluate(() => window.foldmarkConsumer.handle.getAnnotations().length),
        1,
      );
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await page.getByLabel("What should change?").fill("Edited installed package note");
      await page.getByRole("button", { name: "Save note ↗" }).click();
      await page.getByText("Edited installed package note", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Export feedback ↗", exact: true }).click();
      await page.getByRole("button", { name: "JSON", exact: true }).click();
      const report = page.getByLabel("Feedback report");
      await expect(report).toHaveValue(/^\{/);
      const exported = JSON.parse(await report.inputValue());
      assert.equal(exported.annotations.length, 1);
      assert.equal(exported.annotations[0].note, "Edited installed package note");
      assert.equal(exported.annotations[0].target.selector, "#consumer-target");
      await page.getByRole("button", { name: "Notes 1", exact: true }).click();
      await page.getByRole("button", { name: "Resolve", exact: true }).click();
      await expect(page.getByRole("button", { name: "Notes 0", exact: true })).toBeVisible();
      assert.equal(
        await page.evaluate(() => window.foldmarkConsumer.handle.getAnnotations()[0].resolved),
        true,
      );
      await page.getByRole("button", { name: "Include resolved", exact: true }).click();
      await page.getByRole("button", { name: "Reopen", exact: true }).click();
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await expect(page.getByRole("button", { name: "Notes 0", exact: true })).toBeVisible();
      assert.equal(
        await page.evaluate(() => window.foldmarkConsumer.handle.getAnnotations().length),
        0,
      );
      const lifecycle = await page.evaluate(() => {
        window.foldmarkConsumer.handle.dispose();
        window.foldmarkConsumer.handle.dispose();
        const removed = document.querySelectorAll("[data-foldmark-root]").length;
        window.foldmarkConsumer.remount();
        const remounted = document.querySelectorAll("[data-foldmark-root]").length;
        window.foldmarkConsumer.handle.dispose();
        return {
          removed,
          remounted,
          remaining: document.querySelectorAll("[data-foldmark-root]").length,
        };
      });
      assert.deepEqual(lifecycle, { removed: 0, remounted: 1, remaining: 0 });
      assert.deepEqual(errors, []);
      console.log(`Packed ${mode} browser workflow passed in ${name}`);
    } finally {
      await browser.close();
    }
  }
};

const previewServer = await preview({
  configFile: false,
  root: process.cwd(),
  preview: { host: "127.0.0.1", port: 0, strictPort: true },
});
try {
  const address = previewServer.httpServer.address();
  if (!address || typeof address === "string") throw new Error("Missing consumer preview address");
  await verifyBrowserWorkflow(`http://127.0.0.1:${address.port}`, "production");
} finally {
  await new Promise((resolve, reject) =>
    previewServer.httpServer.close((error) => (error ? reject(error) : resolve())),
  );
}

const devServer = await createServer({
  configFile: false,
  root: process.cwd(),
  plugins: [...foldkit({ devToolsMcpPort: false })],
  // Foldkit uses the Effect barrel and Foldmark uses subpaths. Keep one Schema
  // instance in the pinned development optimizer, just as a consuming app must.
  optimizeDeps: { include: ["effect"] },
  server: { host: "127.0.0.1", port: 0, strictPort: true },
});
try {
  await devServer.listen();
  const address = devServer.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Missing consumer dev address");
  await verifyBrowserWorkflow(
    `http://127.0.0.1:${address.port}`,
    "development with Foldkit plugin",
  );
} finally {
  await devServer.close();
}
