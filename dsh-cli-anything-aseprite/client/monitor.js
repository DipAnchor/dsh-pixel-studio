/* cli-anything-aseprite monitor bundle — built by scripts/build-client.mjs. DO NOT EDIT. */
window.__ModuleLoader__.load({
	id: "dsh-cli-anything-aseprite",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

/**
 * cli-anything-aseprite monitor panel — browser half.
 *
 * One entry in `shell.overlay`: the frame-wide floating layer above every
 * column and outside their scroll containers, so the panel takes no layout
 * slot. The layer is click-through; the card (or the collapsed dot) opts back
 * into pointer events.
 *
 * Behaviour:
 *  - Hidden entirely until a project is open (no dot, no placeholder).
 *  - Draggable by its header (and by the collapsed dot); the position sticks
 *    for the session.
 *  - Polls `/cli-anything-aseprite/monitor.json` at 400 ms and shows the latest
 *    exported frame plus a three-line operation ticker.
 *
 * The host half owns all state; this half is a thin viewer: no file access, no
 * tools, no mutation. Wire contract is the DSH browser-module factory
 * (`window.__ModuleLoader__.load`), so the build script can emit it as a single
 * CJS-style bundle.
 */

const h = React.createElement

const MONITOR_URL = '/cli-anything-aseprite/monitor.json'
const DIR_URL = '/cli-anything-aseprite/open-dir'
const WORK_URL = '/cli-anything-aseprite/open-work'
const POLL_MS = 400

/**
 * 面板状态全部**按会话**存，因为两个 slot（输入框右侧按钮 / 浮层）一个在
 * session 作用域、一个在 root 作用域，只有模块作用域能互通。
 *
 * - hidden：整块不渲染（用户在 A 会话关掉，不影响 B 会话）
 * - collapsed：本会话收起成小圆钮
 * - force：用户主动叫出来的，允许在没打开项目时也显示空面板
 */
const hiddenSessions = new Set()
const collapsedSessions = new Set()
const forceSessions = new Set()
const panelSubs = new Set()

function notifyPanel() {
  panelSubs.forEach(function (fn) { try { fn() } catch (_) { /* 单个订阅失败不影响其它 */ } })
}

/** 用户点按钮主动拉起：取消隐藏/折叠，并允许空面板。 */
function showPanelFor(sid) {
  if (!sid) return
  hiddenSessions.delete(sid)
  collapsedSessions.delete(sid)
  forceSessions.add(sid)
  notifyPanel()
}

function usePanelTick() {
  const [, bump] = React.useState(0)
  const subbed = React.useRef(false)
  React.useEffect(function () {
    const fn = function () { bump(function (n) { return n + 1 }) }
    panelSubs.add(fn)
    return function () { panelSubs.delete(fn) }
  }, [])
  // 会话切换也必须触发重渲：currentSessionId() 只在渲染时求值，不订阅的话
  // 切到另一个对话后面板还拿着旧 sid，显隐/折叠状态就会串到别的会话里。
  // sessionHost 是 ctx.inject 异步注入的，首次渲染可能还是 null，所以这里
  // 在渲染期做一次幂等订阅（subbed 保证只订阅一次）。
  if (!subbed.current && sessionHost && sessionHost.sessions) {
    try {
      const list = sessionHost.sessions.list
      if (list && typeof list.subscribe === 'function') {
        list.subscribe(function () { notifyPanel() })
        subbed.current = true
      }
    } catch (e) { /* 服务不支持订阅就退回轮询 */ }
  }
}

/**
 * Client-side session services, injected in `apply`. `shell.overlay` is
 * root-scoped and gets no session id, so the overlay has to ask the session
 * services which conversation is on screen — the same two lookups dsh-purge
 * uses (`uiWorkspace.selection` first, then the session list's `current`).
 */
let sessionHost = null

/** 宿主 locale 服务；没注入成功时 t() 退回中文原文。 */
let localeRt = null

/**
 * 面板文案。走 ctx.locale.resolveText(map)：宿主按当前语言从 map 里挑一个，
 * 没有 locale 服务时（比如独立试跑）退回中文。
 */
const MSG = {
  untitled: { zh: '未命名', en: 'No project' },
  noProject: { zh: '还没有打开项目。让 AI 调 pixelart_open 打开一个 .pxa。', en: 'No project open yet. Ask the AI to call pixelart_open on a .pxa.' },
  waitingFrame: { zh: '等待第一帧…', en: 'Waiting for the first frame…' },
  openHistory: { zh: '打开历史作品', en: 'Open a past work' },
  openDir: { zh: '打开快照目录', en: 'Open snapshot folder' },
  zoom: { zh: '缩放', en: 'Zoom' },
  pause: { zh: '暂停播放', en: 'Pause playback' },
  play: { zh: '每步 1 秒回放', en: 'Play back, 1s per step' },
  cursor: { zh: '回看某一步', en: 'Review a step' },
  copy: { zh: '复制该步信息', en: 'Copy this step info' },
  copied: { zh: '已复制', en: 'Copied' },
  latest: { zh: '跳到最新', en: 'Jump to latest' },
  noHistory: { zh: '还没有历史作品', en: 'No past work yet' },
  close: { zh: '收起', en: 'Collapse' },
}
// MSG 的字面量里**不能**再调 t()：t 读的就是 MSG，会在 TDZ 里炸
// （`Cannot access 'MSG' before initialization` 直接让整个 web boot 失败）。

function t(key) {
  const m = MSG[key]
  if (!m) return key
  try {
    if (localeRt && typeof localeRt.resolveText === 'function') return localeRt.resolveText(m)
  } catch (_) { /* 服务异常就退回中文 */ }
  return m.zh || m.en || key
}

function currentSessionId() {
  try {
    const sel = sessionHost && sessionHost.uiWorkspace && sessionHost.uiWorkspace.selection
    const id = sel && sel.getSnapshot ? sel.getSnapshot().sessionId : ''
    if (typeof id === 'string' && id) return id
  } catch (_) { /* 工作区还没选中 */ }
  try {
    const snap = sessionHost && sessionHost.sessions && sessionHost.sessions.list
      && sessionHost.sessions.list.getSnapshot
      ? sessionHost.sessions.list.getSnapshot() : null
    if (snap && typeof snap.current === 'string' && snap.current) return snap.current
  } catch (_) { /* 列表未就绪 */ }
  // 兜底：composer dock 里的探针写进 window 的会话 id。
  return (typeof window !== 'undefined' && window.__asepriteSessionId) || ''
}

const S = {
  outer: {
    position: 'fixed',
    zIndex: 900,
    pointerEvents: 'none',
    font: '12px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
  },
  dot: {
    pointerEvents: 'auto',
    width: 44,
    height: 44,
    padding: 0,
    borderRadius: 22,
    border: '1px solid var(--dsw-alias-border-l1, #e3e3ea)',
    background: 'var(--dsw-alias-bg-layer-1, #fbfbfd)',
    boxShadow: '0 6px 20px rgba(0, 0, 0, .28)',
    fontSize: 20,
    lineHeight: '1',
    cursor: 'grab',
    touchAction: 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    pointerEvents: 'auto',
    width: 264,
    borderRadius: 14,
    overflow: 'hidden',
    border: '1px solid var(--dsw-alias-border-l1, #e3e3ea)',
    background: 'var(--dsw-alias-bg-layer-1, #fbfbfd)',
    boxShadow: '0 10px 32px rgba(0, 0, 0, .32)',
    color: 'var(--dsw-alias-label-primary, #1d1d26)',
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 10px',
    cursor: 'grab',
    touchAction: 'none',
    userSelect: 'none',
    borderBottom: '1px solid var(--dsw-alias-border-l1, #ececf2)',
    background: 'var(--dsw-alias-bg-layer-2, #f5f5fa)',
  },
  title: { fontWeight: 600, fontSize: 13, color: 'var(--dsw-alias-label-primary, #1d1d26)' },
  meta: {
    color: 'var(--dsw-alias-label-tertiary, #8a8a99)',
    marginLeft: 'auto',
    fontVariantNumeric: 'tabular-nums',
  },
  caret: { color: 'var(--dsw-alias-label-tertiary, #8a8a99)', fontSize: 11 },
  headBtn: {
    flex: '0 0 auto',
    width: 20,
    height: 18,
    padding: 0,
    fontSize: 10,
    lineHeight: 1,
    borderRadius: 5,
    border: 'none',
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary, #5a5a68)',
    cursor: 'pointer',
  },
  body: { padding: 10, display: 'grid', gap: 8 },
  canvasWrap: {
    position: 'relative',
    borderRadius: 8,
    overflow: 'hidden',
    border: '1px solid var(--dsw-alias-border-l1, #e7e7ee)',
    background: 'repeating-conic-gradient(#ececf3 0 25%, #ffffff 0 50%) 0 0 / 16px 16px',
  },
  zoomBtn: {
    position: 'absolute', right: 4, bottom: 4,
    width: 22, height: 22, borderRadius: 6, padding: 0,
    border: 'none', cursor: 'pointer',
    background: 'rgba(0, 0, 0, 0.35)', color: '#fff', fontSize: 12, lineHeight: '22px',
    opacity: 0.7,
  },
  zoomMask: {
    position: 'fixed', inset: 0, zIndex: 9999,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(0, 0, 0, 0.72)', cursor: 'zoom-out',
    // 外层 shell.overlay 容器是 pointerEvents:none（点击穿透），
    // 遮罩必须自己开回来，否则点不动。
    pointerEvents: 'auto',
  },
  zoomImg: {
    maxWidth: '90vw', maxHeight: '90vh',
    imageRendering: 'pixelated', borderRadius: 8,
  },
  img: { display: 'block', width: '100%', height: 'auto', imageRendering: 'pixelated' },
  kv: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 10,
    color: 'var(--dsw-alias-label-secondary, #5a5a68)',
  },
  v: {
    color: 'var(--dsw-alias-label-primary, #1d1d26)',
    fontVariantNumeric: 'tabular-nums',
    textAlign: 'right',
  },
  hist: {
    display: 'grid',
    gap: 2,
    maxHeight: 200,
    overflow: 'auto',
    paddingTop: 4,
    borderTop: '1px solid var(--dsw-alias-border-l1, #e3e3ea)',
  },
  histCount: {
    fontSize: 9,
    color: 'var(--dsw-alias-label-tertiary, #8a8a99)',
    paddingBottom: 2,
    textAlign: 'left',
  },
  histRow: {
    textAlign: 'left',
    padding: '3px 4px',
    fontSize: 10,
    borderRadius: 4,
    border: 'none',
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary, #5a5a68)',
    cursor: 'pointer',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  tickerTitle: {
    marginTop: 2,
    color: 'var(--dsw-alias-label-tertiary, #8a8a99)',
    fontSize: 11,
  },
  ticker: {
    display: 'grid',
    gap: 1,
    fontVariantNumeric: 'tabular-nums',
    color: 'var(--dsw-alias-label-secondary, #5a5a68)',
    fontSize: 11,
  },
  tickRow: { display: 'flex', gap: 6, whiteSpace: 'nowrap', overflow: 'hidden' },
  tickTime: { color: 'var(--dsw-alias-label-tertiary, #8a8a99)' },
  tickOp: { overflow: 'hidden', textOverflow: 'ellipsis' },
  empty: {
    padding: '18px 12px',
    textAlign: 'center',
    color: 'var(--dsw-alias-label-tertiary, #8a8a99)',
  },
  timeline: { display: 'grid', gap: 2 },
  timelineRow: { display: 'flex', alignItems: 'center', gap: 6 },
  play: {
    flex: '0 0 auto',
    width: 20,
    height: 18,
    padding: 0,
    fontSize: 9,
    lineHeight: 1,
    borderRadius: 5,
    border: '1px solid var(--dsw-alias-border-l1, #e3e3ea)',
    background: 'var(--dsw-alias-bg-layer-2, #f5f5fa)',
    color: 'var(--dsw-alias-label-secondary, #5a5a68)',
    cursor: 'pointer',
  },
  range: { flex: '1 1 auto', width: '100%', margin: 0, accentColor: 'var(--dsw-alias-label-primary, #1d1d26)' },
  stepLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    color: 'var(--dsw-alias-label-secondary, #5a5a68)',
    fontSize: 11,
  },
  follow: {
    marginLeft: 'auto',
    padding: '0 6px',
    height: 18,
    fontSize: 10,
    borderRadius: 5,
    border: '1px solid var(--dsw-alias-border-l1, #e3e3ea)',
    background: 'var(--dsw-alias-bg-layer-2, #f5f5fa)',
    color: 'var(--dsw-alias-label-secondary, #5a5a68)',
    cursor: 'pointer',
  },
  icon: {
    flex: '0 0 auto',
    width: 20,
    height: 18,
    padding: 0,
    fontSize: 10,
    lineHeight: 1,
    borderRadius: 5,
    border: '1px solid var(--dsw-alias-border-l1, #e3e3ea)',
    background: 'var(--dsw-alias-bg-layer-2, #f5f5fa)',
    color: 'var(--dsw-alias-label-secondary, #5a5a68)',
    cursor: 'pointer',
  },
  toggleBtn: {
    flex: '0 0 auto',
    padding: '1px 6px',
    fontSize: 12,
    lineHeight: '1.5',
    borderRadius: 6,
    border: '1px solid transparent',
    background: 'transparent',
    color: 'var(--dsw-alias-label-tertiary, #8a8a99)',
    cursor: 'pointer',
  },
  inputBtn: {
    flex: '0 0 auto',
    width: 28,
    height: 28,
    padding: 0,
    fontSize: 14,
    lineHeight: 1,
    borderRadius: 8,
    border: '1px solid var(--dsw-alias-border-l1, #e3e3ea)',
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary, #5a5a68)',
    cursor: 'pointer',
  },
  toggleOn: {
    color: 'var(--dsw-alias-label-primary, #1d1d26)',
    background: 'var(--dsw-alias-bg-layer-2, #f5f5fa)',
    borderColor: 'var(--dsw-alias-border-l1, #e3e3ea)',
  },
  err: {
    padding: '6px 10px',
    color: 'var(--dsw-alias-state-error-primary, #b3261e)',
    fontSize: 11,
    borderTop: '1px solid var(--dsw-alias-border-l1, #f3dede)',
  },
}

function kv(k, v) {
  return h('div', { style: S.kv }, h('span', null, k), h('span', { style: S.v }, String(v)))
}

function clock(t) {
  const d = new Date(t)
  return String(d.getHours()).padStart(2, '0') + ':'
    + String(d.getMinutes()).padStart(2, '0') + ':'
    + String(d.getSeconds()).padStart(2, '0')
}

function MonitorPanel() {
  usePanelTick()
  /** 当前会话：面板状态按它隔离。 */
  const sid = currentSessionId()
  const [data, setData] = React.useState(null)
  const [err, setErr] = React.useState('')
  const [open, setOpen] = React.useState(!collapsedSessions.has(sid))
  const [pos, setPos] = React.useState(null)
  /** 0 = 跟随最新一遍；>0 = 用户手动停在某一遍（只读回看）。 */
  const [cursor, setCursor] = React.useState(0)
  const cursorRef = React.useRef(0)
  cursorRef.current = cursor
  /** 回放：点播放后按 1s 一步推进，播到最后自动停。 */
  const [playing, setPlaying] = React.useState(false)
  /** 复制反馈：点 📋 后短暂显示 ✓。 */
  const [copied, setCopied] = React.useState(false)
  /** 历史 work 列表是否展开。 */
  const [listOpen, setListOpen] = React.useState(false)
  /** 放大查看：点画布右下角的按钮后铺满视口看细节。 */
  const [zoom, setZoom] = React.useState(false)
  const totalSteps = data && data.steps ? data.steps.length : 0
  // 切到另一个会话时，把折叠状态换成那个会话自己的。
  React.useEffect(function () {
    setOpen(!collapsedSessions.has(sid))
  }, [sid])
  React.useEffect(function () {
    if (!playing || !totalSteps) return undefined
    const timer = setInterval(function () {
      setCursor(function (c) {
        const now = c || totalSteps
        if (now >= totalSteps) { setPlaying(false); return now }
        return now + 1
      })
    }, 1000)
    return function () { clearInterval(timer) }
  }, [playing, totalSteps])
  const drag = React.useRef(null)
  const moved = React.useRef(false)

  React.useEffect(function () {
    let alive = true
    let timer = 0
    function load() {
      // 面板按会话隔离：带上当前对话的 sessionId 去问宿主；不属于
      // pixelart_open 那个会话的对话一律返回 open:false。
      const sid = currentSessionId()
      const stepQuery = cursorRef.current ? '&step=' + cursorRef.current : ''
      fetch(MONITOR_URL + '?t=' + Date.now() + '&session=' + encodeURIComponent(sid) + stepQuery, { cache: 'no-store' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status)
          return r.json()
        })
        .then(function (j) {
          if (alive) { setData(j); setErr('') }
        })
        .catch(function (e) {
          if (alive) setErr(String((e && e.message) || e))
        })
    }
    load()
    timer = setInterval(load, POLL_MS)
    return function () { alive = false; clearInterval(timer) }
  }, [])

  function down(e) {
    const r = e.currentTarget.getBoundingClientRect()
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top }
    moved.current = false
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch (_) { /* 老浏览器 */ }
    e.preventDefault()
  }

  function move(e) {
    if (!drag.current) return
    moved.current = true
    const x = Math.max(0, Math.min((window.innerWidth || 1280) - 64, e.clientX - drag.current.dx))
    const y = Math.max(0, Math.min((window.innerHeight || 800) - 48, e.clientY - drag.current.dy))
    setPos({ x: x, y: y })
  }

  function up(e) {
    if (!drag.current) return
    drag.current = null
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch (_) { /* noop */ }
  }

  function toggle() {
    if (moved.current) { moved.current = false; return }
    setOpen(function (o) {
      const next = !o
      if (next) collapsedSessions.delete(sid)
      else collapsedSessions.add(sid)
      return next
    })
  }

  const d = data || {}

  // 本会话关掉时不出现；没打开项目时默认也不出现，除非用户主动叫了出来。
  if (hiddenSessions.has(sid)) return null
  if (!forceSessions.has(sid) && (!data || !d.open)) return null

  const anchor = pos ? { left: pos.x, top: pos.y } : { right: 16, bottom: 16 }
  const outer = Object.assign({}, S.outer, anchor)

  if (!open) {
    return h('div', { style: outer },
      h('button', {
        style: S.dot,
        title: '展开像素工作台（可拖动）',
        onPointerDown: down,
        onPointerMove: move,
        onPointerUp: up,
        onClick: toggle,
      }, '\u{1F3A8}'))
  }

  const head = h('div', {
    style: S.head,
    onPointerDown: down,
    onPointerMove: move,
    onPointerUp: up,
    onClick: toggle,
    title: '拖动可移动，点击收起',
  },
    h('span', null, '\u{1F3A8}'),
    h('span', { style: S.title }, d.name || (d.open ? 'untitled' : '\u672A\u6253\u5F00\u9879\u76EE')),
    h('span', { style: S.meta }, d.width ? d.width + '\u00D7' + d.height + ' \u00B7 v' + d.version : ''),
    h('button', {
      style: S.headBtn,
      title: '\u6253\u5F00\u5386\u53F2 work',
      onClick: function (e) { e.stopPropagation(); setListOpen(!listOpen) },
      onPointerDown: function (e) { e.stopPropagation() },
    }, '\u{1F553}'),
    h('span', { style: S.caret }, '\u25BE')
  )

  const steps = d.steps || []
  const shown = Math.max(1, Math.min(cursor || d.cursor || 1, steps.length || 1))
  const curStep = steps.filter(function (s) { return s.step === shown })[0]

  function copyStep() {
    const s = curStep || {}
    const fname = s.file ? String(s.file).split(/[\\/]/).pop() : ''
    const line = '#' + shown + '/' + steps.length + ' ' + (s.name || '\u2014')
      + (fname ? ' ' + fname : '')
      + (s.ts ? ' ' + new Date(s.ts).toLocaleString() : '')
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(line)
    } catch (e) { /* 剪贴板不可用 */ }
    setCopied(true)
    setTimeout(function () { setCopied(false) }, 1500)
  }

  function openDir() {
    try { fetch(DIR_URL, { method: 'POST' }).catch(function () {}) } catch (e) { /* noop */ }
  }

  function openWork(file) {
    try {
      fetch(WORK_URL, { method: 'POST', body: JSON.stringify({ file: file }) })
        .then(function () { setListOpen(false); setCursor(0) })
        .catch(function () { /* 保持原状态 */ })
    } catch (e) { /* noop */ }
  }

  const body = h('div', { style: S.body },
    d.png
      ? h('div', { style: S.canvasWrap },
          h('img', { style: S.img, alt: 'canvas', src: d.png }),
          h('button', {
            style: S.zoomBtn,
            title: '\u653E\u5927\u67E5\u770B',
            onClick: function (e) { e.stopPropagation(); setZoom(true) },
          }, '\u26F6'))
      : h('div', { style: S.empty }, d.open
          ? '\u7B49\u5F85\u7B2C\u4E00\u5E27\u2026'
          : '\u8FD8\u6CA1\u6709\u6253\u5F00\u9879\u76EE\u3002\u8BA9 AI \u8C03\u7528 pixelart_open \u6253\u5F00\u4E00\u4E2A .pxa\u3002'),
    steps.length
      ? h('div', { style: S.timeline },
          h('div', { style: S.timelineRow },
            h('button', {
              style: S.play,
              title: playing ? '\u6682\u505C\u56DE\u653E' : '\u6309 1 \u79D2\u4E00\u6B65\u56DE\u653E',
              onClick: function () {
                if (playing) { setPlaying(false); return }
                setCursor(1)
                setPlaying(true)
              },
            }, playing ? '\u275A\u275A' : '\u25B6'),
            h('input', {
              type: 'range', min: 1, max: steps.length, step: 1, value: shown, style: S.range,
              'aria-label': '\u56DE\u770B\u67D0\u4E00\u904D',
              onChange: function (e) { setPlaying(false); setCursor(parseInt(e.target.value, 10) || 1) },
            })),
          h('div', { style: S.stepLabel },
            '\u7B2C ' + shown + '/' + steps.length + ' \u904D \u00B7 ' + ((curStep && curStep.name) || '\u2014'),
            h('button', {
              style: S.icon,
              title: '\u590D\u5236\u8FD9\u4E00\u904D\u7684\u4FE1\u606F',
              onClick: copyStep,
            }, copied ? '\u2713' : '\u{1F4CB}'),
            h('button', {
              style: S.icon,
              title: '\u6253\u5F00\u5FEB\u7167\u76EE\u5F55',
              onClick: openDir,
            }, '\u{1F4C2}'),
            cursor
              ? h('button', {
                  style: S.follow,
                  title: '\u56DE\u5230\u6700\u65B0\u4E00\u904D',
                  onClick: function () { setPlaying(false); setCursor(0) },
                }, '\u23ED')
              : null))
      : null,
    kv('像素', d.pixels),
    kv('帧 / 图层', d.frames + ' / ' + d.layers),
    d.lastOp ? kv('最后操作', d.lastOp) : null,
    listOpen
      ? h('div', { style: S.hist },
          h('div', { style: S.histCount },
            (d.history || []).length >= 50
              ? '\u6700\u8FD1 50 \u4E2A work\uFF08\u66F4\u591A\u7684\u5728\u78C1\u76D8\u4E0A\uFF09'
              : '\u5171 ' + (d.history || []).length + ' \u4E2A work'),
          (d.history || []).length
            ? (d.history || []).map(function (w, i) {
                return h('button', {
                  key: i,
                  style: S.histRow,
                  title: w.file || '',
                  onClick: function () { openWork(w.file) },
                }, (w.title ? w.title + ' \u00B7 ' : '') + new Date(w.ts).toLocaleString() + ' \u00B7 ' + w.steps + ' \u6B65')
              })
            : h('div', { style: S.empty }, '\u8FD8\u6CA1\u6709\u5386\u53F2 work'))
      : null
  )

  return h('div', { style: outer },
    h('div', { style: S.card }, head, body, err ? h('div', { style: S.err }, 'monitor: ' + err) : null),
    zoom && d.png
      ? h('div', { style: S.zoomMask, onClick: function () { setZoom(false) } },
          h('img', { style: S.zoomImg, src: d.png, alt: 'zoom-preview' }))
      : null)
}

/**
 * Invisible probe in the composer dock. Its only job is to publish the current
 * conversation's session id to `window`, because `shell.overlay` is root-scoped
 * and receives no session id. It renders nothing, so it adds no layout height.
 */
function SessionProbe(props) {
  if (typeof window !== 'undefined' && props && props.sessionId) {
    window.__asepriteSessionId = String(props.sessionId)
  }
  return null
}

/**
 * 输入框右侧的 🎨 按钮：点一下把本会话的浮窗叫出来。
 * 位置是 `conversation.input.right`（dsh-purge 的按钮也在这里），
 * 只控制浮窗显隐，不换页。收起交给面板标题/圆钮。
 */
function InputToggle(props) {
  usePanelTick()
  const sid = props && props.sessionId ? String(props.sessionId) : ''
  const shown = sid ? (!hiddenSessions.has(sid) && forceSessions.has(sid)) : false
  return h('button', {
    style: S.inputBtn,
    title: shown ? '\u50CF\u7D20\u5DE5\u4F5C\u53F0\u5DF2\u6253\u5F00' : '\u663E\u793A\u50CF\u7D20\u5DE5\u4F5C\u53F0',
    onClick: function () { showPanelFor(sid) },
  }, '\u{1F3A8}')
}

/**
 * 监视器卡片（`shell.overlay` 浮层）的样式表与渲染函数。
 *
 * overlay 是富浮层 slot：面板自己负责整块卡片的样式与交互，
 * 不用往 DOM 里塞节点、也不用 createPortal。会话隔离靠
 * `conversation.input.dock` 上注册的 probe 拿到的 sessionId。
 */
const V = {
  page: {
    height: '100%',
    overflow: 'auto',
    padding: '24px 16px',
    background: 'var(--dsw-alias-bg-layer-1, #fafafc)',
  },
  card: {
    maxWidth: 720,
    margin: '0 auto',
    display: 'grid',
    gap: 10,
    padding: 16,
    borderRadius: 14,
    border: '1px solid var(--dsw-alias-border-l1, #e3e3ea)',
    background: 'var(--dsw-alias-bg-layer-2, #ffffff)',
  },
  head: { display: 'flex', alignItems: 'baseline', gap: 8 },
  title: { fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary, #1d1d26)' },
  meta: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #8a8a99)' },
  canvas: {
    display: 'grid',
    placeItems: 'center',
    padding: 12,
    borderRadius: 10,
    backgroundColor: '#f2f4f7',
    backgroundImage: 'linear-gradient(45deg,#e3e7ee 25%,transparent 25%,transparent 75%,#e3e7ee 75%),linear-gradient(45deg,#e3e7ee 25%,transparent 25%,transparent 75%,#e3e7ee 75%)',
    backgroundSize: '16px 16px',
    backgroundPosition: '0 0, 8px 8px',
  },
  img: { width: '100%', maxWidth: 480, display: 'block', imageRendering: 'pixelated' },
  empty: { padding: '32px 12px', textAlign: 'center', color: 'var(--dsw-alias-label-tertiary, #8a8a99)' },
  timeline: { display: 'grid', gap: 4 },
  row: { display: 'flex', alignItems: 'center', gap: 8 },
  play: {
    flex: '0 0 auto',
    width: 26,
    height: 22,
    padding: 0,
    fontSize: 10,
    borderRadius: 6,
    border: '1px solid var(--dsw-alias-border-l1, #e3e3ea)',
    background: 'var(--dsw-alias-bg-layer-3, #f5f5fa)',
    color: 'var(--dsw-alias-label-secondary, #5a5a68)',
    cursor: 'pointer',
  },
  range: { flex: '1 1 auto', width: '100%', accentColor: 'var(--dsw-alias-label-primary, #1d1d26)' },
  label: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 11,
    color: 'var(--dsw-alias-label-secondary, #5a5a68)',
  },
  follow: {
    marginLeft: 'auto',
    padding: '0 8px',
    height: 20,
    fontSize: 10,
    borderRadius: 6,
    border: '1px solid var(--dsw-alias-border-l1, #e3e3ea)',
    background: 'var(--dsw-alias-bg-layer-3, #f5f5fa)',
    color: 'var(--dsw-alias-label-secondary, #5a5a68)',
    cursor: 'pointer',
  },
  kv: { display: 'flex', gap: 16, fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #8a8a99)' },
}

function AsepriteView() {
  const [data, setData] = React.useState(null)
  const [cursor, setCursor] = React.useState(0)
  const [playing, setPlaying] = React.useState(false)
  const cursorRef = React.useRef(0)
  cursorRef.current = cursor
  const totalSteps = data && data.steps ? data.steps.length : 0

  React.useEffect(function () {
    let alive = true
    let timer = 0
    function load() {
      const sid = currentSessionId()
      const stepQuery = cursorRef.current ? '&step=' + cursorRef.current : ''
      fetch(MONITOR_URL + '?t=' + Date.now() + '&session=' + encodeURIComponent(sid) + stepQuery, { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() })
        .then(function (j) { if (alive) setData(j) })
        .catch(function () { /* 保持上一帧 */ })
    }
    load()
    timer = setInterval(load, POLL_MS)
    return function () { alive = false; clearInterval(timer) }
  }, [])

  React.useEffect(function () {
    if (!playing || !totalSteps) return undefined
    const timer = setInterval(function () {
      setCursor(function (c) {
        const now = c || totalSteps
        if (now >= totalSteps) { setPlaying(false); return now }
        return now + 1
      })
    }, 1000)
    return function () { clearInterval(timer) }
  }, [playing, totalSteps])

  const d = data || {}
  const steps = d.steps || []
  const shown = Math.max(1, Math.min(cursor || d.cursor || 1, steps.length || 1))
  const curStep = steps.filter(function (s) { return s.step === shown })[0]

  return h('div', { style: V.page },
    h('div', { style: V.card },
      h('div', { style: V.head },
        h('span', { style: V.title }, d.name || 'untitled'),
        h('span', { style: V.meta }, d.width ? d.width + '\u00D7' + d.height : ''),
        h('span', { style: V.meta }, d.version ? 'v' + d.version : '')),
      d.open
        ? (d.png
            ? h('div', { style: V.canvas }, h('img', { style: V.img, alt: 'canvas', src: d.png }))
            : h('div', { style: V.empty }, '\u7B49\u5F85\u7B2C\u4E00\u5E27\u2026'))
        : h('div', { style: V.empty }, '\u8FD9\u4E2A\u5BF9\u8BDD\u8FD8\u6CA1\u6709\u6253\u5F00 .pxa \u9879\u76EE\u3002\u8BA9 AI \u8C03\u7528 pixelart_open \u5373\u53EF\u3002'),
      steps.length
        ? h('div', { style: V.timeline },
            h('div', { style: V.row },
              h('button', {
                style: V.play,
                title: playing ? '\u6682\u505C\u56DE\u653E' : '\u6309 1 \u79D2\u4E00\u6B65\u56DE\u653E',
                onClick: function () {
                  if (playing) { setPlaying(false); return }
                  setCursor(1)
                  setPlaying(true)
                },
              }, playing ? '\u275A\u275A' : '\u25B6'),
              h('input', {
                type: 'range', min: 1, max: steps.length, step: 1, value: shown, style: V.range,
                'aria-label': '\u56DE\u770B\u67D0\u4E00\u904D',
                onChange: function (e) { setPlaying(false); setCursor(parseInt(e.target.value, 10) || 1) },
              })),
            h('div', { style: V.label },
              '\u7B2C ' + shown + '/' + steps.length + ' \u904D \u00B7 ' + ((curStep && curStep.name) || '\u2014'),
              cursor
                ? h('button', {
                    style: V.follow,
                    onClick: function () { setPlaying(false); setCursor(0) },
                  }, '\u56DE\u6700\u65B0')
                : null))
        : null,
      h('div', { style: V.kv },
        h('span', null, '\u50CF\u7D20 ' + (d.pixels || 0)),
        h('span', null, '\u5E27/\u56FE\u5C42 ' + (d.frames || 0) + '/' + (d.layers || 0)))))
}

const name = 'cli-anything-aseprite-monitor'
const inject = ['slots']

function apply(ctx) {
  // 文案走宿主 locale 服务；没注入成功时 t() 退回中文原文。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['locale'], function (l) { localeRt = l; notifyPanel() })
  }
  // 会话服务：浮层据此判断"我现在在哪个对话里"。没有它们时自动退回探针。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['sessions', 'uiWorkspace'], function (host) { sessionHost = host; notifyPanel() })
  }
  ctx.slots.inject('conversation.input.dock', function () {
    return ctx.slots.register({
      name: 'conversation.input.dock',
      id: 'aseprite-session-probe',
      order: 5,
      inject: function (sessionId) { return { sessionId: sessionId } },
    }, SessionProbe)
  })
  ctx.slots.inject('conversation.input.right', function () {
    return ctx.slots.register({
      name: 'conversation.input.right',
      id: 'aseprite-toggle',
      order: 20,
      inject: function (sessionId) { return { sessionId: sessionId } },
    }, InputToggle)
  })
  ctx.slots.inject('shell.overlay', function () {
    return ctx.slots.register({
      name: 'shell.overlay',
      id: 'aseprite-monitor',
      order: 100,
    }, MonitorPanel)
  })
}


		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
