/**
 * dsh-pixel-studio — Aseprite-style pixel art studio for DeepSeek Harness.
 *
 * Registers the pixelart_* tool family backed by the
 * `cli-anything-aseprite` harness (see agent-harness/ in this repo):
 * every drawing operation renders a fresh ANSI terminal frame + canvas
 * grid, so a human can watch the AI draw stroke by stroke.
 *
 * This is the static-cordis-plugin form of the dynamic plugin developed
 * in-session (harness.defineTool/registerTool/handle are replaced by the
 * standard ctx.tools.register + shell service).
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-pixel-studio'
export const inject = ['tools', 'shell', 'fs']

const CLI = 'cli-anything-aseprite'

export function apply(ctx) {
  const state = {
    file: null,
    workdir: process.env.PIXEL_STUDIO_WORKDIR || `${process.env.HOME}/.dsh/pixel-studio`,
  }

  async function runCli(args) {
    const { stdout, stderr, exitCode } = await ctx.shell.run(
      ctx.shell.resolve({
        command: [CLI, ...args].map(shq).join(' '),
        workdir: state.workdir,
        timeoutMs: 60000,
        stdoutMaxBytes: 4_000_000,
      }),
    )
    if (exitCode !== 0) throw new Error(`harness failed: ${String(stderr || stdout).slice(0, 500)}`)
    return JSON.parse(stdout)
  }
  function shq(a) {
    return `'${String(a).replace(/'/g, "'\\''")}'`
  }

  // --- tool table: name, description, parameters, builder(args) -> CLI args ---
  const TOOLS = [
    ['pixelart_new', '创建新像素画项目（独立文件 <name>.pxa）。尺寸 1..1024 自由或 preset(icon/sprite/avatar/portrait/scene/wide/max)，palette pico8/db16/sweetie16/na16。',
      { name: { type: 'string', required: true }, width: { type: 'integer' }, height: { type: 'integer' }, preset: { type: 'string', enum: ['icon', 'sprite', 'avatar', 'portrait', 'scene', 'wide', 'max'] }, palette: { type: 'string' } },
      async (a) => {
        const f = `${state.workdir}/${String(a.name || 'untitled').replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, '_')}.pxa`
        const c = ['--file', f, '--json', 'project', 'new', a.name || 'untitled']
        if (a.preset) c.push('--preset', a.preset)
        else { if (a.width) c.push('--width', String(a.width)); if (a.height) c.push('--height', String(a.height)) }
        if (a.palette) c.push('--palette', a.palette)
        c.push('--save', f)
        const r = await runCli(c)
        state.file = f
        return { ...r, file: f }
      }],
    ['pixelart_open', '打开已有 .pxa 项目。',
      { path: { type: 'string' } },
      async (a) => {
        const p = a?.path ? String(a.path) : `${state.workdir}/art.pxa`
        const r = await runCli(['--file', p, '--json', 'project', 'info'])
        state.file = p
        return { ...r, file: p }
      }],
    ['pixelart_draw', '绘制原语 pixel/line/rect/ellipse/flood/erase。颜色支持 #hex、css 名或 rgb16:r,g,b（4096 色）。受对称/平铺模式影响。',
      { op: { type: 'string', required: true, enum: ['pixel', 'line', 'rect', 'ellipse', 'flood', 'erase'] }, x: { type: 'integer' }, y: { type: 'integer' }, x1: { type: 'integer' }, y1: { type: 'integer' }, w: { type: 'integer' }, h: { type: 'integer' }, color: { type: 'string' }, fill: { type: 'boolean' }, tolerance: { type: 'integer' }, radius: { type: 'integer' } },
      async (a) => {
        const c = ['--file', state.file, '--json', 'pixel']; const n = (v) => (v === undefined ? null : parseInt(v, 10))
        switch (a.op) {
          case 'pixel': c.push('set', String(n(a.x)), String(n(a.y)), a.color); break
          case 'line': c.push('line', String(n(a.x)), String(n(a.y)), String(n(a.x1)), String(n(a.y1)), a.color); break
          case 'rect': c.push('rect', String(n(a.x)), String(n(a.y)), String(n(a.w)), String(n(a.h)), a.color); if (a.fill) c.push('--fill'); break
          case 'ellipse': c.push('ellipse', String(n(a.x)), String(n(a.y)), String(n(a.w)), String(n(a.h)), a.color); if (a.fill) c.push('--fill'); break
          case 'flood': c.push('flood', String(n(a.x)), String(n(a.y)), a.color); if (a.tolerance !== undefined) c.push('--tolerance', String(n(a.tolerance))); break
          case 'erase': c.push('erase', String(n(a.x)), String(n(a.y))); if (a.radius !== undefined) c.push('--radius', String(n(a.radius))); break
        }
        return runCli(c)
      }],
    ['pixelart_region', '选区：fill/stroke/clear/copy/paste/move/get（Aseprite 语义，剪贴板跨进程持久）。',
      { op: { type: 'string', required: true, enum: ['fill', 'stroke', 'clear', 'copy', 'paste', 'move', 'get'] }, x: { type: 'integer', required: true }, y: { type: 'integer', required: true }, w: { type: 'integer' }, h: { type: 'integer' }, dx: { type: 'integer' }, dy: { type: 'integer' }, color: { type: 'string' } },
      async (a) => {
        const c = ['--file', state.file, '--json', 'region', a.op]; const n = (v) => (v === undefined ? null : parseInt(v, 10))
        switch (a.op) {
          case 'fill': case 'stroke': c.push(String(n(a.x)), String(n(a.y)), String(n(a.w)), String(n(a.h)), a.color); break
          case 'clear': case 'copy': c.push(String(n(a.x)), String(n(a.y)), String(n(a.w)), String(n(a.h))); break
          case 'paste': c.push(String(n(a.x)), String(n(a.y))); break
          case 'move': c.push(String(n(a.x)), String(n(a.y)), String(n(a.w)), String(n(a.h)), String(n(a.dx)), String(n(a.dy))); break
          case 'get': c.push(String(n(a.x)), String(n(a.y)), String(n(a.w)), String(n(a.h))); break
        }
        return runCli(c)
      }],
    ['pixelart_symmetry', '对称绘制（Aseprite Symmetry）：h/v/both/off，跨命令持久。',
      { mode: { type: 'string', required: true, enum: ['h', 'v', 'both', 'off'] } },
      async (a) => runCli(['--file', state.file, '--json', 'pixel', 'symmetry', a.mode])],
    ['pixelart_tiled', '平铺模式 on/off（无缝纹理）。',
      { state: { type: 'string', required: true, enum: ['on', 'off'] } },
      async (a) => runCli(['--file', state.file, '--json', 'pixel', 'tiled', a.state])],
    ['pixelart_gradient', '渐变工具：两点颜色插值，支持 rgb16；direction line/horizontal/vertical。',
      { x0: { type: 'integer', required: true }, y0: { type: 'integer', required: true }, x1: { type: 'integer', required: true }, y1: { type: 'integer', required: true }, color0: { type: 'string', required: true }, color1: { type: 'string', required: true }, direction: { type: 'string', enum: ['line', 'horizontal', 'vertical'] } },
      async (a) => {
        const c = ['--file', state.file, '--json', 'pixel', 'gradient', String(parseInt(a.x0, 10)), String(parseInt(a.y0, 10)), String(parseInt(a.x1, 10)), String(parseInt(a.y1, 10)), a.color0, a.color1]
        if (a.direction) c.push('--direction', a.direction)
        return runCli(c)
      }],
    ['pixelart_resize', '画布尺寸：resize（anchor 九宫格 nw/n/ne/w/c/e/sw/s/se；scale 缩放内容）/ rescale（内容缩放）。',
      { op: { type: 'string', required: true, enum: ['resize', 'rescale'] }, width: { type: 'integer', required: true }, height: { type: 'integer', required: true }, anchor: { type: 'string', enum: ['nw', 'n', 'ne', 'w', 'c', 'e', 'sw', 's', 'se'] }, scale: { type: 'boolean' } },
      async (a) => {
        const c = ['--file', state.file, '--json', 'canvas', a.op, String(parseInt(a.width, 10)), String(parseInt(a.height, 10))]
        if (a.op === 'resize') { if (a.anchor) c.push('--anchor', a.anchor); if (a.scale) c.push('--scale') }
        return runCli(c)
      }],
    ['pixelart_tag', '动画帧标签（Aseprite Frame Tags）：add/list/remove。',
      { action: { type: 'string', required: true, enum: ['add', 'list', 'remove'] }, name: { type: 'string' }, from: { type: 'integer' }, to: { type: 'integer' }, color: { type: 'string' } },
      async (a) => {
        const c = ['--file', state.file, '--json', 'frame', 'tag', a.action]
        if (a.action === 'add') { if (!a.name || a.from === undefined || a.to === undefined) throw new Error('need name/from/to'); c.push(a.name, String(parseInt(a.from, 10)), String(parseInt(a.to, 10))); if (a.color) c.push('--color', a.color) }
        else if (a.action === 'remove') { if (!a.name) throw new Error('need name'); c.push(a.name) }
        return runCli(c)
      }],
    ['pixelart_undo', '撤销上一步。', {}, async () => runCli(['--file', state.file, '--json', 'undo'])],
    ['pixelart_redo', '重做上一步。', {}, async () => runCli(['--file', state.file, '--json', 'redo'])],
    ['pixelart_palette', '调色板 apply/add/nearest/quantize（rgb16 支持）。',
      { op: { type: 'string', required: true, enum: ['apply', 'add', 'nearest', 'quantize'] }, name: { type: 'string' }, color: { type: 'string' } },
      async (a) => {
        if (a.op === 'quantize') return runCli(['--file', state.file, '--json', 'palette', 'quantize'])
        if (a.op === 'nearest') return runCli(['--file', state.file, '--json', 'palette', 'nearest', a.color])
        if (a.op === 'apply') return runCli(['--file', state.file, '--json', 'palette', 'apply', a.name])
        return runCli(['--file', state.file, '--json', 'palette', 'add', a.name, a.color])
      }],
    ['pixelart_layer', '图层 list/add/remove/set/property/duplicate/merge；property 支持 name/visible/opacity/reference。',
      { op: { type: 'string', required: true, enum: ['list', 'add', 'remove', 'set', 'property', 'duplicate', 'merge'] }, name: { type: 'string' }, id: { type: 'integer' }, prop: { type: 'string', enum: ['name', 'visible', 'opacity', 'reference'] }, value: { type: 'string' } },
      async (a) => {
        let c
        switch (a.op) {
          case 'list': c = ['--file', state.file, '--json', 'layer', 'list']; break
          case 'add': c = ['--file', state.file, '--json', 'layer', 'add', a.name || 'layer']; break
          case 'remove': c = ['--file', state.file, '--json', 'layer', 'remove', '--id', String(parseInt(a.id, 10))]; break
          case 'set': c = ['--file', state.file, '--json', 'layer', 'set', String(parseInt(a.id, 10))]; break
          case 'property': c = ['--file', state.file, '--json', 'layer', 'property', String(parseInt(a.id, 10)), a.prop, String(a.value)]; break
          case 'duplicate': c = ['--file', state.file, '--json', 'layer', 'duplicate', '--id', String(parseInt(a.id, 10))]; break
          case 'merge': c = ['--file', state.file, '--json', 'layer', 'merge']; break
        }
        return runCli(c)
      }],
    ['pixelart_frame', '动画帧 list/add/set/remove/duration/duplicate。',
      { op: { type: 'string', required: true, enum: ['list', 'add', 'set', 'remove', 'duration', 'duplicate'] }, id: { type: 'integer' }, duration: { type: 'integer' }, blank: { type: 'boolean' } },
      async (a) => {
        let c
        switch (a.op) {
          case 'list': c = ['--file', state.file, '--json', 'frame', 'list']; break
          case 'add': c = ['--file', state.file, '--json', 'frame', 'add']; if (a.duration) c.push('--duration', String(parseInt(a.duration, 10))); if (a.blank) c.push('--blank'); break
          case 'set': c = ['--file', state.file, '--json', 'frame', 'set', String(parseInt(a.id, 10))]; break
          case 'remove': c = ['--file', state.file, '--json', 'frame', 'remove', '--id', String(parseInt(a.id, 10))]; break
          case 'duration': c = ['--file', state.file, '--json', 'frame', 'duration', String(parseInt(a.id, 10)), String(parseInt(a.duration, 10))]; break
          case 'duplicate': c = ['--file', state.file, '--json', 'frame', 'duplicate', '--id', String(parseInt(a.id, 10))]; break
        }
        return runCli(c)
      }],
    ['pixelart_transform', '整层变换 flip-h/flip-v/rotate-90/rotate-180/rotate-270。',
      { op: { type: 'string', required: true, enum: ['flip-h', 'flip-v', 'rotate-90', 'rotate-180', 'rotate-270'] } },
      async (a) => runCli(['--file', state.file, '--json', 'transform', 'apply', a.op])],
    ['pixelart_export', '导出 png/gif/aseprite/spritesheet/pngs 序列。',
      { format: { type: 'string', required: true, enum: ['png', 'gif', 'aseprite', 'spritesheet', 'pngs'] }, path: { type: 'string' }, scale: { type: 'integer' }, filename: { type: 'string' } },
      async (a) => {
        let p
        if (a.format === 'pngs') p = a.path || `${state.workdir}/frames`
        else { const ext = a.format === 'spritesheet' ? 'png' : a.format; p = a.path || `${state.workdir}/art.${ext}` }
        const c = ['--file', state.file, '--json', 'export', a.format === 'pngs' ? 'pngs' : a.format, p]
        if (a.format === 'pngs' && a.filename) c.push('--filename', a.filename)
        if (a.scale) c.push('--scale', String(a.scale))
        return runCli(c)
      }],
    ['pixelart_terminal', '获取当前画布的实时 ANSI 终端帧（人类观看视图）。',
      {}, async () => {
        if (!state.file) return { error: 'no project yet' }
        const r = await runCli(['--file', state.file, '--json', 'terminal'])
        return { frame: r.frame }
      }],
    ['pixelart_info', '查看项目状态。', {},
      async () => (state.file ? runCli(['--file', state.file, '--json', 'project', 'info']) : { open: false, error: 'use pixelart_new first' })],
  ]

  for (const [toolName, description, parameters, execute] of TOOLS) {
    ctx.tools.register(defineTool({
      name: toolName,
      description,
      parameters,
      output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
      execute,
      timeoutMs: 90000,
    }))
  }
}
