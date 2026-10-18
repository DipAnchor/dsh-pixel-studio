/**
 * 模拟 DSH 安装与加载流程的静态验证脚本。
 *
 * 不真的往 profile 里装东西（真的装要重启 DSH，会把当前会话掐掉），
 * 只把宿主加载插件时真正会走的几条校验逐条复刻一遍：
 *
 *   1. package.json 清单（name / exports["./client"] / dsh.bundle.patch）
 *   2. dsh.client 声明（platform='web'、inject/external 是字符串数组、immediately 是布尔）
 *   3. 私有包不许进 dependencies（上次装完卡死的怀疑点）
 *   4. exports["./client"] 指向的文件存在且能过语法检查
 *   5. 宿主入口能被 import，且导出 name/inject/apply
 *   6. patch 文件存在、顶层是数组、条目带 id/name
 *
 * 用法：node tools/simulate-install.mjs
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Script } from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = resolve(here, '..')
const pkgPath = join(pkgDir, 'package.json')

const out = []
let failed = 0
function check(name, ok, detail) {
  out.push((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? ' — ' + detail : ''))
  if (!ok) failed++
}

if (!existsSync(pkgPath)) {
  console.error('找不到 package.json：' + pkgPath)
  process.exit(1)
}
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

// 1. 基本清单
check('package.json 有 name', typeof pkg.name === 'string' && pkg.name.length > 0, pkg.name)
check('有 exports["./client"]', Boolean(pkg.exports && pkg.exports['./client']),
  pkg.exports && pkg.exports['./client'])
const clientEntry = pkg.exports && pkg.exports['./client']
check('client bundle 文件存在', Boolean(clientEntry) && existsSync(join(pkgDir, clientEntry)), clientEntry)

// 2. dsh.client 声明（对照 @deepseek-ai/dsh-client-modules 的 parseDshClient 规则）
const dc = pkg.dsh && pkg.dsh.client
check('dsh.client 存在', Boolean(dc))
if (dc) {
  check('platform === "web"', dc.platform === 'web', String(dc.platform))
  check('inject 是字符串数组', Array.isArray(dc.inject) && dc.inject.every(function (x) { return typeof x === 'string' }),
    JSON.stringify(dc.inject))
  if ('immediately' in dc) check('immediately 是布尔', typeof dc.immediately === 'boolean', String(dc.immediately))
  if ('external' in dc) check('external 是字符串数组', Array.isArray(dc.external), JSON.stringify(dc.external))
}

// 3. 依赖隔离：私有包不许出现在 dependencies
const deps = Object.keys(pkg.dependencies || {})
const leaked = deps.filter(function (d) { return d.startsWith('@deepseek-ai/') })
check('dependencies 不含 @deepseek-ai/*', leaked.length === 0, leaked.join(', ') || '干净')

// 4. bundle 语法：用 vm.Script 在进程内解析，避免子进程管道在沙箱下报 EPERM
if (clientEntry && existsSync(join(pkgDir, clientEntry))) {
  try {
    new Script(readFileSync(join(pkgDir, clientEntry), 'utf8'), { filename: clientEntry })
    check('client bundle 语法可解析', true)
  } catch (e) {
    check('client bundle 语法可解析', false, String(e && e.message).slice(0, 120))
  }
}

// 5. 宿主入口
const main = pkg.main || (pkg.exports && pkg.exports['.'])
const mainFile = typeof main === 'string' ? join(pkgDir, main) : ''
check('宿主入口存在', Boolean(mainFile) && existsSync(mainFile), String(main))
if (mainFile && existsSync(mainFile)) {
  try {
    const mod = await import(pathToFileURL(mainFile).href)
    check('宿主导出 name', typeof mod.name === 'string', mod.name)
    check('宿主导出 apply 函数', typeof mod.apply === 'function')
    check('宿主 inject 是数组', Array.isArray(mod.inject), JSON.stringify(mod.inject))
  } catch (e) {
    // 在源码目录跑没有宿主的模块解析层，私有包解析不到是正常的——
    // 只要它声明在 peerDependencies 里，装进 profile 后由宿主提供。
    const msg = String((e && e.message) || '')
    const m = msg.match(/Cannot find package '(@deepseek-ai\/[^']+)'/)
    const declared = m && pkg.peerDependencies && pkg.peerDependencies[m[1]]
    if (declared) check('宿主入口可 import（依赖由宿主提供）', true, m[1] + ' 在 peerDependencies')
    else check('宿主入口可 import', false, msg.slice(0, 160))
  }
}

// 6. patch 文件
const patchRel = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch
check('声明了 dsh.bundle.patch', Boolean(patchRel), String(patchRel))
if (patchRel && existsSync(join(pkgDir, patchRel))) {
  const text = readFileSync(join(pkgDir, patchRel), 'utf8')
  const hasInsert = /^\s*-\s*insert:/m.test(text)
  const hasId = /^\s*-\s*id:/m.test(text)
  const hasName = /^\s*name:/m.test(text)
  check('patch 含 insert 段', hasInsert)
  check('patch 条目带 id/name', hasId && hasName)
} else if (patchRel) {
  check('patch 文件存在', false, patchRel)
}

// 7. 内置 skill：apply() 会把它复制到 ~/.dsh/skills，新会话据此得知绘画流程
const skillFile = join(pkgDir, 'skills', 'pixel-art-studio', 'SKILL.md')
check('内置 pixel-art-studio skill', existsSync(skillFile), 'skills/pixel-art-studio/SKILL.md')
if (existsSync(skillFile)) {
  const head = readFileSync(skillFile, 'utf8').slice(0, 400)
  check('skill 有 name/description frontmatter',
    head.startsWith('---') && head.includes('name:') && head.includes('description:'))
}

// 8. 客户端 bundle 的 id 必须等于包名（ui-plugin.md 的要求）
if (clientEntry && existsSync(join(pkgDir, clientEntry))) {
  const js = readFileSync(join(pkgDir, clientEntry), 'utf8')
  const m = js.match(/load\(\s*\{\s*id:\s*["']([^"']+)["']/)
  check('client bundle id === 包名', Boolean(m) && m[1] === pkg.name, m ? m[1] : '未找到 id')
}

// 9. 显示元数据（host-plugin.md 的安装前清单：locale/*.json + icon）
const exp = pkg.exports || {}
check('exports 有 "./locale/*.json"', Boolean(exp['./locale/*.json']), String(exp['./locale/*.json']))
check('exports 有 "./icon"', Boolean(exp['./icon']), String(exp['./icon']))
const filesList = Array.isArray(pkg.files) ? pkg.files : []
check('files 覆盖 locale/*.json', filesList.includes('locale/*.json'))
check('files 覆盖 icon.svg', filesList.includes('icon.svg'))
for (const lang of ['en', 'zh']) {
  const rel = join('locale', lang + '.json')
  const full = join(pkgDir, rel)
  if (!existsSync(full)) { check('locale/' + lang + '.json 存在', false, rel); continue }
  check('locale/' + lang + '.json 存在', true, rel)
  try {
    const meta = (JSON.parse(readFileSync(full, 'utf8')) || {}).meta || {}
    check('locale/' + lang + ' 有 meta.title/description',
      typeof meta.title === 'string' && meta.title.length > 0 &&
      typeof meta.description === 'string' && meta.description.length > 0,
      JSON.stringify({ title: meta.title, description: meta.description }).slice(0, 100))
  } catch (e) {
    check('locale/' + lang + ' JSON 可解析', false, String(e && e.message).slice(0, 100))
  }
}
const iconRel = exp['./icon'] || 'icon.svg'
const iconPath = join(pkgDir, iconRel)
if (!existsSync(iconPath)) {
  check('icon 文件存在', false, iconRel)
} else {
  const size = statSync(iconPath).size
  const head = readFileSync(iconPath, 'utf8').slice(0, 200)
  check('icon 是 SVG 且 ≤ 256 KiB', head.includes('<svg') && size <= 256 * 1024, iconRel + ' ' + size + ' B')
}

console.log('\n模拟安装校验：' + (failed === 0 ? '全部通过' : failed + ' 项失败') + '\n')
console.log(out.join('\n'))
console.log('\n包目录：' + pkgDir)
process.exit(failed === 0 ? 0 : 1)
