import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { mountFoldmark, toJson, toMarkdown } from 'foldmark'

const installedModule = fileURLToPath(import.meta.resolve('foldmark'))
assert.ok(
  installedModule.startsWith((await realpath('node_modules/foldmark')) + '/'),
  `Import escaped the installed tarball: ${installedModule}`,
)
assert.equal(typeof document, 'undefined')
const handle = mountFoldmark()
assert.deepEqual(handle.getAnnotations(), [])
handle.dispose()
handle.dispose()
assert.deepEqual(mountFoldmark({ enabled: false }).getAnnotations(), [])
assert.deepEqual(JSON.parse(toJson([])).annotations, [])
assert.match(toMarkdown([]), /Foldmark feedback/)
const installedRoot = await realpath('node_modules/foldmark')
const manifest = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8'))
for (const entry of Object.keys(manifest.exports)) {
  if (entry.endsWith('.json')) continue
  const specifier = entry === '.' ? manifest.name : manifest.name + entry.slice(1)
  const module = await import(specifier)
  assert.ok(Object.keys(module).length > 0, `Empty ESM entrypoint: ${specifier}`)
  console.log(`Packed ESM entrypoint imported: ${specifier}`)
}
const cli = manifest.bin?.['foldmark-server']
assert.equal(typeof cli, 'string', 'Missing packaged foldmark-server CLI')
const help = spawnSync(process.execPath, [join(installedRoot, cli), '--help'], {
  encoding: 'utf8',
  timeout: 10_000,
})
assert.equal(help.status, 0, `Installed CLI --help failed: ${help.stderr || help.error?.message}`)
assert.equal(help.stdout, '', 'CLI help must not pollute MCP stdout')
assert.match(help.stderr, /foldmark-server/i)
console.log('Installed CLI help passed with clean protocol stdout')
console.log('Packed ESM/SSR smoke passed with no document or browser globals')
