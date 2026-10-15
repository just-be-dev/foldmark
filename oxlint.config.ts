import { defineConfig } from "oxlint";
import effect from "@mpsuesser/oxlint-plugin-effect";
import foldkit from "@foldkit/oxlint-plugin";

export default defineConfig({
  jsPlugins: [...effect.configs.recommended.jsPlugins, ...foldkit.configs.recommended.jsPlugins],
  ignorePatterns: ["dist/**", "demo-dist/**", "test-results/**", "playwright-report/**"],
  rules: {
    "effect/avoid-non-null-assertion": "error",
    "effect/no-chained-type-assertions": "error",
    "effect/no-module-mocking": "error",
  },
  overrides: [
    { files: ["src/**/*.ts", "demo/**/*.ts"], rules: foldkit.configs.recommended.rules },
    ...foldkit.configs.recommended.overrides,
  ],
});
