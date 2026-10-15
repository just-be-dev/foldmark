import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import type { SourceContext } from "./capture";

const PositiveInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
/** All public positions use one-based lines AND columns. */
export const SourcePosition = Schema.Struct({
  source: Schema.NonEmptyString,
  line: PositiveInteger,
  column: PositiveInteger,
});
export interface SourcePosition extends Schema.Schema.Type<typeof SourcePosition> {}

const EncodedSourceMap = Schema.Struct({
  version: Schema.Literal(3),
  sources: Schema.Array(Schema.NullOr(Schema.String)),
  names: Schema.Array(Schema.String),
  mappings: Schema.String,
  sourceRoot: Schema.optionalKey(Schema.String),
  file: Schema.optionalKey(Schema.NullOr(Schema.String)),
  sourcesContent: Schema.optionalKey(Schema.Array(Schema.NullOr(Schema.String))),
});

export interface LoadedSourceMap {
  /** A v3 encoded source-map object or its JSON string. Decoded/indexed maps are not accepted. */
  map: unknown;
  /** Absolute URL/path of this map, used to resolve relative original sources. */
  mapUrl?: string;
}
export interface SourceResolverOptions {
  /** The sole I/O seam. Callers must allowlist URLs and own any authorization. No default fetch. */
  loadSourceMap: (
    generatedSourceUrl: string,
    signal: AbortSignal,
  ) => LoadedSourceMap | null | Promise<LoadedSourceMap | null>;
  /** Defaults to inherited data-foldmark-source-url/line/column attributes. */
  resolveGenerated?: (element: Element, context: SourceContext) => SourcePosition | null;
  /** Bounds cached map promises, including in-flight loads. Default 32, maximum 256. */
  maxCacheEntries?: number;
}
export interface SourceResolver {
  (element: Element, context: SourceContext): Promise<SourceContext>;
  clearCache(): void;
  /** Aborts opted-in loader work and prevents subsequent resolution. */
  dispose(): void;
}

function parentOf(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  const isShadowRoot = (node: Node): node is ShadowRoot => node.nodeType === 11 && "host" in node;
  if (isShadowRoot(root)) return root.host;
  try {
    return element.ownerDocument.defaultView?.frameElement ?? null;
  } catch {
    return null;
  }
}

function generatedPosition(element: Element): SourcePosition | null {
  let current: Element | null = element;
  while (current) {
    const source = current.getAttribute("data-foldmark-source-url");
    if (source) {
      // Read the tuple from ONE ancestor: never combine one element's URL with another's columns.
      const line = current.getAttribute("data-foldmark-source-line");
      const column = current.getAttribute("data-foldmark-source-column");
      if (!line || !column || !/^\d+$/.test(line) || !/^\d+$/.test(column)) return null;
      return Option.getOrNull(
        Schema.decodeOption(SourcePosition)({
          source,
          line: Number(line),
          column: Number(column),
        }),
      );
    }
    current = parentOf(current);
  }
  return null;
}

/**
 * Resolves a known generated call site, not an arbitrary DOM node, through a host-supplied map.
 * Original explicit/plugin hints take precedence. Missing, invalid or failed maps preserve context.
 */
export function createSourceResolver(options: SourceResolverOptions): SourceResolver {
  const maximum = options.maxCacheEntries ?? 32;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 256)
    throw new Error("maxCacheEntries must be an integer from 1 to 256");
  const controller = new AbortController();
  const maps = new Map<string, Promise<TraceMap | null>>();
  let disposed = false;
  let generation = 0;
  const load = (source: string): Promise<TraceMap | null> => {
    const cached = maps.get(source);
    if (cached) {
      maps.delete(source);
      maps.set(source, cached);
      return cached;
    }
    const pending = Promise.resolve()
      .then(async () => {
        const loaded = await options.loadSourceMap(source, controller.signal);
        if (!loaded || disposed) return null;
        try {
          const json: unknown =
            typeof loaded.map === "string" ? JSON.parse(loaded.map) : loaded.map;
          const map = Option.getOrNull(Schema.decodeUnknownOption(EncodedSourceMap)(json));
          if (!map) return null;
          return new TraceMap(map, loaded.mapUrl ?? source);
        } catch {
          return null;
        }
      })
      .catch(() => null);
    maps.set(source, pending);
    while (maps.size > maximum) {
      const oldest = maps.keys().next().value;
      if (oldest === undefined) break;
      maps.delete(oldest);
    }
    // Failed/missing maps may become available after HMR; don't permanently cache failure.
    void pending.then((map) => {
      if (!map && maps.get(source) === pending) maps.delete(source);
    });
    return pending;
  };
  const resolver: SourceResolver = async (element, context) => {
    if (disposed || context.source) return context;
    const currentGeneration = generation;
    try {
      const generated = (options.resolveGenerated ?? generatedPosition)(element, context);
      const position = Option.getOrNull(Schema.decodeUnknownOption(SourcePosition)(generated));
      if (!position) return context;
      const map = await load(position.source);
      if (!map || disposed || generation !== currentGeneration) return context;
      const original = originalPositionFor(map, {
        line: position.line,
        column: position.column - 1,
      });
      if (!original.source || original.line === null || original.column === null) return context;
      return { ...context, source: `${original.source}:${original.line}:${original.column + 1}` };
    } catch {
      // Source hints are supplementary. A failed host loader must not block annotation capture.
      return context;
    }
  };
  resolver.clearCache = () => {
    generation += 1;
    maps.clear();
  };
  resolver.dispose = () => {
    disposed = true;
    generation += 1;
    maps.clear();
    controller.abort();
  };
  return resolver;
}
