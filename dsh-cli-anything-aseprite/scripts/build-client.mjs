/**
 * Build the browser half of the monitor panel (zero-dependency).
 *
 * `src/monitor.client.js` is authored as ESM for readability; the DSH web
 * module loader expects a bundle that registers a factory through
 * `window.__ModuleLoader__.load({ id, factory })` and receives only React
 * from the host module table. This script strips the import/export keywords
 * (the file uses a single flat scope) and wraps the body in that factory.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function stripEsm(src) {
  let out = src
    .replace(/import\s*\{[^}]*\}\s*from\s*['"][^'"]+['"];?\s*/g, '')
    .replace(/import\s*['"][^'"]+['"];?\s*/g, '')
    .replace(/^\s*import\s+[^;]+;?\s*$/gm, '')
  out = out
    .split('\n')
    .map((line) => {
      const t = line.trim()
      if (t.startsWith('export default ')) return line.replace('export default ', '')
      if (t.startsWith('export ')) return line.replace(/^export /, '')
      return line
    })
    .join('\n')
  return out
}

const src = stripEsm(readFileSync(resolve(root, 'src/monitor.client.js'), 'utf8'))

const out = [
  '/* cli-anything-aseprite monitor bundle — built by scripts/build-client.mjs. DO NOT EDIT. */',
  'window.__ModuleLoader__.load({',
  '\tid: "dsh-cli-anything-aseprite",',
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
  '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
  '\t\tconst React = require("react");',
  '',
  src,
  '',
  '\t\texports.name = name;',
  '\t\texports.inject = inject;',
  '\t\texports.apply = apply;',
  '\t\treturn module.exports;',
  '\t}',
  '});',
  ''
].join('\n')

mkdirSync(resolve(root, 'client'), { recursive: true })
writeFileSync(resolve(root, 'client/monitor.js'), out)
console.log('wrote client/monitor.js (' + out.length + ' bytes)')
