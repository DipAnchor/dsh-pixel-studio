/**
 * dsh-cli-anything-aseprite — formal DSH Host plugin.
 *
 * Registers the pixel-art studio tool set (18 tools) that drive the
 * `cli-anything-aseprite` Python harness (CLI-Anything methodology):
 * every stroke is a real CLI command against a persistent project file,
 * so AI draws pixel art like a human — one deliberate operation at a time.
 *
 * Requirements:
 *   pip install -e ./python     (the harness; `cli-anything-aseprite` CLI)
 *
 * The optional live terminal monitor UI (GUI overlay showing the canvas
 * frame, layers, export buttons…) ships as `src/monitor.client.js` and is
 * loaded via DSH dynamic plugins in a session — see README.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, unlinkSync, statSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const name = 'cli-anything-aseprite'
export const inject = ['tools', 'timer']

/**
 * Quote one argv token for the host shell. The host may hand the command line to
 * bash or to PowerShell (Windows), so emit the intersection: bare tokens when the
 * value is shell-safe, double quotes otherwise. PowerShell starts a comment at a
 * bare `#`, which is why colour tokens such as `#AA0000` are always quoted.
 */
function q(arg) {
  const s = String(arg)
  if (s === '') return '""'
  if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(s)) return s
  if (!/["`$]/.test(s)) return '"' + s + '"'
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

export function apply(ctx, config = {}) {
  const CLI = 'cli-anything-aseprite'
  // 工作区放系统临时目录：插件不应该往用户的 ~/.dsh（DSH 的配置目录）里
  // 所有落盘都收在「项目根/temp/dsh-aseprite-work」：临时 pxa、导出的 png、
  // 逐遍快照（record/）、路径记忆，全在这一个目录里，不往用户的 ~/.dsh 堆东西。
  // 项目根优先用显式传入的 project，其次从当前 .pxa 往上找，最后从 cwd 找。
  const CONFIG_DIR = (process.env.ASEPRITE_WORKDIR || config.workdir || '')

  const state = {
    version: 0, file: null, name: '', width: 0, height: 0,
    ansi: '', png: '', pixels: 0, undo: 0, redo: 0, frames: 0, layers: 0,
    palette: 0, dirty: false, lastOp: '', log: [],
    /** 面板只在该会话显示：pixelart_open 记下调用者的 session id。 */
    ownerSession: '',
    /** 一遍一个快照：{step,name,ts,file,png}，供面板时间轴只读回看。 */
    steps: [],
    workId: '',
    recordDir: '',
    /** 手动覆盖的工作区（pixelart_workdir set），空时按项目根推导。 */
    workdirOverride: CONFIG_DIR.replace(/^~/, homedir()),
    /** 显式指定的项目根（pixelart_new 的 project 参数），空时自动推导。 */
    project: '',
    /** 上次写进 LAST_FILE 的项目根，避免重复写盘。 */
    remembered: '',
  }

  /** 从某个文件往上找项目根：第一个带 .git 或 AGENTS.md 的目录。 */
  function findRootFrom(file) {
    let dir = dirname(file)
    for (let i = 0; i < 8; i++) {
      if (existsSync(join(dir, '.git')) || existsSync(join(dir, 'AGENTS.md'))) return dir
      const up = dirname(dir)
      if (up === dir) break
      dir = up
    }
    return ''
  }

  /** 上次用过的项目根：放系统临时目录，重启后靠它找回 record/。
   *  cwd 不一定落在项目里（从工作区根启动时只能看到 MiliaStar，看不到 lua-meteos）。 */
  const LAST_FILE = join(tmpdir(), 'dsh-aseprite-last.json')
  function rememberProject(root) {
    if (!root) return
    try { writeFileSync(LAST_FILE, JSON.stringify({ project: root })) } catch (e) { /* 忽略 */ }
  }
  function lastProject() {
    try {
      const j = JSON.parse(readFileSync(LAST_FILE, 'utf8'))
      return String((j && j.project) || '')
    } catch (e) { return '' }
  }

  /** 项目根：显式 project > 当前 .pxa 所在项目 > 上次用过的项目 > cwd 向上找。 */
  function projectRoot() {
    if (state.project) return state.project
    if (state.file) {
      const r = findRootFrom(String(state.file))
      if (r) {
        if (state.remembered !== r) { state.remembered = r; rememberProject(r) }
        return r
      }
    }
    const last = lastProject()
    if (last) return last
    return findRootFrom(join(process.cwd(), 'placeholder.pxa'))
  }

  /** 工作区：项目根/temp/dsh-aseprite-work（临时文件 + 快照都在这里）。 */
  function workdir() {
    if (state.workdirOverride) return state.workdirOverride
    const root = projectRoot()
    return root ? join(root, 'temp', 'dsh-aseprite-work') : join(tmpdir(), 'dsh-aseprite-work')
  }
  /** 最近一步的预览倍率：最长边约 512px，小图仍 8×。 */
  function previewScale() {
    return Math.max(1, Math.min(8, Math.floor(512 / Math.max(state.width, state.height, 1))))
  }
  /** 快照根目录：直接在 workdir 下，和临时文件共用同一个工作区。 */
  function recordRoot() {
    return join(workdir(), 'record')
  }
  /** 开一个新 work：换工作区时把快照目录一起换掉。 */
  function newWork() {
    const stamp = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
    state.workId = stamp
    state.recordDir = join(recordRoot(), (state.ownerSession || 'local'), stamp)
    state.steps = []
    try { mkdirSync(state.recordDir, { recursive: true }) } catch (e) { /* 目录失败不阻塞绘制 */ }
  }
  /** 快照上限：多于 500 步删掉最老的一半，避免无限膨胀。 */
  function trimRecord() {
    if (state.steps.length <= 500) return
    const drop = state.steps.splice(0, state.steps.length - 500)
    for (const s of drop) {
      try { if (s.file && existsSync(s.file)) unlinkSync(s.file) } catch (e) { /* 忽略 */ }
    }
  }
  /** 扫出历史 work（最近 20 个），供面板手动打开。 */
  function scanHistory() {
    const out = []
    const root = recordRoot()
    let sessions = []
    try { sessions = readdirSync(root) } catch (e) { return out }
    for (const sid of sessions) {
      let works = []
      try { works = readdirSync(join(root, sid)) } catch (e) { continue }
      for (const wid of works) {
        const wdir = join(root, sid, wid)
        let files = []
        try { files = readdirSync(wdir).filter(function (f) { return f.endsWith('.pxa') }) } catch (e) { continue }
        if (!files.length) continue
        files.sort()
        const last = files[files.length - 1]
        let ts = 0
        try { ts = statSync(join(wdir, last)).mtimeMs } catch (e) { ts = 0 }
        // 标题来自 meta.json（= 工程名）；老 work 没有 meta 就留空，面板退回显示时间。
        let title = ''
        try {
          const meta = JSON.parse(readFileSync(join(wdir, 'meta.json'), 'utf8'))
          title = String((meta && meta.title) || '')
        } catch (e) { /* 没有 meta 就是老 work */ }
        out.push({ workId: wid, sessionId: sid, file: join(wdir, last), steps: files.length, ts: ts, title: title })
      }
    }
    out.sort(function (a, b) { return b.ts - a.ts })
    // 面板最多展示 50 条；更老的不会消失，磁盘上还在，📂 打开目录能看到。
    return out.slice(0, 50)
  }
  /** 最近一次 CLI 调用的参数串（去掉 --file/--json），面板用它显示"正在画什么"。 */
  let lastCmd = ''

  async function runCli(args) {
    const shell = ctx.get('shell')
    if (shell === undefined) throw new Error('shell service unavailable — dsh shell plugin missing')
    const policy = ctx.get('sandboxPolicy') !== undefined
      ? ctx.get('sandboxPolicy').resolve({ mode: 'danger-full-access' })
      : undefined
    const spec = shell.resolve({
      command: [CLI].concat(args).map((value, index) => (index === 0 ? String(value) : q(value))).join(' '),
      workdir: workdir(),
      timeoutMs: 60000,
      stdoutMaxBytes: 4000000,
      sandboxPolicy: policy,
    })
    // 面板的「最近操作」直接显示这条，比只有 'draw pixel' 更能看出在画什么。
    lastCmd = args.filter(function (a) { return a !== '--json' && a !== '--file' && a !== state.file }).join(' ')
    const handle = await shell.execute(spec)
    const r = await handle.result()
    if (r.exitCode !== 0) {
      const err = String((r.stderr && r.stderr.text) || r.stdout.text || '?').slice(0, 500)
      if (/No such file or directory|command not found|not found/.test(err)) {
        throw new Error(
          'cli-anything-aseprite harness not installed — run: pip install -e ./python ' +
          '(the package ships under python/ in this plugin)')
      }
      throw new Error('harness failed: ' + err)
    }
    return JSON.parse(r.stdout.text)
  }

  async function refresh(lastOp) {
    if (!state.file) return
    const info = await runCli(['--file', state.file, '--json', 'project', 'info'])
    state.name = info.name || state.name
    const sp = String(info.size || '0x0').split('x')
    state.width = parseInt(sp[0], 10) || 0
    state.height = parseInt(sp[1], 10) || 0
    state.pixels = info.pixels || 0
    state.undo = info.undo || 0
    state.redo = info.redo || 0
    state.frames = info.frames || 0
    state.layers = info.layers || 0
    state.palette = info.palette || 0
    state.lastOp = lastOp || state.lastOp
    if (lastOp) {
      state.log.push({ t: Date.now(), op: lastOp, detail: lastCmd, pixels: state.pixels })
      if (state.log.length > 200) state.log.splice(0, state.log.length - 200)
    }
    state.version += 1
    // 预览帧：导出 8× PNG 并缓存成 data URL，供客户端 monitor 面板直接渲染。
    try {
      const tmp = join(workdir(), '.monitor-preview.png')
      await runCli(['--file', state.file, '--json', 'export', 'png', tmp, '--scale', String(previewScale())])
      if (existsSync(tmp)) {
        state.png = 'data:image/png;base64,' + readFileSync(tmp).toString('base64')
      }
    } catch (e) { /* 保留上一帧，不阻断绘制 */ }
    return state.version
  }

  async function act(args, opName) {
    const r = await runCli(['--file', state.file, '--json'].concat(args))
    await refresh(opName)
    return r
  }

  function reg(name, description, parameters, execute) {
    ctx.tools.register(defineTool({
      name,
      description,
      parameters,
      output: {
        schema: { type: 'json' },
        render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
      },
      async execute(args, exec) { return execute(args, exec) },
      timeoutMs: 90000,
    }))
  }

  const n = (v) => v === undefined ? null : parseInt(v, 10)

  // ---------------------------------------------------------------- tools
  const TOOLS = [
    ['pixelart_new', '新建像素画项目，独立文件 <name>.pxa。尺寸自由 1..1024 或 preset(icon/sprite/avatar/portrait/scene/wide/max)，palette pico8/db16/sweetie16/na16。',
      { name: { type: 'string', required: true }, width: { type: 'integer' }, height: { type: 'integer' }, preset: { type: 'string', enum: ['icon', 'sprite', 'avatar', 'portrait', 'scene', 'wide', 'max'] }, palette: { type: 'string' }, project: { type: 'string' } },
      async (a) => {
        // 统一路径：先把项目根定下来，workdir 才是「项目根/temp/dsh-aseprite-work」。
        if (a && a.project) state.project = String(a.project).replace(/[\\/]+$/, '')
        const f = join(workdir(), String(a.name || 'untitled').replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, '_') + '.pxa')
        const c = ['--file', f, '--json', 'project', 'new', a.name || 'untitled']
        if (a.preset) c.push('--preset', a.preset)
        else { if (a.width) c.push('--width', String(a.width)); if (a.height) c.push('--height', String(a.height)) }
        if (a.palette) c.push('--palette', a.palette)
        c.push('--save', f)
        const r = await runCli(c)
        state.file = f
        newWork()
        await refresh('new ' + (a.name || ''))
        return { ...r, file: f, workId: state.workId, version: state.version }
      }],
    ['pixelart_open', '打开已有 .pxa 项目。', { path: { type: 'string' } },
      async (a, exec) => {
        const p = a && a.path ? String(a.path) : join(workdir(), 'art.pxa')
        const r = await runCli(['--file', p, '--json', 'project', 'info'])
        state.file = p
        const sid = exec && exec.agent && exec.agent.session ? exec.agent.session.id : ''
        if (sid) state.ownerSession = String(sid)
        newWork()
        await refresh('open')
        return { ...r, file: p, workId: state.workId, version: state.version }
      }],
    ['pixelart_workdir', '查看/更改工作区目录（作品存放处）。', { op: { type: 'string', required: true, enum: ['get', 'set'] }, dir: { type: 'string' } },
      async (a) => {
        if (a.op === 'set') {
          if (!a.dir) throw new Error('dir required')
          state.workdirOverride = String(a.dir).replace(/^~/, homedir())
          // 切工作区等于换项目：把跟旧工程绑定的状态全部清掉，否则时间轴、
          // recordDir、预览图都还指着旧目录，下一次 mark_pass 会写进旧 work。
          state.file = null
          state.steps = []
          state.recordDir = ''
          state.workId = ''
          state.name = ''
          state.width = 0
          state.height = 0
          state.pixels = 0
          state.png = ''
          state.frames = 0
          state.layers = 0
          state.palette = 0
          state.undo = 0
          state.redo = 0
          state.dirty = false
          state.lastOp = ''
          state.log = []
        }
        return { workdir: workdir(), open: state.file, version: state.version }
      }],
    ['pixelart_draw', '绘制原语 pixel/line/rect/ellipse/flood/erase。颜色支持 rgb16:r,g,b（4096 色）。受对称/平铺模式影响。',
      { op: { type: 'string', required: true, enum: ['pixel', 'line', 'rect', 'ellipse', 'flood', 'erase'] }, x: { type: 'integer' }, y: { type: 'integer' }, x1: { type: 'integer' }, y1: { type: 'integer' }, w: { type: 'integer' }, h: { type: 'integer' }, color: { type: 'string' }, fill: { type: 'boolean' }, tolerance: { type: 'integer' }, radius: { type: 'integer' } },
      async (a) => {
        const c = ['--file', state.file, '--json', 'pixel']
        switch (a.op) {
          case 'pixel': c.push('set', String(n(a.x)), String(n(a.y)), a.color); break
          case 'line': c.push('line', String(n(a.x)), String(n(a.y)), String(n(a.x1)), String(n(a.y1)), a.color); break
          case 'rect': c.push('rect', String(n(a.x)), String(n(a.y)), String(n(a.w)), String(n(a.h)), a.color); if (a.fill) c.push('--fill'); break
          case 'ellipse': c.push('ellipse', String(n(a.x)), String(n(a.y)), String(n(a.w)), String(n(a.h)), a.color); if (a.fill) c.push('--fill'); break
          case 'flood': c.push('flood', String(n(a.x)), String(n(a.y)), a.color); if (a.tolerance !== undefined) c.push('--tolerance', String(n(a.tolerance))); break
          case 'erase': c.push('erase', String(n(a.x)), String(n(a.y))); if (a.radius !== undefined) c.push('--radius', String(n(a.radius))); break
        }
        const r = await act(c, 'draw ' + a.op)
        return { ...r, version: state.version }
      }],
    ['pixelart_region', '选区：fill/stroke/clear/copy/paste/move/get（Aseprite 语义）。',
      { op: { type: 'string', required: true, enum: ['fill', 'stroke', 'clear', 'copy', 'paste', 'move', 'get'] }, x: { type: 'integer', required: true }, y: { type: 'integer', required: true }, w: { type: 'integer' }, h: { type: 'integer' }, dx: { type: 'integer' }, dy: { type: 'integer' }, color: { type: 'string' } },
      async (a) => {
        const c = ['--file', state.file, '--json', 'region', a.op]
        switch (a.op) {
          case 'fill': case 'stroke': c.push(String(n(a.x)), String(n(a.y)), String(n(a.w)), String(n(a.h)), a.color); break
          case 'clear': case 'copy': c.push(String(n(a.x)), String(n(a.y)), String(n(a.w)), String(n(a.h))); break
          case 'paste': c.push(String(n(a.x)), String(n(a.y))); break
          case 'move': c.push(String(n(a.x)), String(n(a.y)), String(n(a.w)), String(n(a.h)), String(n(a.dx)), String(n(a.dy))); break
          case 'get': c.push(String(n(a.x)), String(n(a.y)), String(n(a.w)), String(n(a.h))); break
        }
        const r = await act(c, 'region ' + a.op)
        return { ...r, version: state.version }
      }],
    ['pixelart_symmetry', '对称绘制（Aseprite Symmetry）：h/v/both/off，跨命令持久。', { mode: { type: 'string', required: true, enum: ['h', 'v', 'both', 'off'] } },
      async (a) => { const r = await act(['--file', state.file, '--json', 'pixel', 'symmetry', a.mode], 'sym ' + a.mode); return { ...r, version: state.version } }],
    ['pixelart_tiled', '平铺模式 on/off（无缝纹理，跨命令持久）。', { state: { type: 'string', required: true, enum: ['on', 'off'] } },
      async (a) => { const r = await act(['--file', state.file, '--json', 'pixel', 'tiled', a.state], 'tiled ' + a.state); return { ...r, version: state.version } }],
    ['pixelart_gradient', '渐变工具（Aseprite Gradient）：两点插值，支持 rgb16；direction line/horizontal/vertical。',
      { x0: { type: 'integer', required: true }, y0: { type: 'integer', required: true }, x1: { type: 'integer', required: true }, y1: { type: 'integer', required: true }, color0: { type: 'string', required: true }, color1: { type: 'string', required: true }, direction: { type: 'string', enum: ['line', 'horizontal', 'vertical'] } },
      async (a) => {
        const c = ['--file', state.file, '--json', 'pixel', 'gradient', String(n(a.x0)), String(n(a.y0)), String(n(a.x1)), String(n(a.y1)), a.color0, a.color1]
        if (a.direction) c.push('--direction', a.direction)
        const r = await act(c, 'gradient')
        return { ...r, version: state.version }
      }],
    ['pixelart_resize', '画布尺寸：resize（anchor 九宫格 nw/n/ne/w/c/e/sw/s/se，scale 缩放内容）/ rescale（内容缩放）。',
      { op: { type: 'string', required: true, enum: ['resize', 'rescale'] }, width: { type: 'integer', required: true }, height: { type: 'integer', required: true }, anchor: { type: 'string', enum: ['nw', 'n', 'ne', 'w', 'c', 'e', 'sw', 's', 'se'] }, scale: { type: 'boolean' } },
      async (a) => {
        const c = ['--file', state.file, '--json', 'canvas', a.op, String(n(a.width)), String(n(a.height))]
        if (a.op === 'resize') { if (a.anchor) c.push('--anchor', a.anchor); if (a.scale) c.push('--scale') }
        const r = await act(c, 'canvas ' + a.op)
        return { ...r, version: state.version }
      }],
    ['pixelart_tag', '帧标签 add/list/remove（Aseprite Frame Tags）。',
      { action: { type: 'string', required: true, enum: ['add', 'list', 'remove'] }, name: { type: 'string' }, from: { type: 'integer' }, to: { type: 'integer' }, color: { type: 'string' } },
      async (a) => {
        const c = ['--file', state.file, '--json', 'frame', 'tag', a.action]
        if (a.action === 'add') { if (!a.name || a.from === undefined || a.to === undefined) throw new Error('need name/from/to'); c.push(a.name, String(n(a.from)), String(n(a.to))); if (a.color) c.push('--color', a.color) }
        else if (a.action === 'remove') { if (!a.name) throw new Error('need name'); c.push(a.name) }
        const r = await act(c, 'tag ' + a.action)
        return { ...r, version: state.version }
      }],
    ['pixelart_undo', '撤销上一步绘制。', {}, async () => { const r = await act(['--file', state.file, '--json', 'undo'], 'undo'); return { ...r, version: state.version } }],
    ['pixelart_redo', '重做上一步。', {}, async () => { const r = await act(['--file', state.file, '--json', 'redo'], 'redo'); return { ...r, version: state.version } }],
    ['pixelart_palette', '调色板 apply/add/nearest/quantize（rgb16 支持）。',
      { op: { type: 'string', required: true, enum: ['apply', 'add', 'nearest', 'quantize'] }, name: { type: 'string' }, color: { type: 'string' } },
      async (a) => {
        let c
        if (a.op === 'quantize') c = ['--file', state.file, '--json', 'palette', 'quantize']
        else if (a.op === 'nearest') c = ['--file', state.file, '--json', 'palette', 'nearest', a.color]
        else if (a.op === 'apply') c = ['--file', state.file, '--json', 'palette', 'apply', a.name]
        else c = ['--file', state.file, '--json', 'palette', 'add', a.name, a.color]
        const r = await act(c, 'palette ' + a.op)
        return { ...r, version: state.version }
      }],
    ['pixelart_layer', '图层 list/add/remove/set/property/duplicate/merge；property 支持 name/visible/opacity/reference（参考层不渲染）。',
      { op: { type: 'string', required: true, enum: ['list', 'add', 'remove', 'set', 'property', 'duplicate', 'merge'] }, name: { type: 'string' }, id: { type: 'integer' }, prop: { type: 'string', enum: ['name', 'visible', 'opacity', 'reference'] }, value: { type: 'string' } },
      async (a) => {
        let c
        switch (a.op) {
          case 'list': c = ['--file', state.file, '--json', 'layer', 'list']; break
          case 'add': c = ['--file', state.file, '--json', 'layer', 'add', a.name || 'layer']; break
          case 'remove': c = ['--file', state.file, '--json', 'layer', 'remove', '--id', String(n(a.id))]; break
          case 'set': c = ['--file', state.file, '--json', 'layer', 'set', String(n(a.id))]; break
          case 'property': c = ['--file', state.file, '--json', 'layer', 'property', String(n(a.id)), a.prop, String(a.value)]; break
          case 'duplicate': c = ['--file', state.file, '--json', 'layer', 'duplicate', '--id', String(n(a.id))]; break
          case 'merge': c = ['--file', state.file, '--json', 'layer', 'merge']; break
        }
        const r = await act(c, 'layer ' + a.op)
        return { ...r, version: state.version }
      }],
    ['pixelart_frame', '帧 list/add/set/remove/duration/duplicate。',
      { op: { type: 'string', required: true, enum: ['list', 'add', 'set', 'remove', 'duration', 'duplicate'] }, id: { type: 'integer' }, duration: { type: 'integer' }, blank: { type: 'boolean' } },
      async (a) => {
        let c
        switch (a.op) {
          case 'list': c = ['--file', state.file, '--json', 'frame', 'list']; break
          case 'add': c = ['--file', state.file, '--json', 'frame', 'add']; if (a.duration) c.push('--duration', String(n(a.duration))); if (a.blank) c.push('--blank'); break
          case 'set': c = ['--file', state.file, '--json', 'frame', 'set', String(n(a.id))]; break
          case 'remove': c = ['--file', state.file, '--json', 'frame', 'remove', '--id', String(n(a.id))]; break
          case 'duration': c = ['--file', state.file, '--json', 'frame', 'duration', String(n(a.id)), String(n(a.duration))]; break
          case 'duplicate': c = ['--file', state.file, '--json', 'frame', 'duplicate', '--id', String(n(a.id))]; break
        }
        const r = await act(c, 'frame ' + a.op)
        return { ...r, version: state.version }
      }],
    ['pixelart_transform', '整层变换 flip-h/flip-v/rotate-90/rotate-180/rotate-270。',
      { op: { type: 'string', required: true, enum: ['flip-h', 'flip-v', 'rotate-90', 'rotate-180', 'rotate-270'] } },
      async (a) => { const r = await act(['--file', state.file, '--json', 'transform', 'apply', a.op], 'transform ' + a.op); return { ...r, version: state.version } }],
    ['pixelart_export', '导出 png/gif/aseprite/spritesheet/pngs 序列。',
      { format: { type: 'string', required: true, enum: ['png', 'gif', 'aseprite', 'spritesheet', 'pngs'] }, path: { type: 'string' }, scale: { type: 'integer' }, filename: { type: 'string' } },
      async (a) => {
        let p
        if (a.format === 'pngs') p = a.path || join(workdir(), 'frames')
        else { const ext = a.format === 'spritesheet' ? 'png' : a.format; p = a.path || join(workdir(), 'art.' + ext) }
        const c = ['--file', state.file, '--json', 'export', a.format === 'pngs' ? 'pngs' : a.format, p]
        if (a.format === 'pngs' && a.filename) c.push('--filename', a.filename)
        if (a.scale) c.push('--scale', String(a.scale))
        const r = await act(c, 'export ' + a.format)
        return { ...r, version: state.version }
      }],
    ['pixelart_terminal', '获取当前画布的 ANSI 终端帧（AI 每步绘制后人类可实时观看）。', {},
      async () => {
        if (!state.file) return { error: 'no project yet' }
        const r = await runCli(['--file', state.file, '--json', 'terminal'])
        return { frame: r.frame, width: state.width, height: state.height, version: state.version }
      }],
    ['pixelart_info', '项目状态（尺寸/帧/图层/像素/undo/操作日志）。', {},
      async () => state.file
        ? { open: true, name: state.name, workdir: workdir(), size: state.width + 'x' + state.height,
            frames: state.frames, layers: state.layers, palette: state.palette, pixels: state.pixels,
            undo: state.undo, redo: state.redo, dirty: state.dirty, lastOp: state.lastOp,
            log: state.log.slice(-12), version: state.version }
        : { open: false, error: 'use pixelart_new first' }],
    ['pixelart_mark_pass', '把当前画布存成「一步」（一个画遍）的完整快照，供面板时间轴只读回看。每画完一遍调用一次。',
      { name: { type: 'string' }, note: { type: 'string' } },
      async (a) => {
        if (!state.file) return { error: 'no project yet' }
        if (!state.recordDir) newWork()
        if (!state.recordDir) return { error: 'no record dir' }
        const stepNo = state.steps.length + 1
        const label = String((a && a.name) || ('pass' + stepNo))
        const ts = Date.now()
        const base = join(state.recordDir, 'work-' + ts)
        let bytes = 0
        try {
          copyFileSync(state.file, base + '.pxa')
          bytes = readFileSync(base + '.pxa').length
        } catch (e) { return { error: 'snapshot failed: ' + String((e && e.message) || e) } }
        let png = ''
        try {
          await runCli(['--file', state.file, '--json', 'export', 'png', base + '.png', '--scale', String(previewScale())])
          if (existsSync(base + '.png')) {
            png = 'data:image/png;base64,' + readFileSync(base + '.png').toString('base64')
            // 关键：面板「跟随最新」读的是 state.png，这一句不写它就会一直停在
            // 打开工程时那张空图上——表现为每一步都推了，面板却全是空白。
            state.png = png
          }
        } catch (e) { /* 预览失败不影响快照 */ }
        state.steps.push({ step: stepNo, name: label, note: String((a && a.note) || ''), ts: ts, file: base + '.pxa', png: png })
        // 步数元数据单独存一份（不含 png）：加载历史 work 时靠它恢复时间轴。
        try {
          writeFileSync(join(state.recordDir, 'meta.json'), JSON.stringify({
            // work 的标题就是工程名（.pxa 文件名），列表里优先显示它
            title: state.name || '',
            steps: state.steps.map(function (s) {
              // 只存文件名：meta.json 会随源码一起脱敏上传，不能带绝对路径。
              // 文件就在同目录，读回来时 join 一下就能重建。
              return { step: s.step, name: s.name, note: s.note, ts: s.ts,
                file: String(s.file || '').split(/[\\/]/).pop() }
            }),
          }))
        } catch (e) { /* 元数据失败不影响快照 */ }
        trimRecord()
        return { step: stepNo, name: label, file: base + '.pxa', bytes: bytes, steps: state.steps.length }
      }],
  ]
  for (const [name, desc, params, exec] of TOOLS) reg(name, desc, params, exec)

  // ── 客户端 monitor 面板的只读状态端点（浏览器同源 fetch，2s 轮询） ─────────
  // webServer 是可选依赖：没有它时工具照常工作，只是面板拿不到实时帧。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/cli-anything-aseprite/monitor.json',
      handler: (req, res) => {
        // 面板按会话隔离：调用方带上 ?session=<id>，只有 pixelart_open 所在的
        // 那个会话才拿到 open:true，其它会话一律当作未打开（面板因此不渲染）。
        let want = ''
        try { want = new URL(req.url || '/', 'http://localhost').searchParams.get('session') || '' } catch (e) { /* 无 query */ }
        const here = Boolean(state.file) && (!state.ownerSession || !want || want === state.ownerSession)
        // 时间轴：?step=N 取第 N 遍的快照图，不带则取最新一遍；没有任何步时退回实时帧。
        let wantStep = 0
        try { wantStep = parseInt(new URL(req.url || '/', 'http://localhost').searchParams.get('step') || '0', 10) || 0 } catch (e) { /* 无 query */ }
        const lastStep = state.steps.length ? state.steps[state.steps.length - 1].step : 0
        const pick = wantStep > 0
          ? (state.steps.filter(function (s) { return s.step === wantStep })[0] || null)
          : (state.steps.length ? state.steps[state.steps.length - 1] : null)
        const body = JSON.stringify({
          open: here,
          name: state.name,
          workdir: workdir(),
          width: state.width,
          height: state.height,
          pixels: state.pixels,
          frames: state.frames,
          layers: state.layers,
          version: state.version,
          lastOp: state.lastOp,
          log: state.log.slice(-6),
          steps: state.steps.map(function (s) { return { step: s.step, name: s.name, ts: s.ts, note: s.note || '', file: s.file } }),
          cursor: pick ? pick.step : 0,
          lastStep: lastStep,
          // 跟随最新（未指定 step）时给实时帧，这样两遍之间也在动；
          // 只有拖到某一遍才用那一步的快照。
          png: wantStep > 0 && pick && pick.png ? pick.png : state.png,
          history: scanHistory(),
        })
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(body)
      },
    }), 'cli-anything-aseprite: monitor state route')

    // 面板上的 📂：在资源管理器里打开当前 work 的快照目录（路径固定为
    // 打开的是**快照根**（workdir/record），不是当前某个 work 的子目录——
    // 后者重启后可能已不存在，且看不到别的 work。路径写死由宿主算，
    // 不接受外部传入，避免成为任意命令执行入口）。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/cli-anything-aseprite/open-dir',
      handler: (req, res) => {
        // 跟着当前 work 走：加载哪个 work，📂 就打开哪个目录。
        // 只有还没有 work（或目录已被清掉）时才退到 record 根。
        const dir = (state.recordDir && existsSync(state.recordDir)) ? state.recordDir : recordRoot()
        const out = { ok: false, dir: dir }
        try {
          mkdirSync(dir, { recursive: true })
          // explorer.exe 对正斜杠支持很差：路径里混着 `/` 和 `\` 时它常常只打开到
          // 某个上级目录，看起来就像"路径没跟着 work 变"。统一成反斜杠再传。
          execFile('explorer.exe', [String(dir).replace(/\//g, '\\')], () => { /* 结果不影响面板 */ })
          out.ok = true
        } catch (e) { out.error = String((e && e.message) || e) }
        res.writeHead(out.ok ? 200 : 500, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify(out))
      },
    }), 'cli-anything-aseprite: open work dir')

    // 面板上的 🕘：把某个历史 work 的最后一步拷成新的工作文件再打开。
    // 不直接编辑快照本身，避免把只读历史改坏。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/cli-anything-aseprite/open-work',
      handler: (req, res) => {
        let body = ''
        req.on('data', function (chunk) { body += String(chunk) })
        req.on('end', async () => {
          const out = { ok: false }
          try {
            const src = String(JSON.parse(body || '{}').file || '')
            if (!src || !existsSync(src)) throw new Error('snapshot not found')
            // 只接受 record 根下的快照：否则这个端点等于"把任意本机文件复制进工作区"。
            const root = resolve(recordRoot())
            if (!resolve(src).startsWith(root)) throw new Error('not a snapshot')
            const dest = join(workdir(), 'restored-' + Date.now().toString(36) + '.pxa')
            copyFileSync(src, dest)
            state.file = dest
            // 恢复该 work 的步骤，让时间轴有内容（否则加载完是一条空进度条）。
            const dir = dirname(src)
            let steps = []
            try {
              const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
              // meta 里只存文件名（脱敏要求），读回来拼成当前目录下的完整路径
              steps = (Array.isArray(meta.steps) ? meta.steps : []).map(function (s) {
                // 兼容早期还在用绝对路径的 meta：取 basename 再拼一次
                const name = String((s && s.file) || '').split(/[\\/]/).pop()
                return { step: s.step, name: s.name, note: s.note || '', ts: s.ts || 0,
                  file: name ? join(dir, name) : '' }
              })
            } catch (e) {
              // 老 work 没有 meta.json：退回扫 work-*.pxa，名字用 passN、ts 取文件名里的毫秒
              try {
                steps = readdirSync(dir).filter(function (f) { return /^work-\d+\.pxa$/.test(f) }).sort()
                  .map(function (f, i) {
                    const ts = parseInt(String(f).replace(/^work-/, '').replace(/\.pxa$/, ''), 10) || 0
                    return { step: i + 1, name: 'pass' + (i + 1), note: '', ts: ts, file: join(dir, f) }
                  })
              } catch (e2) { steps = [] }
            }
            for (const s of steps) {
              if (!s.png) {
                const p = String(s.file || '').replace(/\.pxa$/, '.png')
                try {
                  if (existsSync(p)) s.png = 'data:image/png;base64,' + readFileSync(p).toString('base64')
                } catch (e) { /* 缺图就留空，面板会退回实时帧 */ }
              }
            }
            state.steps = steps
            state.workId = dir.split(/[\\/]/).filter(Boolean).pop() || ''
            state.recordDir = dir
            await refresh('open restored')
            // refresh 会用 export 覆盖 state.png，所以恢复最后一步的图要放在它之后。
            const lastStep = steps.length ? steps[steps.length - 1] : null
            if (lastStep && lastStep.png) state.png = lastStep.png
            out.ok = true
            out.file = dest
            out.steps = steps.length
          } catch (e) { out.error = String((e && e.message) || e) }
          res.writeHead(out.ok ? 200 : 500, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(JSON.stringify(out))
        })
      },
    }), 'cli-anything-aseprite: open historical work')
  })

  // auto-resume the default project on start
  ctx.timeout(async () => {
    try {
      const fs = ctx.get('fs')
      const f = join(workdir(), 'art.pxa')
      if (fs !== undefined && (await fs.stat(await fs.resolve(f))) !== undefined) {
        state.file = f
        await refresh('resumed')
      }
    } catch (e) { /* no project yet */ }
  }, 300)
}
