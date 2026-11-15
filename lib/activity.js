/**
 * Activity：每个员工做过的事，一条一条落到磁盘上。
 *
 * 为什么单独一个模块：agent 的「信任」来自事后可查，而不是来自对话里说得多漂亮。
 * 每一条都写 JSONL，按天切文件，超过保留期自动删；面板只是读回来给人看。
 *
 * 一行长这样：
 *   {"t":1763000000123,"d":"2026-11-14","member":"小红书组·温乐","memberId":"emp_x",
 *    "dept":"小红书组","taskId":"task_x","tool":"write","detail":"a1.txt","ok":true,
 *    "ms":812,"err":"","kind":"tool"}
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

const KEEP_DAYS = 14
const MAX_BYTES = 6 * 1024 * 1024

function dayOf(t) {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function blobOf(text, n = 160) {
  const s = String(text || '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return s.length > n ? s.slice(0, n) + '…' : s
}

/** 把工具入参压成一句人话：路径、命令、搜索词优先，别的截断。 */
export function describeArgs(name, raw) {
  let args = raw
  if (typeof raw === 'string') {
    try {
      args = JSON.parse(raw)
    } catch {
      return blobOf(raw, 120)
    }
  }
  if (!args || typeof args !== 'object') return ''
  const pick = [
    'path',
    'file_path',
    'filePath',
    'target',
    'command',
    'cmd',
    'script',
    'pattern',
    'query',
    'url',
    'name',
    'text',
    'prompt',
  ]
  for (const k of pick) {
    const v = args[k]
    if (typeof v === 'string' && v.trim()) return blobOf(v, 140)
  }
  const keys = Object.keys(args)
  if (!keys.length) return ''
  return blobOf(JSON.stringify(args), 120)
}

export function activityDir(root) {
  return join(root, 'activity')
}

function ensureDir(root) {
  const dir = activityDir(root)
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  } catch {}
  return dir
}

/** 只做一次：把超过保留期（和体积太大）的旧文件删掉。 */
let pruned = false
export function pruneOld(root) {
  if (pruned) return
  pruned = true
  try {
    const dir = ensureDir(root)
    const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000
    for (const f of readdirSync(dir)) {
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue
      const p = join(dir, f)
      const day = Date.parse(f.slice(0, 10) + 'T00:00:00')
      const big = statSync(p).size > MAX_BYTES
      if ((Number.isFinite(day) && day < cutoff) || big) rmSync(p, { force: true })
    }
  } catch {}
}

/** 追加一行。失败就静默——记日志本身绝不该让员工的工作挂掉。 */
export function record(root, row) {
  if (!root) return null
  const t = Number(row.t) || Date.now()
  const entry = {
    t,
    d: dayOf(t),
    kind: row.kind || 'tool',
    member: row.member || '',
    memberId: row.memberId || '',
    dept: row.dept || '',
    taskId: row.taskId || '',
    tool: row.tool || '',
    detail: blobOf(row.detail, 220),
    ok: row.ok === undefined ? null : Boolean(row.ok),
    ms: row.ms === undefined ? null : Number(row.ms),
    err: row.err ? blobOf(row.err, 200) : '',
  }
  try {
    const dir = ensureDir(root)
    pruneOld(root)
    appendFileSync(join(dir, entry.d + '.jsonl'), JSON.stringify(entry) + '\n')
  } catch {}
  const ring = SHARED_RING()
  ring.push(entry)
  if (ring.length > 600) ring.splice(0, ring.length - 600)
  return entry
}

function SHARED_RING() {
  const g = globalThis
  if (!g.__MILANCAT_ACTIVITY__ || !Array.isArray(g.__MILANCAT_ACTIVITY__.ring)) {
    g.__MILANCAT_ACTIVITY__ = { ring: [] }
  }
  return g.__MILANCAT_ACTIVITY__.ring
}

function readDay(root, day, limit) {
  const p = join(activityDir(root), day + '.jsonl')
  if (!existsSync(p)) return []
  let text = ''
  try {
    const size = statSync(p).size
    text = readFileSync(p, 'utf8')
    // 文件太大时只取末尾一段，避免把几天的日志读进内存
    if (size > 2 * 1024 * 1024) text = text.slice(-2 * 1024 * 1024)
  } catch {
    return []
  }
  const rows = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const o = JSON.parse(line)
      if (o && typeof o.t === 'number') rows.push(o)
    } catch {}
  }
  return rows.slice(-limit)
}

/** 读最近的活动：默认今天 + 昨天的尾巴，按时间倒序。 */
export function recent(root, { limit = 200, days = 2, member = '', ok = '' } = {}) {
  const n = Math.max(1, Math.min(1000, Number(limit) || 200))
  const rows = []
  const ring = SHARED_RING()
  if (ring.length) rows.push(...ring)
  if (root) {
    for (let i = 0; i < Math.max(1, Math.min(7, Number(days) || 2)); i++) {
      const day = dayOf(Date.now() - i * 24 * 3600 * 1000)
      rows.push(...readDay(root, day, n))
    }
  }
  const seen = new Set()
  let out = []
  for (const r of rows) {
    const key = `${r.t}:${r.tool}:${r.detail}:${r.member}`
    if (seen.has(key)) continue
    seen.add(key)
    if (member && !String(r.member || '').includes(member)) continue
    if (ok === 'true' && r.ok !== true) continue
    if (ok === 'false' && r.ok !== false) continue
    out.push(r)
  }
  out.sort((a, b) => b.t - a.t)
  out = out.slice(0, n)
  return out
}

/** 今天做了多少事：给面板顶部一行字用。 */
export function summary(root, rows) {
  const since = new Date()
  since.setHours(0, 0, 0, 0)
  const today = rows.filter((r) => r.t >= since.getTime())
  const byTool = {}
  let failed = 0
  const people = new Set()
  for (const r of today) {
    if (r.tool) byTool[r.tool] = (byTool[r.tool] || 0) + 1
    if (r.ok === false) failed++
    if (r.member) people.add(r.member)
  }
  const top = Object.entries(byTool)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, v]) => ({ tool: k, n: v }))
  return { total: today.length, failed, people: people.size, top, keepDays: KEEP_DAYS }
}
