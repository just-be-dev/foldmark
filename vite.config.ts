import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig } from "vite";
import { foldmarkSourceHints } from "./src/vite";

export default defineConfig(({ command }) => ({
  // Preserve the demo model during reloads without exposing runtime DevTools transport.
  plugins:
    command === "serve"
      ? [foldmarkSourceHints({ include: "demo" }), ...foldkit({ devToolsMcpPort: false })]
      : [],
  // Foldkit imports the barrel while Foldmark uses Effect subpaths. Prebundle both
  // together so the pinned Vite toolchain does not create two Schema instances.
  optimizeDeps: { include: ["effect"] },
  build: {
    lib: {
      entry: {
        foldmark: "src/index.ts",
        transport: "src/transport.ts",
        feedback: "src/feedback.ts",
        "source-map": "src/source-map.ts",
      },
      formats: ["es"],
      fileName: (_format, name) => `${name}.js`,
    },
    rollupOptions: { external: [/^effect(\/|$)/, /^foldkit(\/|$)/, /^@effect\//] },
  },
}));
