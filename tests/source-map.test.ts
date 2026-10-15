// @vitest-environment happy-dom
import { describe, expect, it, vi } from "@effect/vitest";
import { createSourceResolver, type LoadedSourceMap } from "../src/source-map";

const source = "http://localhost:5173/assets/app.js";
const map = { version: 3, sources: ["../src/view.ts"], names: [], mappings: ";AASA" };
const attributes = (url = source) => ({
  "data-foldmark-source-url": url,
  "data-foldmark-source-line": "2",
  "data-foldmark-source-column": "1",
});
function element(attrs: Record<string, string> = {}, parent: Element | null = null): Element {
  const node = document.createElement("div");
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  parent?.append(node);
  return node;
}

describe("explicit source-map resolution", () => {
  it("does no I/O until resolution and never loads maps for explicit original hints", async () => {
    const loadSourceMap = vi.fn(async () => ({ map }));
    const resolver = createSourceResolver({ loadSourceMap });
    expect(loadSourceMap).not.toHaveBeenCalled();
    const context = { source: "manual.ts:42", modelPath: "cart" };
    expect(await resolver(element(attributes()), context)).toBe(context);
    expect(await resolver(element(), {})).toEqual({});
    expect(loadSourceMap).not.toHaveBeenCalled();
    resolver.dispose();
  });

  it("resolves an inherited generated location to its original TS source with one-based columns", async () => {
    const loadSourceMap = vi.fn(async () => ({ map, mapUrl: `${source}.map` }));
    const resolver = createSourceResolver({ loadSourceMap });
    const context = { modelPath: "checkout.address", message: "ClickedSave" };
    const child = element({}, element(attributes()));
    expect(await resolver(child, context)).toEqual({
      ...context,
      source: "http://localhost:5173/src/view.ts:10:1",
    });
    expect(loadSourceMap).toHaveBeenCalledWith(source, expect.any(AbortSignal));
    resolver.dispose();
  });

  it("does not combine URL/line/column across unrelated ancestors or accept invalid positions", async () => {
    const loadSourceMap = vi.fn(async () => ({ map }));
    const resolver = createSourceResolver({ loadSourceMap });
    expect(
      await resolver(element({ "data-foldmark-source-url": source }, element(attributes())), {}),
    ).toEqual({});
    for (const line of ["0", "-1", "NaN", "1.2"]) {
      expect(
        await resolver(element({ ...attributes(), "data-foldmark-source-line": line }), {}),
      ).toEqual({});
    }
    expect(loadSourceMap).not.toHaveBeenCalled();
    resolver.dispose();
  });

  it("deduplicates concurrent map loads, accepts JSON maps, and clears cached maps after HMR", async () => {
    let release: ((value: LoadedSourceMap) => void) | undefined;
    const pending = new Promise<LoadedSourceMap>((resolve) => {
      release = resolve;
    });
    const loadSourceMap = vi.fn(() => pending);
    const resolver = createSourceResolver({ loadSourceMap });
    const a = resolver(element(attributes()), {});
    const b = resolver(element(attributes()), {});
    await Promise.resolve();
    expect(loadSourceMap).toHaveBeenCalledTimes(1);
    if (!release) throw new Error("Missing deferred resolver");
    release({ map: JSON.stringify(map), mapUrl: `${source}.map` });
    expect(await a).toEqual(await b);
    expect((await resolver(element(attributes()), {})).source).toContain("view.ts:10:1");
    expect(loadSourceMap).toHaveBeenCalledTimes(1);
    resolver.clearCache();
    await resolver(element(attributes()), {});
    expect(loadSourceMap).toHaveBeenCalledTimes(2);
    resolver.dispose();
  });

  it("bounds map caches and does not permanently cache missing, malformed or failed maps", async () => {
    const loadSourceMap = vi.fn(async () => ({ map }));
    const resolver = createSourceResolver({ loadSourceMap, maxCacheEntries: 1 });
    await resolver(element(attributes("http://localhost:5173/a.js")), {});
    await resolver(element(attributes("http://localhost:5173/b.js")), {});
    await resolver(element(attributes("http://localhost:5173/a.js")), {});
    expect(loadSourceMap).toHaveBeenCalledTimes(3);
    resolver.dispose();
    for (const loaded of [null, { map: "{bad JSON" }, { map: { version: 2 } }]) {
      const loader = vi.fn(async () => loaded);
      const invalid = createSourceResolver({ loadSourceMap: loader });
      expect(await invalid(element(attributes()), {})).toEqual({});
      expect(await invalid(element(attributes()), {})).toEqual({});
      expect(loader).toHaveBeenCalledTimes(2);
      invalid.dispose();
    }
    const failed = createSourceResolver({
      loadSourceMap: async () => {
        throw new Error("offline");
      },
    });
    expect(await failed(element(attributes()), { message: "KeepMe" })).toEqual({
      message: "KeepMe",
    });
    failed.dispose();
  });

  it("walks open shadow hosts safely, tolerates inaccessible frame owners, and never fetches implicitly", async () => {
    const network = vi.spyOn(globalThis, "fetch");
    const loader = vi.fn(async () => ({ map }));
    const resolver = createSourceResolver({ loadSourceMap: loader });
    try {
      const shadowChild = element();
      Object.defineProperty(shadowChild, "getRootNode", {
        value: () => ({ nodeType: 11, host: element(attributes()) }),
      });
      expect((await resolver(shadowChild, {})).source).toContain("view.ts:10:1");
      const blockedFrameChild = element();
      Object.defineProperty(blockedFrameChild, "ownerDocument", {
        value: {
          defaultView: {
            get frameElement() {
              throw new Error("Cross-origin access blocked");
            },
          },
        },
      });
      expect(await resolver(blockedFrameChild, {})).toEqual({});
      expect(loader).toHaveBeenCalledTimes(1);
      expect(network).not.toHaveBeenCalled();
    } finally {
      resolver.dispose();
      network.mockRestore();
    }
  });

  it("allows explicit generated-location providers without inventing DOM linkage", async () => {
    const resolver = createSourceResolver({
      loadSourceMap: () => ({ map }),
      resolveGenerated: () => ({ source, line: 2, column: 1 }),
    });
    expect((await resolver(element(), {})).source).toBe("http://localhost:5173/src/view.ts:10:1");
    resolver.dispose();
    expect(() => createSourceResolver({ loadSourceMap: () => null, maxCacheEntries: 0 })).toThrow();
  });

  it("aborts opted-in loader work and discards pending results on dispose or cache invalidation", async () => {
    let release: ((value: LoadedSourceMap) => void) | undefined;
    let signal: AbortSignal | undefined;
    const resolver = createSourceResolver({
      loadSourceMap: (_, abort) => {
        signal = abort;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    const pending = resolver(element(attributes()), {});
    await Promise.resolve();
    resolver.dispose();
    expect(signal?.aborted).toBe(true);
    if (!release) throw new Error("Missing deferred resolver");
    release({ map });
    expect(await pending).toEqual({});
    expect(await resolver(element(attributes()), {})).toEqual({});
    const invalidated = createSourceResolver({
      loadSourceMap: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const stale = invalidated(element(attributes()), {});
    await Promise.resolve();
    invalidated.clearCache();
    if (!release) throw new Error("Missing deferred resolver");
    release({ map });
    expect(await stale).toEqual({});
    invalidated.dispose();
  });
});
