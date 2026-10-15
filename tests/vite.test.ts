import { describe, expect, it } from "@effect/vitest";
import { resolveConfig } from "vite";
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import { foldmarkSourceHints } from "../src/vite";

const root = `${process.cwd().replace(/\\/g, "/")}/fixture-app`;
const file = `${root}/src/view.ts`;
const typed = `import type { HtmlBuilder } from 'foldkit/html';\n`;
const plugin = () => foldmarkSourceHints({ include: ["src/"], sourceRoot: root });

function transformed(code: string, id = file) {
  const result = plugin().transform(code, id);
  if (!result) throw new Error("Expected source hint instrumentation");
  return result;
}

describe("Foldkit development source hints", () => {
  it("instruments typed builders, aliases, namespaces and nested calls at original positions", () => {
    const code = `${typed}function view(h: HtmlBuilder<M>) { return h.div([], [h.button([], ['Save'])]) }`;
    const result = transformed(code);
    expect(result.code).toContain(`h.DataAttribute('foldmark-source', "src/view.ts:2:43")`);
    expect(result.code).toContain(`h.DataAttribute('foldmark-source', "src/view.ts:2:54")`);
    const alias = transformed(
      `import type { HtmlBuilder as Builder } from 'foldkit/html';\nconst view = (ui: Builder<M>) => ui.br([])`,
    );
    expect(alias.code).toContain(`ui.DataAttribute('foldmark-source'`);
    const namespace = transformed(
      `import type * as Html from 'foldkit/html';\nconst view = (ui: Html.HtmlBuilder<M>) => ui.svg([], [])`,
    );
    expect(namespace.code).toContain(`ui.DataAttribute('foldmark-source'`);
    const inert = transformed(
      `import { inertHtml as ih } from 'foldkit/html';\nconst node = ih.input([])`,
    );
    expect(inert.code).toContain(`ih.DataAttribute('foldmark-source'`);
  });

  it("does not mistake comments, strings, attributes, shadowed builders or unrelated objects for view calls", () => {
    const code = `${typed}
      const literal = 'h.button([], [])'; // h.div([], [])
      function unrelated(h: { button: Function }) { return h.button([], []) }
      function view(h: HtmlBuilder<M>) {
        const other = h.DataAttribute('test', 'h.span([], [])')
        { const h = {button: () => 1}; h.button([], []) }
        for (const h of others) h.button([], [])
        try { throw other } catch (h) { h.button([], []) }
        return h.button([other], ['Text'])
      }
    `;
    const result = transformed(code);
    expect(result.code.match(/DataAttribute\('foldmark-source'/g)).toHaveLength(1);
    expect(result.code).toContain(`const literal = 'h.button([], [])'`);
    expect(result.code).toContain("return h.button([], []) }");
  });

  it("keeps explicit attributes and annotate hints authoritative, with single evaluation and unchanged events", () => {
    const code = `function view(h) {
      const attrs = [h.OnClick(handler), ...annotate(h, { source: 'manual.ts:42' })]
      return h.button(attrs, ['Save'])
    }`;
    const result = foldmarkSourceHints({
      include: /fixture-app/,
      sourceRoot: root,
      builderNames: ["h"],
    }).transform(code, file);
    if (!result) throw new Error("Missing transform");
    const handler = () => "clicked";
    let calls = 0;
    const fake = {
      DataAttribute: (key: string, value: string) => ({ key: `data-${key}`, value }),
      OnClick: (value: typeof handler) => ({ key: "click", value }),
      button: (attrs: { key: string; value: unknown }[]) => {
        calls += 1;
        return Object.fromEntries(attrs.map((attr) => [attr.key, attr.value]));
      },
    };
    const annotate = (h: typeof fake, context: { source: string }) => [
      h.DataAttribute("foldmark-source", context.source),
    ];
    const run = new Function("h", "annotate", "handler", `${result.code}; return view(h)`);
    const output = run(fake, annotate, handler);
    expect(output["data-foldmark-source"]).toBe("manual.ts:42");
    expect(output.click).toBe(handler);
    expect(calls).toBe(1);
    expect(
      plugin().transform(
        `${typed}const view = (h: HtmlBuilder<M>) => h.button([h.DataAttribute('foldmark-source', 'manual')], [])`,
        file,
      ),
    ).toBeNull();
  });

  it("is idempotent for both array and expression attributes and supports TS generic syntax", () => {
    for (const attrs of ["[]", "attributes()"]) {
      const code = `${typed}const view = (h: HtmlBuilder<M>) => h.button<M>(${attrs}, [])`;
      const p = plugin();
      const first = p.transform(code, file);
      if (!first) throw new Error("Missing first transform");
      expect(p.transform(first.code, file)).toBeNull();
      expect(first.code).toContain("h.button<M>(");
    }
  });

  it("preserves source-map locations for host code after inserted metadata", () => {
    const code = `${typed}const view = (h: HtmlBuilder<M>) => h.button([h.Class('primary')], ['Save'])`;
    const result = transformed(code);
    const generatedIndex = result.code.indexOf("h.Class('primary')");
    const prefix = result.code.slice(0, generatedIndex).split("\n");
    const original = originalPositionFor(new TraceMap(result.map.toString(), file), {
      line: prefix.length,
      column: prefix.at(-1)?.length ?? 0,
    });
    expect(original.line).toBe(2);
    expect(original.column).toBe(code.split("\n")[1]?.indexOf("h.Class('primary')"));
    expect(original.source).toBe(file);
  });

  it("normalizes Windows paths and safely escapes quotes in source labels", () => {
    const p = foldmarkSourceHints({ include: "src", sourceRoot: "C:\\work\\app" });
    const result = p.transform(
      `${typed}const view = (h: HtmlBuilder<M>) => h.button([], [])`,
      'C:\\work\\app\\src\\say"hi.ts',
    );
    expect(result?.code).toContain('src/say\\"hi.ts:2:');
    expect(result?.code).not.toContain("C:\\work");
  });

  it("requires explicit include paths, excludes dependencies and widget internals, and disables production/build", async () => {
    const code = `${typed}const view = (h: HtmlBuilder<M>) => h.button([], [])`;
    expect(plugin().transform(code, `${root}/other/view.ts`)).toBeNull();
    expect(
      foldmarkSourceHints({ include: /./ }).transform(code, `${root}/node_modules/lib/view.ts`),
    ).toBeNull();
    expect(
      foldmarkSourceHints({ include: /./ }).transform(code, `${process.cwd()}/src/view.ts`),
    ).toBeNull();
    const p = plugin();
    const buildConfig = await resolveConfig({ configFile: false, root, plugins: [p] }, "build");
    expect(buildConfig.plugins.some((entry) => entry.name === p.name)).toBe(false);
    // Vite omits serve-only plugins from builds, so their configResolved hook is not called.
    // Also verify defensive behavior if a caller invokes that hook manually.
    p.configResolved(buildConfig);
    expect(p.transform(code, file)).toBeNull();
    const production = plugin();
    production.configResolved(
      await resolveConfig(
        { configFile: false, root, mode: "production", plugins: [production] },
        "serve",
      ),
    );
    expect(production.transform(code, file)).toBeNull();
  });
});
