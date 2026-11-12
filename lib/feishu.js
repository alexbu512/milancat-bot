/**
 * Feishu (Lark) bridge for milancat bot.
 *
 * The PC is the brain: DSH keeps running, this module keeps a `lark-cli event
 * consume im.message.receive_v1 --as bot` child alive, and every message that
 * arrives in the bound group chat becomes one assistant turn. The assistant's
 * answer is pushed straight back to the same group, so the phone and the desktop
 * panel are looking at one conversation, not two copies.
 *
 * Everything long-lived lives on globalThis: DSH re-imports engine.js (and this
 * file) per request, so module-level state would be recreated under our feet.
 */
import { spawn, execFile } from 'node:child_process'
import { existsSync, openSync, writeSync, closeSync, statSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const SHARED = (globalThis.__MILANCAT_SHARED__ ||= {})

/**
 * Bumped whenever this file changes. The host re-imports us per request, so a
 * child spawned by an older generation must be replaced — otherwise its exit
 * handlers (and its silence) win over the new code.
 */
const GEN = 6

/**
 * Polling fallback. lark-cli allows exactly one long connection per Feishu app;
 * when another client already holds it (the CLI refuses with "another event bus
 * is already connected to this app"), we read the group history over HTTP
 * instead. Same conversation, ~1.5 s behind.
 */
const POLL_MS = 1500

/** Raw append for child stderr, so the log reads like the CLI wrote it. */
function appendLog(text) {
  try {
    if (!LOG_PATH) return
    const fd = openSync(LOG_PATH, 'a')
    writeSync(fd, text.endsWith('\n') ? text : text + '\n')
    closeSync(fd)
  } catch {}
}

/** File log: the child's own stderr goes here too, so silence is diagnosable. */
export function bridgeLogPath() {
  return LOG_PATH
}
let LOG_PATH = ''

function fileLog(line) {
  try {
    if (!LOG_PATH) return
    if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > 512 * 1024) {
      try {
        renameSync(LOG_PATH, LOG_PATH + '.1')
      } catch {}
    }
    const fd = openSync(LOG_PATH, 'a')
    writeSync(fd, `${new Date().toISOString()} ${line}\n`)
    closeSync(fd)
  } catch {}
}

const NPM_DIR = process.env.APPDATA ? join(process.env.APPDATA, 'npm') : ''
const RUN_JS = NPM_DIR ? join(NPM_DIR, 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js') : ''
/**
 * `scripts/run.js` is only a shim: it `execFileSync`s the native binary with
 * `stdio:'inherit'` and NO windowsHide. Launched from a GUI host that has no
 * console, that grandchild is a console app with no attached console — Windows
 * gives it a fresh visible console window every single time. Polling every
 * 1.5 s therefore flashed a black window 40 times a minute. Calling the binary
 * directly (with windowsHide) keeps the whole thing silent.
 */
const CLI_BIN = NPM_DIR ? join(NPM_DIR, 'node_modules', '@larksuite', 'cli', 'bin', process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli') : ''

/** jq projection: flat fields the event actually exposes (see `event schema`). */
const JQ =
  '{chat:.chat_id,chatType:.chat_type,text:.content,messageId:.message_id,sender:.sender_id,messageType:.message_type,createdAt:.create_time}'

function fs_() {
  const f = (SHARED.feishu ||= {
    child: null,
    running: false,
    ready: false,
    startedAt: 0,
    error: '',
    restarts: 0,
    lastEventAt: 0,
    seen: [],
    sent: [],
    discovered: [],
    buffer: '',
    stderr: [],
    getConfig: null,
    onText: null,
  })
  // Typed backfills: older generations created this object without these keys.
  if (!Array.isArray(f.seen)) f.seen = []
  if (!Array.isArray(f.sent)) f.sent = []
  if (!Array.isArray(f.discovered)) f.discovered = []
  if (!Array.isArray(f.stderr)) f.stderr = []
  if (typeof f.buffer !== 'string') f.buffer = ''
  if (typeof f.mode !== 'string') f.mode = 'event'
  if (typeof f.directOk !== 'boolean') f.directOk = false
  if (typeof f.directProbeAt !== 'number') f.directProbeAt = 0
  return f
}

export function cliAvailable() {
  return Boolean(RUN_JS && existsSync(RUN_JS))
}

/** Command + leading args for one CLI call: the native binary when present. */
function cliInvocation(args) {
  if (CLI_BIN && existsSync(CLI_BIN)) return { file: CLI_BIN, argv: args }
  return { file: process.execPath, argv: [RUN_JS, ...args] }
}

/** One-shot lark-cli call. Resolves the parsed JSON envelope, never throws. */
export function larkRun(args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    if (!cliAvailable()) return resolve({ ok: false, error: 'lark-cli-not-found' })
    const { file, argv } = cliInvocation(args)
    const child = execFile(
      file,
      argv,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const text = String(stdout || '').trim()
        let json = null
        if (text) {
          try {
            json = JSON.parse(text)
          } catch {
            json = null
          }
        }
        if (json) return resolve(json)
        const detail = String(stderr || err?.message || '').trim()
        resolve({ ok: false, error: detail || 'no-output', raw: text.slice(0, 800) })
      },
    )
    child.stdin?.end()
  })
}

/**
 * Validate the boss's own app credentials without asking them to read logs:
 * fetch a tenant token, then ask which groups the bot is already in. Both calls
 * are pure HTTPS, so a wrong secret is reported in one round-trip.
 */
export async function verifyApp(cfg = {}) {
  const appId = String(cfg.appId || '').trim()
  const appSecret = String(cfg.appSecret || '').trim()
  if (!appId || !appSecret) return { ok: false, error: 'appId and appSecret are both required' }
  const f = fs_()
  f.token = null
  const tok = await tenantToken(f, appId, appSecret)
  if (!tok || tok.error) return { ok: false, error: tok?.error || 'token-failed', appId }
  const res = await fetch(`${OPEN_API}/im/v1/chats?page_size=20`, {
    headers: { authorization: `Bearer ${tok.value}` },
  })
  const body = await res.json().catch(() => null)
  if (!body || body.code !== 0) {
    return { ok: false, error: `chats: ${body?.msg || res.status}`, appId }
  }
  const chats = (body.data?.items || []).map((c) => ({ chatId: c.chat_id, name: c.name }))
  return { ok: true, appId, chats, inChats: chats.length }
}

/** Re-read config and bounce whichever transport is running. */
export async function restart(cfg = {}) {
  const f = fs_()
  f.token = null
  f.pollVia = ''
  f.lastDirectError = ''
  stopPoll()
  stopBridge()
  // Only bounce a transport that already has a config source; the engine wires
  // getConfig through startBridge, and without it a fresh poll would read {}.
  if (cfg.enabled !== false && typeof f.getConfig === 'function') startPoll({ note: 'restart' })
  return { ok: true, bridge: bridgeStatus() }
}

export async function probe() {
  const f = fs_()
  const ver = await larkRun(['--version'], { timeoutMs: 15000 })
  const auth = await larkRun(['auth', 'status'], { timeoutMs: 20000 })
  const botReady = Boolean(auth?.identities?.bot?.available)
  return {
    cli: cliAvailable(),
    cliPath: RUN_JS,
    version: String(ver?.raw || ver?.data || ver?.version || '').trim() || (ver?.ok === false ? '' : ''),
    appId: auth?.appId || '',
    botReady,
    userReady: Boolean(auth?.identities?.user?.available),
    bridge: bridgeStatus(),
  }
}

/**
 * Step-by-step readiness check. The panel renders it, and the assistant reads it
 * through `/feishu/doctor` before telling the boss what to do next — so the
 * wizard speaks from measurements, not from a generic checklist.
 */
export async function doctor(cfg = {}) {
  const steps = []
  const cli = cliAvailable()
  const hasApp = Boolean(cfg.appId && cfg.appSecret)
  const f = fs_()
  let appId = String(cfg.appId || '')

  // 1. The boss's own app — the only requirement once it is filled in.
  if (!hasApp) {
    steps.push({
      key: 'app',
      label: '填了你自己那个机器人的 App ID / Secret',
      ok: false,
      detail: '还没填：现在用的是这台电脑上 lark-cli 登录的那个应用',
      fix: '开放平台 → 你的应用 → 凭证与基础信息，把 App ID 和 App Secret 填到上面两个输入框，保存',
    })
  } else {
    const check = await verifyApp(cfg)
    steps.push({
      key: 'app',
      label: '自己的机器人凭证可用',
      ok: check.ok,
      detail: check.ok ? `app ${check.appId}，在 ${check.inChats} 个群里` : String(check.error || '').slice(0, 200),
      fix: check.ok ? '' : '回到开放平台重新复制 App Secret（只显示一次），确认应用已创建版本并发布',
    })
  }

  let chats = []
  if (hasApp) {
    const check = await verifyApp(cfg)
    if (check.ok) chats = (check.chats || []).map((c) => ({ chatId: c.chatId, name: c.name }))
  }

  if (!hasApp) {
    steps.push({
      key: 'cli',
      label: '这台电脑装好了 lark-cli',
      ok: cli,
      detail: cli ? RUN_JS : '没找到 lark-cli，先 npm i -g @larksuite/cli',
      fix: 'npm i -g @larksuite/cli 然后 lark-cli auth login',
    })

    let botReady = false
    if (cli) {
      const auth = await larkRun(['auth', 'status'], { timeoutMs: 20000 })
      appId = String(auth?.appId || '')
      botReady = Boolean(auth?.identities?.bot?.available)
      steps.push({
        key: 'auth',
        label: '机器人身份已登录',
        ok: botReady,
        detail: botReady ? `app ${appId}` : auth?.note || '还没有机器人身份',
        fix: 'lark-cli auth login --help',
      })
    }

    let scopeOk = false
    if (cli && botReady) {
      const listed = await listChats()
      if (listed.ok) {
        scopeOk = true
        chats = listed.chats
      }
      const err = String(listed.error || '')
      steps.push({
        key: 'scopes',
        label: '应用开了消息/群组权限',
        ok: scopeOk,
        detail: scopeOk ? '可以读群列表' : err.slice(0, 200),
        fix: appId
          ? `去 https://open.feishu.cn/app/${appId}/auth 申请 im:message、im:message:readonly、im:chat:readonly，然后创建版本并发布`
          : '先完成机器人登录',
      })
    }
  }

  steps.push({
    key: 'groups',
    label: '你要用的那个机器人在群里',
    ok: chats.length > 0,
    detail: chats.length
      ? chats.map((c) => c.name).join('、')
      : '这个机器人还不在任何群：群设置 → 机器人 → 添加它',
    fix: '在飞书里建一个群，群设置 → 机器人 → 添加你建的那个机器人',
  })

  // 3. Inbound. A group's message history needs `im:message.group_msg`; without it
  //    the channel still works, but through this machine's user token instead.
  if (hasApp) {
    const direct = await directRead(f, cfg.chatId || '', 0)
    steps.push({
      key: 'read',
      label: '机器人能自己读群消息（im:message.group_msg）',
      ok: Boolean(direct.ok),
      detail: direct.ok
        ? '可以：收消息完全走机器人自己，不经过这台电脑上的命令行'
        : `${String(direct.error || '').slice(0, 160)}｜现在改由你本人账号读，功能一样`,
      fix: direct.ok
        ? ''
        : `开放平台 → 你的应用 → 权限管理，申请 im:message.group_msg（读取群消息），再创建版本并发布；不开也能用`,
    })
  }

  const bound = Boolean(cfg.chatId)
  steps.push({
    key: 'bind',
    label: '面板绑定了一个群',
    ok: bound,
    detail: bound ? cfg.chatName || cfg.chatId : '还没绑定',
    fix: '上面的群出现后，点它就能绑定',
  })

  const br = bridgeStatus()
  steps.push({
    key: 'channel',
    label: '通道在跑',
    ok: Boolean(br.running),
    detail: br.running
      ? (br.mode === 'poll' ? `轮询兜底（${POLL_MS / 1000} 秒）` : '事件长连接') + (f.pollVia === 'direct' ? '，直连' : '')
      : br.error || '未启动',
    fix: '点「重启通道」',
  })

  const firstBad = steps.find((s) => !s.ok) || null
  return {
    ok: steps.every((s) => s.ok),
    appId,
    consoleUrl: appId ? `https://open.feishu.cn/app/${appId}/auth` : '',
    steps,
    next: firstBad ? { key: firstBad.key, label: firstBad.label, fix: firstBad.fix } : null,
    mode: br.mode,
    chats,
  }
}

/** Groups the bot already belongs to. Empty list means: add the bot to a group first. */
export async function listChats() {
  // The boss's own app answers this directly, and — unlike the CLI — the groups
  // it reports are groups *its* bot is in, which is the question being asked.
  const cfg = safeConfig()
  if (cfg.appId && cfg.appSecret) {
    const check = await verifyApp(cfg)
    if (check.ok) {
      const chats = (check.chats || []).map((c) => ({
        chatId: c.chatId,
        name: c.name || '(未命名群)',
        type: 'group',
        members: 0,
      }))
      return { ok: true, chats, via: 'direct' }
    }
    fileLog(`direct chat-list failed: ${String(check.error || '').slice(0, 160)}`)
  }
  const out = await larkRun(['im', '+chat-list', '--as', 'bot', '--page-size', '50'], { timeoutMs: 30000 })
  if (out?.ok === false) return { ok: false, error: out.error || 'chat-list-failed', chats: [] }
  const items = out?.data?.chats || out?.data?.items || []
  const chats = (Array.isArray(items) ? items : []).map((c) => ({
    chatId: String(c.chat_id || c.chatId || ''),
    name: String(c.name || '(未命名群)'),
    type: String(c.chat_type || c.chatType || 'group'),
    members: Number(c.user_count ?? c.member_count ?? 0) || 0,
  }))
  return { ok: true, chats, via: 'cli' }
}

export async function sendText(chatId, text, { idempotencyKey } = {}) {
  const body = body_of(text)
  if (!chatId || !body) return { ok: false, error: 'chat-and-text-required' }
  const f = fs_()
  // The boss's own app (app id + secret) is the preferred sender: it is the bot
  // people actually added to the group, and it needs no local CLI at all.
  const cfg = safeConfig()
  if (cfg.appId && cfg.appSecret) {
    const direct = await directSend(f, chatId, body)
    if (direct.ok) {
      if (direct.messageId) {
        f.sent.push(String(direct.messageId))
        if (f.sent.length > 300) f.sent.splice(0, f.sent.length - 300)
      }
      return direct
    }
    f.lastDirectError = direct.error || ''
    fileLog(`direct send failed: ${String(direct.error || '').slice(0, 200)}`)
  }
  const args = ['im', '+messages-send', '--as', 'bot', '--chat-id', chatId, '--text', body]
  if (idempotencyKey) args.push('--idempotency-key', String(idempotencyKey))
  const out = await larkRun(args, { timeoutMs: 30000 })
  if (out?.ok === false) return { ok: false, error: out.error || 'send-failed' }
  const id = out?.data?.message_id || out?.data?.messageId || ''
  if (id) {
    f.sent.push(String(id))
    if (f.sent.length > 300) f.sent.splice(0, f.sent.length - 300)
  }
  return { ok: true, messageId: String(id || '') }
}

/* ── direct Open API (the boss's own app) ────────────────────────────────
 * Everything below talks to https://open.feishu.cn with fetch(): no child
 * process, so no console window and no lark-cli app-identity coupling. The
 * tenant token lives 2 h; refresh a minute early. */

const OPEN_API = 'https://open.feishu.cn/open-apis'

function body_of(text) {
  return String(text == null ? '' : text).trim()
}

async function tenantToken(f, appId, appSecret) {
  const now = Date.now()
  if (f.token && f.token.appId === appId && f.token.value && f.token.expireAt > now + 60_000) {
    return f.token
  }
  const res = await fetch(`${OPEN_API}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  })
  const body = await res.json().catch(() => null)
  if (!body || body.code !== 0 || !body.tenant_access_token) {
    f.token = null
    return { error: `token: ${body?.msg || body?.code || res.status}` }
  }
  f.token = {
    appId,
    value: body.tenant_access_token,
    expireAt: now + Number(body.expire || 7200) * 1000,
  }
  fileLog(`tenant token refreshed for ${appId}`)
  return f.token
}

async function directSend(f, chatId, text) {
  const cfg = safeConfig()
  const tok = await tenantToken(f, cfg.appId, cfg.appSecret)
  if (!tok || tok.error) return { ok: false, error: tok?.error || 'no-token' }
  const res = await fetch(`${OPEN_API}/im/v1/messages?receive_id_type=chat_id`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok.value}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) }),
  })
  const body = await res.json().catch(() => null)
  if (!body || body.code !== 0) return { ok: false, error: `direct: ${body?.msg || res.status}` }
  return { ok: true, messageId: String(body.data?.message_id || '') }
}

/**
 * Read one page straight from the Open API. `GET /im/v1/messages` on a group
 * needs `im:message.group_msg` (reading a bot's own chat history is not covered
 * by im:message:readonly) — when that scope is missing the caller falls back to
 * the desktop user token, so the phone channel still works.
 */
async function directRead(f, chatId, sinceMs) {
  const cfg = safeConfig()
  if (!cfg.appId || !cfg.appSecret) return { ok: false, error: 'no-app-credentials' }
  const tok = await tenantToken(f, cfg.appId, cfg.appSecret)
  if (!tok || tok.error) return { ok: false, error: tok?.error || 'no-token' }
  const qs = new URLSearchParams({
    container_id_type: 'chat',
    container_id: chatId,
    page_size: '20',
    sort_type: 'ByCreateTimeAsc',
  })
  if (sinceMs) qs.set('start_time', String(Math.floor(sinceMs / 1000)))
  const res = await fetch(`${OPEN_API}/im/v1/messages?${qs}`, {
    headers: { authorization: `Bearer ${tok.value}` },
  })
  const body = await res.json().catch(() => null)
  if (!body || body.code !== 0) {
    const msg = String(body?.msg || res.status)
    f.lastDirectError = msg
    return { ok: false, error: msg, code: body?.code || 0 }
  }
  const items = (body.data?.items || []).map((m) => ({
    message_id: m.message_id,
    msg_type: m.msg_type,
    content: parseContent(m),
    create_time: Number(m.create_time || 0),
    sender: { id: m.sender?.id, sender_type: m.sender?.sender_type },
  }))
  return { ok: true, data: { items }, direct: true }
}

/** Feishu stores text as `{"text":"…"}` inside content; other types stay raw. */
function parseContent(m) {
  const raw = String(m.body?.content ?? m.content ?? '')
  if (m.msg_type === 'text') {
    try {
      return String(JSON.parse(raw).text || '').trim()
    } catch {
      return raw.trim()
    }
  }
  if (m.msg_type === 'post') {
    try {
      const parsed = JSON.parse(raw)
      const out = []
      const walk = (n) => {
        if (Array.isArray(n)) return n.forEach(walk)
        if (!n || typeof n !== 'object') return
        if (typeof n.text === 'string') out.push(n.text)
        Object.values(n).forEach(walk)
      }
      walk(parsed)
      return out.join(' ').replace(/\s+/g, ' ').trim()
    } catch {
      return ''
    }
  }
  return ''
}

export function bridgeStatus() {
  const f = fs_()
  // In poll mode the timer — not the event child — is the truth. Older module
  // generations still hold exit handlers that write running=false; deriving the
  // flag here keeps a stale child from mislabelling a working bridge.
  const polling = Boolean(f.pollTimer)
  return {
    running: polling ? true : f.running,
    ready: polling ? true : f.ready,
    mode: f.mode || 'event',
    pid: f.child?.pid || 0,
    startedAt: f.startedAt,
    lastEventAt: f.lastEventAt,
    error: f.error,
    note: f.note || '',
    lastPollError: f.lastPollError || '',
    restarts: f.restarts,
    gen: f.gen || 0,
    exitCode: f.exitCode ?? null,
    discovered: (f.discovered || []).slice(-20),
    stderr: f.stderr.slice(-6),
  }
}

/**
 * Start the long-lived consumer. Idempotent: a second call while the child is
 * alive only refreshes the config/onText callbacks.
 *
 * getConfig() -> { enabled, chatId }  (read fresh on every event, so re-binding
 *   the panel never needs a restart)
 * onText(text, meta) -> Promise   (one assistant turn; the caller answers)
 */
export function startBridge({ getConfig, onText, onLog, logPath }) {
  const f = fs_()
  if (logPath) LOG_PATH = logPath
  f.getConfig = getConfig
  f.onText = onText
  if (onLog) f.onLog = onLog
  // A polling bridge already delivers messages; spawning a doomed event child on
  // every panel poll would only spam the log.
  if (f.pollTimer) return bridgeStatus()
  if (f.running && f.child) {
    if (f.gen === GEN) return bridgeStatus()
    // An older generation owns this child: replace it so the current code runs.
    try {
      f.child.kill()
    } catch {}
    f.child = null
    f.running = false
    f.restarts = 0
  }
  if (!cliAvailable()) {
    f.error = `lark-cli not found: ${RUN_JS || '(APPDATA unset)'}`
    return bridgeStatus()
  }

  const args = ['event', 'consume', 'im.message.receive_v1', '--as', 'bot', '--jq', JQ]
  let child
  fileLog(`spawn gen=${GEN} ${JSON.stringify(args)}`)
  try {
    const inv = cliInvocation(args)
    child = spawn(inv.file, inv.argv, {
      windowsHide: true,
      // stderr stays a pipe so the `[event] ready event_key=` marker is visible to
      // us, and is mirrored into the log file below.
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    })
  } catch (err) {
    f.error = `spawn failed: ${err?.message || err}`
    fileLog(`spawn threw: ${err?.message || err}`)
    return bridgeStatus()
  }
  if (child.on) child.on('error', (err) => fileLog(`child error: ${err?.message || err}`))
  fileLog(`spawned pid=${child.pid}`)

  f.child = child
  f.gen = GEN
  f.mode = 'event'
  f.running = true
  f.ready = false
  f.error = ''
  f.startedAt = Date.now()
  f.buffer = ''
  f.stderr = []

  // stdin must stay open: lark-cli treats EOF as "shut down now".
  child.stdin.on('error', () => {})

  const log = (line) => {
    f.stderr.push(String(line).slice(0, 400))
    if (f.stderr.length > 40) f.stderr.shift()
    try {
      f.onLog?.(String(line))
    } catch {}
  }

  child.stdout.setEncoding('utf8')
  child.stdout?.on('data', (chunk) => {
    f.buffer += chunk
    let idx
    while ((idx = f.buffer.indexOf('\n')) >= 0) {
      const line = f.buffer.slice(0, idx).trim()
      f.buffer = f.buffer.slice(idx + 1)
      if (!line) continue
      let parsed = false
      try {
        JSON.parse(line)
        parsed = true
      } catch {}
      if (!parsed) log('out: ' + line)
      else handleLine(line)
    }
  })

  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk) => {
    appendLog(String(chunk))
    for (const line of String(chunk).split('\n')) {
      const t = line.trim()
      if (!t) continue
      if (/\[event\] ready event_key=/.test(t)) f.ready = true
      log(t)
    }
  })

  child.on('exit', (code, signal) => {
    f.exitCode = code
    fileLog(`exit code=${code} signal=${signal}`)
    if (f.buffer.trim()) log('tail: ' + f.buffer.trim())
    // A polling bridge does not depend on this child: do not let its exit erase
    // the running state, and do not spawn replacements.
    if (f.mode === 'poll' && f.pollTimer) return
    f.running = false
    f.ready = false
    f.child = null
    if (code !== 0) f.error = `bridge exited with code ${code}`
    // The app-level long connection is single-tenant: another client holds it.
    // History polling needs no websocket, so the phone channel still works.
    const conflict = f.stderr.some((l) => /another event bus is already connected/.test(l))
    if (conflict) {
      fileLog('bus conflict: switching to history polling')
      return startPoll({ note: '长连接被别的客户端占用，已自动改用轮询' })
    }
    if (f.mode === 'poll') return
    if (f.restarts < 50) {
      f.restarts += 1
      setTimeout(() => {
        try {
          startBridge({ getConfig: f.getConfig, onText: f.onText, onLog: f.onLog })
        } catch {}
      }, Math.min(30000, 3000 * f.restarts))
    }
  })

  return bridgeStatus()
}

function safeConfig() {
  const f = fs_()
  try {
    return f.getConfig?.() || {}
  } catch {
    return {}
  }
}

/**
 * Read one page of the bound group's history. `im +chat-messages-list` works with
 * bot identity and needs no websocket, so it survives the single-connection limit.
 */
async function fetchPage(chatId, sinceMs, as = 'bot') {
  const args = ['im', '+chat-messages-list', '--as', as, '--chat-id', chatId, '--page-size', '20', '--sort', 'asc']
  if (sinceMs) args.push('--start', new Date(sinceMs).toISOString())
  return larkRun(args, { timeoutMs: 25000 })
}

/**
 * Reading group history needs the app-level `im:message:readonly` scope, which a
 * freshly created app usually does not have yet — the call then fails 230027 even
 * though the bot is in the chat and can still send. The desktop login's USER token
 * already sees the same group, so fall back to it and remember which one worked.
 * Sending always stays on the bot identity.
 */
async function readPage(f, chatId) {
  // 1. The boss's own app, straight over HTTPS: no process, no CLI identity, and
  //    the only path that needs nothing granted beyond the app's own scopes.
  //    While the app lacks `im:message.group_msg` every attempt answers 230027, so
  //    a refused probe is remembered and only retried once a minute instead of
  //    firing a doomed request on every 1.5 s tick.
  const cfg = safeConfig()
  const probeDue = f.directOk || !f.directProbeAt || Date.now() - f.directProbeAt > 60_000
  if (cfg.appId && cfg.appSecret && probeDue) {
    const direct = await directRead(f, chatId, f.pollSince)
    if (direct.ok) {
      f.directOk = true
      if (f.pollVia !== 'direct') {
        f.pollVia = 'direct'
        fileLog('poll identity: direct app')
      }
      return direct
    }
    f.directOk = false
    f.directProbeAt = Date.now()
    f.pollVia = f.pollVia === 'direct' ? '' : f.pollVia
  }
  // 2. Fall back to the desktop token — the user is in the same group, so the
  //    phone channel keeps working while the app scope is still pending.
  const order = f.pollAs === 'user' ? ['user', 'bot'] : ['bot', 'user']
  let last = null
  for (const as of order) {
    const res = await fetchPage(chatId, f.pollSince, as)
    if (res && res.ok !== false) {
      if (f.pollAs !== as) {
        f.pollAs = as
        f.pollVia = 'cli'
        fileLog('poll identity: ' + as)
      }
      return res
    }
    last = res
    const hay = JSON.stringify(res?.error || res || '')
    if (!/230027|permission|access denied/i.test(hay)) break
  }
  return last
}

/** Pull every collection-ish array out of a CLI envelope, without assuming its shape. */
function pickItems(json) {
  const out = []
  const walk = (node, depth) => {
    if (!node || depth > 4) return
    if (Array.isArray(node)) {
      for (const it of node) if (it && typeof it === 'object' && (it.message_id || it.messageId)) out.push(it)
      return
    }
    if (typeof node !== 'object') return
    for (const key of ['items', 'messages', 'data', 'result', 'list']) {
      if (node[key]) walk(node[key], depth + 1)
    }
  }
  walk(json, 0)
  return out
}

/** Plain text of one Feishu message, or '' when it carries no words. */
function messageText(item) {
  const type = String(item.msg_type || item.message_type || item.type || 'text')
  // `im +chat-messages-list` already decodes the body, so `content` is plain text
  // here; the raw event shape keeps JSON inside body.content.
  const flat = typeof item.content === 'string' ? item.content.trim() : ''
  if (flat && !/^[[{]/.test(flat)) return type === 'text' || type === 'post' ? flat : ''
  const body = item.body || {}
  const raw = typeof body.content === 'string' ? body.content : body.content ? JSON.stringify(body.content) : ''
  if (type === 'text') {
    try {
      const parsed = JSON.parse(raw)
      return String(parsed.text || '').trim()
    } catch {
      return raw.trim()
    }
  }
  if (type === 'post') {
    try {
      const parsed = JSON.parse(raw)
      const out = []
      const walk = (n) => {
        if (Array.isArray(n)) return n.forEach(walk)
        if (n && typeof n === 'object') {
          if (typeof n.text === 'string' && n.tag !== 'at') out.push(n.text)
          else if (n.tag === 'at') out.push('@' + String(n.user_name || ''))
          Object.values(n).forEach(walk)
        }
      }
      walk(parsed)
      return out.join(' ').replace(/\s+/g, ' ').trim()
    } catch {
      return ''
    }
  }
  return ''
}

/** CLI timestamps come as epoch strings, ISO, or local wall clock `2026-11-08 17:56`. */
function msOf(item) {
  const raw = item.create_time ?? item.createTime ?? item.start_time ?? ''
  if (typeof raw === 'number') return raw
  const text = String(raw || '').trim()
  if (!text) return 0
  if (/^\d{10,}$/.test(text)) return Number(text)
  const iso = text.includes('T') ? text : text.replace(' ', 'T') + ':00+08:00'
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0
}

async function pollOnce() {
  const f = fs_()
  if (f.pollBusy) return
  const cfg = safeConfig()
  if (!cfg.enabled || !cfg.chatId) return
  f.pollBusy = true
  try {
    const res = await readPage(f, cfg.chatId)
    if (res?.ok === false) {
      f.lastPollError = String(res.error || '').slice(0, 300)
      return
    }
    f.lastPollError = ''
    const items = pickItems(res)
    if (!f.pollLoggedShape && items.length) {
      f.pollLoggedShape = true
      fileLog('poll sample: ' + JSON.stringify(items[0]).slice(0, 700))
    }
    items.sort((a, b) => msOf(a) - msOf(b))
    for (const item of items) {
      const messageId = String(item.message_id || item.messageId || '')
      const createdAt = msOf(item)
      if (!messageId) continue
      if (f.seen.includes(messageId)) continue
      if (f.sent.includes(messageId)) continue
      const senderType = String(item.sender?.sender_type || '')
      if (senderType === 'app' || senderType === 'bot') continue
      // `--start` may be read as local wall clock by the CLI; never answer the old
      // history that predates this bind.
      if (createdAt && f.pollSince && createdAt < f.pollSince - 5000) {
        f.seen.push(messageId)
        continue
      }
      const text = messageText(item)
      f.seen.push(messageId)
      if (f.seen.length > 400) f.seen.splice(0, f.seen.length - 400)
      if (createdAt > (f.pollSince || 0)) f.pollSince = createdAt
      f.lastEventAt = Date.now()
      recordDiscovery(f, String(cfg.chatId), text, { chatType: 'group' })
      if (!text) continue
      Promise.resolve()
        .then(() => f.onText?.(text, { chatId: cfg.chatId, messageId, sender: String(item.sender?.id || ''), createdAt }))
        .catch(() => {})
    }
  } finally {
    f.pollBusy = false
  }
}

/**
 * Polling bridge: same callbacks, same state object, just a timer instead of a
 * websocket. Used automatically when the app-level long connection is taken.
 */
export function startPoll({ note = '' } = {}) {
  const f = fs_()
  if (f.pollTimer) return bridgeStatus()
  f.mode = 'poll'
  f.running = true
  f.ready = true
  f.error = ''
  // Nothing needs the event child any more. Setting the cap high also silences
  // restart timers left behind by an OLDER generation of this module: their exit
  // handler checks `restarts < 50` before spawning another doomed child.
  f.restarts = 1000
  f.child = f.child || null
  f.pollTimer = setInterval(() => void pollOnce(), POLL_MS)
  f.pollSince = f.pollSince || Date.now()
  if (note) f.note = note
  fileLog(`poll bridge started every ${POLL_MS}ms since=${new Date(f.pollSince).toISOString()} ${note}`)
  fileLog(`cli exec: ${CLI_BIN && existsSync(CLI_BIN) ? 'native ' + CLI_BIN : 'run.js shim'}`)
  void pollOnce()
  return bridgeStatus()
}

function handleLine(line) {
  const f = fs_()
  let ev = null
  try {
    ev = JSON.parse(line)
  } catch {
    return
  }
  if (!ev || typeof ev !== 'object') return
  f.lastEventAt = Date.now()

  const messageId = String(ev.messageId || ev.id || '')
  const chatId = String(ev.chat || ev.chat_id || '')
  const sender = String(ev.sender || ev.sender_id || '')
  const type = String(ev.messageType || ev.message_type || '')
  let text = String(ev.text ?? ev.content ?? '')

  if (!messageId || !chatId) return
  if (f.seen.includes(messageId)) return
  f.seen.push(messageId)
  if (f.seen.length > 400) f.seen.splice(0, f.seen.length - 400)
  // Never answer our own outbound messages.
  if (f.sent.includes(messageId)) return
  if (type && type !== 'text' && type !== 'post') return

  const cfg = safeConfig()
  // Discovery runs before every filter: the first message in an unbound group is
  // how the panel learns that group exists at all (chat-list needs scopes this
  // app may not have). Binding is still an explicit click.
  recordDiscovery(f, chatId, text, ev)
  if (!cfg.enabled) return
  if (!cfg.chatId || chatId !== cfg.chatId) return

  text = text.trim()
  if (!text) return
  Promise.resolve()
    .then(() => f.onText?.(text, { chatId, messageId, sender, createdAt: ev.createdAt }))
    .catch(() => {})
}

function recordDiscovery(f, chatId, text, ev) {
  const list = (f.discovered ||= [])
  const prev = list.find((d) => d.chatId === chatId)
  const at = Date.now()
  const sample = String(text || '').trim().slice(0, 80)
  if (prev) {
    prev.lastAt = at
    if (sample) prev.sample = sample
    return
  }
  list.push({ chatId, chatType: String(ev.chatType || ''), sample, lastAt: at })
  if (list.length > 30) list.splice(0, list.length - 30)
}

export function stopBridge() {
  const f = fs_()
  f.restarts = 1000 // block the auto-restart path
  stopPoll()
  try {
    f.child?.kill()
  } catch {}
  f.running = false
  f.ready = false
  f.child = null
  f.error = ''
  f.note = ''
  return bridgeStatus()
}

/** Stop only the polling timer; the event child (if any) is untouched. */
export function stopPoll() {
  const f = fs_()
  if (f.pollTimer) {
    clearInterval(f.pollTimer)
    f.pollTimer = null
  }
  if (f.mode === 'poll') {
    f.mode = 'event'
    f.running = false
    f.ready = false
  }
}
