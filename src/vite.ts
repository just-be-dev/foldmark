import { parse } from '@babel/parser'
import MagicString from 'magic-string'
import { posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin, ResolvedConfig } from 'vite'

export interface SourceHintsOptions {
  /** Explicit application paths only. Strings are root-relative directory/file prefixes. */
  include: string | RegExp | readonly (string | RegExp)[] | ((id: string) => boolean)
  /** Explicitly trust these untyped identifiers as Foldkit builders. Typed builders need no option. */
  builderNames?: readonly string[]
  /** Base for source labels; defaults to Vite's root. Does not change Vite's root. */
  sourceRoot?: string
}

interface SyntaxNode {
  type: string
  start?: number | null
  end?: number | null
  loc?: { start: { line: number; column: number } } | null
  [key: string]: unknown
}
const isNode = (value: unknown): value is SyntaxNode =>
  typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'
const identifier = (value: unknown): string | null =>
  isNode(value) && value.type === 'Identifier' && typeof value.name === 'string' ? value.name : null
const childNodes = (node: SyntaxNode): SyntaxNode[] =>
  Object.values(node).flatMap((value) =>
    Array.isArray(value) ? value.filter(isNode) : isNode(value) ? [value] : [],
  )
const normalize = (path: string) => path.replace(/\\/g, '/')
const pluginDirectory = normalize(fileURLToPath(new URL('.', import.meta.url)))
const tags = new Set(
  (
    'a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark menu meta meter nav noscript object ol optgroup option output p picture portal pre progress q rp rt ruby s samp script search section select slot small source span strong style sub summary sup table tbody td template textarea tfoot th thead time title tr track u ul var video wbr ' +
    'animate animateMotion animateTransform circle clipPath defs desc ellipse feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feImage feMerge feMergeNode feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence filter foreignObject g image line linearGradient marker mask metadata mpath path pattern polygon polyline radialGradient rect set stop svg switch symbol text textPath tspan use view ' +
    'annotation annotation-xml math maction menclose merror mfenced mfrac mglyph mi mlabeledtr mlongdiv mmultiscripts mn mo mover mpadded mphantom mprescripts mroot mrow ms mscarries mscarry msgroup msline mspace msqrt msrow mstack mstyle msub msubsup msup mtable mtd mtext mtr munder munderover semantics'
  ).split(' '),
)
const isFunction = (node: SyntaxNode) =>
  /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|ObjectMethod|ClassMethod|ClassPrivateMethod)$/.test(
    node.type,
  )
const isScope = (node: SyntaxNode) =>
  isFunction(node) ||
  [
    'Program',
    'BlockStatement',
    'CatchClause',
    'ForStatement',
    'ForInStatement',
    'ForOfStatement',
    'SwitchStatement',
  ].includes(node.type)

function patternNames(pattern: unknown): string[] {
  if (!isNode(pattern)) return []
  const name = identifier(pattern)
  if (name) return [name]
  if (pattern.type === 'AssignmentPattern') return patternNames(pattern.left)
  if (pattern.type === 'RestElement') return patternNames(pattern.argument)
  if (pattern.type === 'ObjectProperty') return patternNames(pattern.value)
  return childNodes(pattern).flatMap(patternNames)
}

function bindings(scope: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = []
  if (isFunction(scope)) {
    if (Array.isArray(scope.params)) result.push(...scope.params.filter(isNode))
    if (isNode(scope.id)) result.push(scope.id)
  }
  if (scope.type === 'CatchClause' && isNode(scope.param)) result.push(scope.param)
  const loopDeclaration = scope.type === 'ForStatement' ? scope.init : scope.left
  if (
    isNode(loopDeclaration) &&
    loopDeclaration.type === 'VariableDeclaration' &&
    Array.isArray(loopDeclaration.declarations)
  ) {
    for (const item of loopDeclaration.declarations) {
      if (isNode(item) && isNode(item.id)) result.push(item.id)
    }
  }
  const statements =
    scope.type === 'SwitchStatement' && Array.isArray(scope.cases)
      ? scope.cases.flatMap((item) =>
          isNode(item) && Array.isArray(item.consequent) ? item.consequent : [],
        )
      : Array.isArray(scope.body)
        ? scope.body
        : []
  for (const statement of statements) {
    if (!isNode(statement)) continue
    const declaration = statement.type.startsWith('Export') ? statement.declaration : statement
    if (!isNode(declaration)) continue
    if (declaration.type === 'ImportDeclaration' && Array.isArray(declaration.specifiers)) {
      result.push(...declaration.specifiers.filter(isNode))
    } else if (
      declaration.type === 'VariableDeclaration' &&
      Array.isArray(declaration.declarations)
    ) {
      for (const item of declaration.declarations) {
        if (isNode(item) && isNode(item.id)) result.push(item.id)
      }
    } else if (
      ['FunctionDeclaration', 'ClassDeclaration'].includes(declaration.type) &&
      isNode(declaration.id)
    ) {
      result.push(declaration.id)
    }
  }
  return result
}

function bindingName(binding: SyntaxNode): string[] {
  return binding.type.startsWith('Import') ? patternNames(binding.local) : patternNames(binding)
}

function matchesInclude(include: SourceHintsOptions['include'], id: string, root: string): boolean {
  if (typeof include === 'function') return include(id)
  const patterns = Array.isArray(include) ? include : [include]
  return patterns.some((pattern) => {
    if (typeof pattern === 'string') {
      const normalized = normalize(pattern).replace(/\/$/, '')
      const prefix =
        posix.isAbsolute(normalized) || /^[a-z]:\//i.test(normalized)
          ? normalized
          : posix.join(root, normalized)
      return id === prefix || id.startsWith(`${prefix}/`)
    }
    // Do not let /g or /y mutate matching behavior between modules.
    return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '')).test(id)
  })
}

/** Development-only linkage from supported Foldkit view calls to their original source. */
export function foldmarkSourceHints(options: SourceHintsOptions) {
  let root = normalize(options.sourceRoot ?? process.cwd()).replace(/\/$/, '')
  let enabled = true
  const explicitBuilders = new Set(options.builderNames ?? [])
  return {
    name: 'foldmark-source-hints',
    apply: 'serve',
    enforce: 'pre',
    configResolved(config: ResolvedConfig) {
      root = normalize(options.sourceRoot ?? config.root).replace(/\/$/, '')
      enabled = config.command === 'serve' && !config.isProduction && config.mode !== 'production'
    },
    transform(code: string, id: string) {
      const file = normalize(id.split(/[?#]/, 1)[0] ?? id)
      if (
        !enabled ||
        id.includes('\0') ||
        !/\.[cm]?[jt]sx?$/.test(file) ||
        /(^|\/)node_modules\//.test(file) ||
        file.startsWith(pluginDirectory) ||
        !matchesInclude(options.include, file, root)
      )
        return null
      const ast = parse(code, {
        sourceType: 'unambiguous',
        plugins: [
          ...(/\.[cm]?tsx?$/.test(file) ? ['typescript' as const] : []),
          ...(/\.[jt]sx$/.test(file) ? ['jsx' as const] : []),
          'decorators',
        ],
      })
      const builderTypes = new Set<string>()
      const namespaces = new Set<string>()
      const inertImports = new Set<SyntaxNode>()
      for (const statement of ast.program.body) {
        if (statement.type !== 'ImportDeclaration' || statement.source.value !== 'foldkit/html')
          continue
        for (const specifier of statement.specifiers) {
          if (specifier.type === 'ImportNamespaceSpecifier') namespaces.add(specifier.local.name)
          if (specifier.type === 'ImportSpecifier') {
            const imported =
              specifier.imported.type === 'Identifier'
                ? specifier.imported.name
                : specifier.imported.value
            if (imported === 'HtmlBuilder') builderTypes.add(specifier.local.name)
            if (imported === 'inertHtml' && isNode(specifier)) inertImports.add(specifier)
          }
        }
      }
      const isBuilder = (name: string, ancestors: SyntaxNode[]) => {
        for (const scope of [...ancestors].reverse().filter(isScope)) {
          const binding = bindings(scope).find((item) => bindingName(item).includes(name))
          if (!binding) continue
          if (inertImports.has(binding)) return true
          const target = binding.type === 'AssignmentPattern' ? binding.left : binding
          const annotation =
            isNode(target) && isNode(target.typeAnnotation)
              ? target.typeAnnotation.typeAnnotation
              : null
          if (isNode(annotation) && annotation.type === 'TSTypeReference') {
            const typeName = annotation.typeName
            if (builderTypes.has(identifier(typeName) ?? '')) return true
            if (
              isNode(typeName) &&
              typeName.type === 'TSQualifiedName' &&
              namespaces.has(identifier(typeName.left) ?? '') &&
              identifier(typeName.right) === 'HtmlBuilder'
            )
              return true
          }
          return explicitBuilders.has(name)
        }
        return explicitBuilders.has(name)
      }
      const output = new MagicString(code)
      let changed = false
      const source = posix.relative(root, file) || posix.basename(file)
      const visit = (node: SyntaxNode, ancestors: SyntaxNode[]) => {
        if (
          node.type === 'CallExpression' &&
          isNode(node.callee) &&
          node.callee.type === 'MemberExpression' &&
          node.callee.computed === false
        ) {
          const builder = identifier(node.callee.object)
          const tag = identifier(node.callee.property)
          const args = Array.isArray(node.arguments) ? node.arguments : []
          const attributes = args[0]
          if (
            builder &&
            tag &&
            tags.has(tag) &&
            isBuilder(builder, ancestors) &&
            isNode(attributes) &&
            attributes.type !== 'SpreadElement' &&
            typeof attributes.start === 'number' &&
            typeof attributes.end === 'number' &&
            node.loc
          ) {
            const existing =
              attributes.type === 'ArrayExpression' && Array.isArray(attributes.elements)
                ? attributes.elements.some((attribute) => {
                    if (
                      !isNode(attribute) ||
                      attribute.type !== 'CallExpression' ||
                      !isNode(attribute.callee) ||
                      attribute.callee.type !== 'MemberExpression' ||
                      !Array.isArray(attribute.arguments)
                    )
                      return false
                    const key = attribute.arguments[0]
                    return (
                      identifier(attribute.callee.object) === builder &&
                      identifier(attribute.callee.property) === 'DataAttribute' &&
                      isNode(key) &&
                      key.type === 'StringLiteral' &&
                      key.value === 'foldmark-source'
                    )
                  })
                : false
            if (!existing) {
              const hint = `${source}:${node.loc.start.line}:${node.loc.start.column + 1}`
              const attribute = `${builder}.DataAttribute('foldmark-source', ${JSON.stringify(hint)})`
              if (attributes.type === 'ArrayExpression') {
                output.appendLeft(
                  attributes.start + 1,
                  `${attribute}${code.slice(attributes.start + 1, attributes.end - 1).trim() ? ', ' : ''}`,
                )
              } else {
                output.appendLeft(attributes.start, `[${attribute}, ...(`)
                output.appendRight(attributes.end, ')]')
              }
              changed = true
            }
          }
        }
        for (const child of childNodes(node)) visit(child, [...ancestors, node])
      }
      if (isNode(ast)) visit(ast, [])
      return changed
        ? {
            code: output.toString(),
            map: output.generateMap({ source: file, file, includeContent: true, hires: true }),
          }
        : null
    },
  } satisfies Plugin
}
