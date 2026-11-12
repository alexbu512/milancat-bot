import { readFileSync, existsSync, mkdirSync, renameSync, cpSync } from 'node:fs'
import { join } from 'node:path'

export const name = '@local/dsh-bot'

export const inject = ['webServer']

const PREFIX = '/milancat/api'
const STATE_DIR = '.milancat'
const LEGACY_DIR = '.dsh-bot'

const PROFILE_MARK = /[\\/]\.dsh[\\/]profiles[\\/]/i

/** Resolve the writable state root: plugin-owned dir inside the active workspace. */
function stateRoot(ctx) {
  let cwd = ''
  try {
    const list = ctx.get('sessions')?.list?.() || []
    const scored = list
      .map((s) => {
        const h = s?.header || {}
        const meta = h.meta || {}
        const c = (typeof h.cwd === 'string' && h.cwd) || (typeof meta.cwd === 'string' && meta.cwd) || ''
        return { c, score: (meta.parentSession ? 0 : 1e6) + Number(meta.createdAt || 0) / 1e6 }
      })
      .filter((x) => {
        try {
          return x.c && existsSync(x.c) && !PROFILE_MARK.test(x.c)
        } catch {
          return false
        }
      })
      .sort((a, b) => b.score - a.score)
    cwd = scored[0]?.c || ''
  } catch {}
  if (!cwd) {
    try {
      const wd = ctx.get('workingDirectory')
      const agent = ctx.get('agents')?.roots?.()?.[0]
      if (wd && agent) cwd = wd.get?.(agent) ?? ''
    } catch {}
  }
  if (!cwd || PROFILE_MARK.test(cwd)) cwd = process.cwd()

  const root = join(cwd, STATE_DIR)
  const legacy = join(cwd, LEGACY_DIR)
  // One-time migration from the pre-release directory name.
  if (!existsSync(root) && existsSync(legacy)) {
    try {
      cpSync(legacy, root, { recursive: true })
    } catch {
      try {
        renameSync(legacy, root)
      } catch {}
    }
  }
  if (!existsSync(root)) mkdirSync(root, { recursive: true })
  return root
}

function loadEngine(ctx) {
  // Cache-busted dynamic import: keeps the shipping surface (this file) stable
  // while the engine stays editable without a host restart.
  const here = new URL('.', import.meta.url).href
  return import(`${here}lib/engine.js?v=${Date.now()}`).then((m) => m.engine)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      // Room for a picture or a document dropping into the chat: the browser sends it
      // as base64 JSON, which inflates the bytes by a third.
      if (size > 20 * 1024 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function send(res, status, payload) {
  const text = JSON.stringify(payload ?? null)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

export function apply(ctx, config = {}) {
  const disposers = []

  const SHARED = (globalThis.__MILANCAT_BOT_SHARED__ ||= {})
  SHARED.frames = Array.isArray(SHARED.frames) ? SHARED.frames : []
  SHARED.status = SHARED.status instanceof Map ? SHARED.status : new Map()

  function noteFrame(agent, frame) {
    try {
      const id = String(agent?.id || '')
      if (!id) return
      let preview = ''
      try {
        const s = JSON.stringify(frame)
        preview = s && s.length > 400 ? s.slice(0, 400) + '…' : s || ''
      } catch {
        preview = '<unserializable>'
      }
      const ring = SHARED.frames
      ring.push({ t: Date.now(), id, type: String(frame?.type || frame?.kind || '?'), preview })
      if (ring.length > 1200) ring.splice(0, ring.length - 1200)
    } catch {}
  }

  ctx.on('agent/assistant-stream', (payload) => noteFrame(payload?.agent, payload?.frame))
  ctx.on('agent/status', (payload) => {
    try {
      const id = String(payload?.agent?.id || '')
      if (id) SHARED.status.set(id, payload?.status)
    } catch {}
  })
  ctx.on('agent/error', (payload) => {
    try {
      const id = String(payload?.agent?.id || '')
      const ring = (SHARED.errors ||= [])
      ring.push({ t: Date.now(), id, message: String(payload?.error?.message || payload?.error || '') })
      if (ring.length > 100) ring.splice(0, ring.length - 100)
    } catch {}
  })

  // Two prefixes on purpose: /milancat/api is the current name, /bot/api is the
  // legacy one that already-open panels still call. Both reach the same engine,
  // so the panel keeps working before and after an app restart.
  for (const prefix of [PREFIX, '/bot/api']) {
    disposers.push(
      ctx.webServer.register({
        kind: 'prefix',
        path: prefix,
        handler: async (req, res) => {
          const url = new URL(req.url || '/', 'http://localhost')
          const route = url.pathname.slice(prefix.length) || '/'
        let body = null
        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
          try {
            const raw = await readBody(req)
            body = raw ? JSON.parse(raw) : {}
          } catch (err) {
            send(res, 400, { error: 'bad-json', detail: String(err && err.message) })
            return
          }
        }
        try {
          const engine = await loadEngine(ctx)
          const result = await engine.handle({
            ctx,
            route,
            method: req.method || 'GET',
            query: Object.fromEntries(url.searchParams),
            body,
            root: stateRoot(ctx),
          })
          if (result && result.__file) {
            try {
              const buf = readFileSync(result.__file)
              res.writeHead(200, {
                'content-type': result.__contentType || 'application/octet-stream',
                'content-length': buf.length,
                'cache-control': 'public, max-age=3600',
              })
              res.end(buf)
            } catch {
              send(res, 404, { error: 'file-not-found' })
            }
            return
          }
          send(res, result?.status ?? 200, result?.body ?? result ?? null)
        } catch (err) {
          send(res, 500, {
            error: 'engine-failed',
            detail: err && err.stack ? String(err.stack).split('\n').slice(0, 6).join('\n') : String(err),
          })
        }
        },
      }),
    )
  }

  return () => {
    for (const d of disposers) {
      try {
        d?.()
      } catch {}
    }
  }
}
