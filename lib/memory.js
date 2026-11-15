/* 员工的长期记忆：事实卡，而不是流水账
 *
 * 0.8.0 及以前每个员工目录里只有一个 `记忆.md`，每次干完活往里追加一行
 * 「- 11-14 09:20 抖音组·陈默：……」。跑到两百轮以后，注入给模型的永远是
 * 最后 1400 个字，前面的全被挤掉；同一个事实重复记二十遍；而且「谁、什么、
 * 什么时候」混在一句话里，没法按主题挑。
 *
 * 这里换成事实卡：
 *   - 一条事实 = { id, topic, text, at, source, hits }
 *   - 存在员工目录的 记忆.json（version 1）
 *   - 注入时按「当前任务的关键词」挑相关的，而不是永远拿最后几条
 *   - 抽取在后台做（不占任务时间），失败的抽取不影响任务
 *   - 老的 记忆.md 在第一次读时一次性导入，之后只读不写
 *
 * 上限：120 条，超了先丢「最久没被召回、且最老」的。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const MAX_FACTS = 120
const RECALL_MAX = 12
const RECALL_CHARS = 1000
const FILE = '记忆.json'
const LEGACY = '记忆.md'

function now() {
  return Date.now()
}

function pathOf(dir) {
  return join(dir, FILE)
}

function parseStore(dir) {
  try {
    const p = pathOf(dir)
    if (!existsSync(p)) return null
    const j = JSON.parse(String(readFileSync(p, 'utf8')))
    if (!j || typeof j !== 'object') return null
    const facts = Array.isArray(j.facts) ? j.facts : []
    return {
      version: 1,
      migrated: Boolean(j.migrated),
      facts: facts
        .filter((f) => f && typeof f.text === 'string' && f.text.trim())
        .map((f) => ({
          id: String(f.id || ''),
          topic: String(f.topic || ''),
          text: String(f.text).slice(0, 240),
          at: Number(f.at) || 0,
          source: String(f.source || ''),
          hits: Number(f.hits) || 0,
        })),
    }
  } catch {
    return null
  }
}

function writeStore(dir, store) {
  try {
    const keep = store.facts
      .slice()
      .sort((a, b) => (b.hits || 0) - (a.hits || 0) || (b.at || 0) - (a.at || 0))
      .slice(0, MAX_FACTS)
    writeFileSync(pathOf(dir), JSON.stringify({ version: 1, migrated: true, facts: keep }, null, 2), 'utf8')
  } catch {}
}

/** 把老的 记忆.md 里的行读成事实（只在第一次迁移时用）。 */
function importLegacy(dir) {
  const out = []
  try {
    const p = join(dir, LEGACY)
    if (!existsSync(p)) return out
    const raw = String(readFileSync(p, 'utf8'))
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim()
      if (!t.startsWith('-')) continue
      const body = t.replace(/^-\s*/, '')
      if (body.length < 6) continue
      out.push({
        id: '',
        topic: '旧记录',
        text: body.slice(0, 240),
        at: 0,
        source: 'legacy',
        hits: 0,
      })
    }
  } catch {}
  return out
}

/** 老记录导入时也要有 id，否则界面上删不掉。 */
function withIds(facts) {
  return facts.map((f) => ({ ...f, id: f.id || newId() }))
}

function storeOf(dir) {
  const s = parseStore(dir)
  if (s) {
    if (!s.migrated) {
      s.facts = s.facts.concat(withIds(importLegacy(dir)))
      s.migrated = true
      writeStore(dir, s)
    }
    return s
  }
  // 没有 json：如果有老 md 就迁一次，否则建一个空的
  const seed = { version: 1, migrated: true, facts: withIds(importLegacy(dir)) }
  if (seed.facts.length) writeStore(dir, seed)
  return seed
}

/** 中文没有空格，按 2 字滑窗切词，英文/数字按整词。 */
function tokens(text) {
  const s = String(text || '').toLowerCase()
  const out = new Set()
  for (const w of s.match(/[a-z0-9_]{2,}/g) || []) out.add(w)
  const cn = s.replace(/[^\u4e00-\u9fa5]/g, ' ')
  for (const seg of cn.split(/\s+/)) {
    for (let i = 0; i + 2 <= seg.length; i++) out.add(seg.slice(i, i + 2))
  }
  return out
}

/** 按当前任务挑记忆：命中关键词的优先，同分看新旧与召回次数。 */
export function recall(dir, query, limit = RECALL_MAX) {
  const store = storeOf(dir)
  if (!store.facts.length) return ''
  const q = tokens(query)
  const scored = store.facts.map((f) => {
    const t = tokens(`${f.topic} ${f.text}`)
    let hit = 0
    for (const k of q) if (t.has(k)) hit += 1
    const ageDays = f.at ? (now() - f.at) / 86400000 : 365
    return { f, score: hit * 10 + Math.min(f.hits, 5) + Math.max(0, 3 - ageDays / 30) }
  })
  scored.sort((a, b) => b.score - a.score || b.f.at - a.f.at)
  const picked = []
  let chars = 0
  for (const { f } of scored) {
    if (picked.length >= limit) break
    if (chars + f.text.length > RECALL_CHARS && picked.length) break
    picked.push(f)
    chars += f.text.length
  }
  if (!picked.length) return ''
  // 记一次召回，让「常用的」活下来
  const ids = new Set(picked.map((f) => f.id))
  if (ids.size) {
    for (const f of store.facts) if (ids.has(f.id)) f.hits = (f.hits || 0) + 1
    writeStore(dir, store)
  }
  return picked.map((f) => (f.topic && f.topic !== '旧记录' ? `- [${f.topic}] ${f.text}` : `- ${f.text}`)).join('\n')
}

export function allFacts(dir) {
  return storeOf(dir).facts.slice().sort((a, b) => (b.at || 0) - (a.at || 0))
}

export function dropFact(dir, id) {
  const store = storeOf(dir)
  const next = store.facts.filter((f) => f.id !== id)
  if (next.length === store.facts.length) return false
  store.facts = next
  writeStore(dir, store)
  return true
}

export function clearFacts(dir) {
  writeStore(dir, { version: 1, migrated: true, facts: [] })
}

let seq = 0
function newId() {
  seq = (seq + 1) % 1000
  return `f_${now().toString(36)}${seq.toString(36)}`
}

/** 去重：同一 topic 下文字高度相似的新事实替换旧的。 */
function near(a, b) {
  const x = String(a || '').replace(/[\s，。、；：""''（）()]/g, '')
  const y = String(b || '').replace(/[\s，。、；：""''（）()]/g, '')
  if (!x || !y) return false
  if (x === y) return true
  const short = x.length < y.length ? x : y
  const long = x.length < y.length ? y : x
  return short.length >= 8 && long.includes(short)
}

export function remember(dir, facts, source = '') {
  const list = (Array.isArray(facts) ? facts : []).filter((f) => f && String(f.text || '').trim())
  if (!list.length) return 0
  const store = storeOf(dir)
  let added = 0
  for (const f of list) {
    const text = String(f.text).replace(/\s+/g, ' ').trim().slice(0, 240)
    if (text.length < 4) continue
    const topic = String(f.topic || '').replace(/\s+/g, ' ').trim().slice(0, 12) || '工作'
    if (store.facts.some((x) => near(x.text, text))) continue
    store.facts.push({ id: newId(), topic, text, at: now(), source: String(source || ''), hits: 0 })
    added += 1
  }
  if (added) writeStore(dir, store)
  return added
}

/** 从一次工作结果里抽事实用的提示词（模型只需要回一小段 JSON）。 */
export function extractPrompt({ label, taskText, answer }) {
  return [
    '下面是一次工作记录。请抽出值得这个岗位长期记住的事实，最多 3 条。',
    '每条 10–40 字，写清「做了什么 / 发现了什么 / 老板要求了什么」，不要写过程、不要写计划和客套话。',
    'topic 用 2–4 个字概括类别，例如 文件位置 / 老板偏好 / 数据口径 / 踩过的坑。',
    '只输出 JSON：{"facts":[{"topic":"…","text":"…"}]}。没有值得记的就输出 {"facts":[]}。',
    '',
    `岗位：${String(label || '员工').slice(0, 30)}`,
    `这次的要求：${String(taskText || '').replace(/\s+/g, ' ').slice(0, 600)}`,
    `这次的结果：${String(answer || '').replace(/\s+/g, ' ').slice(0, 1200)}`,
  ].join('\n')
}

/** 从模型输出里抠出 facts（容忍 fenced 与前后废话）。 */
export function parseFacts(text) {
  const raw = String(text || '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  try {
    const j = JSON.parse(raw.slice(start, end + 1))
    const arr = Array.isArray(j?.facts) ? j.facts : []
    return arr
      .map((f) => ({ topic: String(f?.topic || '').slice(0, 12), text: String(f?.text || '').slice(0, 240) }))
      .filter((f) => f.text.length >= 4)
      .slice(0, 3)
  } catch {
    return []
  }
}
