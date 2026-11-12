window.__ModuleLoader__.load({
  id: '@local/dsh-bot',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useMemo } = React

    let API = '/milancat/api'
    let CTX = null

    /* ------------------------------------------------------------- helpers */

    function attempt(base, path, method, body) {
      return fetch(base + path, {
        method: method || 'GET',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
    }

    async function api(path, method, body) {
      let res = await attempt(API, path, method, body)
      // The host only serves the new prefix after a restart; fall back once to the
      // legacy path so an already-open panel keeps working across the rename.
      if (res.status === 404 && API !== '/bot/api') {
        API = '/bot/api'
        res = await attempt(API, path, method, body)
      }
      const raw = await res.text()
      let data = null
      try {
        data = raw ? JSON.parse(raw) : null
      } catch {
        data = { text: raw }
      }
      if (!res.ok) throw new Error(String((data && (data.error || data.message)) || 'HTTP ' + res.status))
      return data
    }

    const TONES = ['#4C8DFF', '#F2913D', '#4FB286', '#B06AB3', '#E06666', '#3AA6B9', '#8A7BE0', '#C99A3B']
    function tone(name) {
      const s = String(name || '?')
      let sum = 0
      for (let i = 0; i < s.length; i++) sum = (sum * 31 + s.charCodeAt(i)) % 9973
      return TONES[sum % TONES.length]
    }
    function initials(name) {
      const s = String(name || '?').trim()
      return s ? s.slice(0, 1) : '?'
    }
    function clock(ts) {
      if (!ts) return ''
      const d = new Date(ts)
      const p = (n) => String(n).padStart(2, '0')
      return p(d.getHours()) + ':' + p(d.getMinutes())
    }
    function ago(ts) {
      if (!ts) return ''
      const diff = Date.now() - ts
      if (diff < 60000) return '刚刚'
      if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前'
      if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前'
      return Math.floor(diff / 86400000) + ' 天前'
    }
    const STATUS_TEXT = { queued: '排队中', running: '进行中', done: '已完成', failed: '失败' }
    const STATUS_DOT = { queued: 'wait', running: 'run', done: '', failed: 'fail' }

    /* ---------------------------------------------------------------- store */

    function useStore() {
      const [snap, setSnap] = useState({ state: null, runtime: null, typing: '', err: '' })
      const load = useCallback(async () => {
        try {
          const r = await api('/state')
          setSnap({ state: r.state, runtime: r.runtime, typing: r.typing || '', err: '' })
          return r
        } catch (e) {
          setSnap((prev) => ({ state: prev.state, runtime: prev.runtime, typing: prev.typing, err: String((e && e.message) || e) }))
          return null
        }
      }, [])
      useEffect(() => {
        // 2.2s while idle is plenty; while the assistant is thinking we poll fast,
        // so the answer lands as soon as it exists instead of up to 2s late.
        let alive = true
        let timer = null
        const tick = async () => {
          if (!alive) return
          const r = await load()
          if (!alive) return
          const busy = Boolean(r && r.state && r.state.assistant && r.state.assistant.busy)
          timer = setTimeout(tick, busy ? 400 : 2200)
        }
        tick()
        return () => {
          alive = false
          clearTimeout(timer)
        }
      }, [load])
      return [snap, load]
    }

    /* ----------------------------------------------------------------- atoms */

    // Avatars arrive as base64 JSON (see the note in lib/engine.js), so they are
    // turned into data: URLs once per file name and reused from this cache.
    const AV_CACHE = new Map()

    function useAvatar(file) {
      const key = String(file || '')
      const [src, setSrc] = useState(key ? AV_CACHE.get(key) || '' : '')
      useEffect(() => {
        let alive = true
        if (!key) {
          setSrc('')
          return undefined
        }
        const hit = AV_CACHE.get(key)
        if (hit) {
          setSrc(hit)
          return undefined
        }
        api('/avatar/' + encodeURIComponent(key))
          .then((res) => {
            if (!alive || !res || !res.data) return
            const url = 'data:' + (res.type || 'image/png') + ';base64,' + res.data
            AV_CACHE.set(key, url)
            setSrc(url)
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [key])
      return src
    }

    function Av(props) {
      const size = props.size || 36
      const src = useAvatar(props.avatar)
      return h(
        'span',
        {
          className: 'dbot-avatar',
          style: {
            width: size,
            height: size,
            flexBasis: size,
            background: src ? '#D8D8D8' : tone(props.name),
            fontSize: Math.max(11, Math.round(size * 0.4)),
          },
          title: props.title || props.name || '',
        },
        src ? h('img', { className: 'dbot-avatar-img', src, alt: '', draggable: false }) : initials(props.name),
      )
    }

    /** Avatar with click-to-upload, exactly like clicking a WeChat avatar. */
    function AvaUp(props) {
      const size = props.size || 36
      const ref = useRef(null)
      const [busy, setBusy] = useState(false)
      const [bump, setBump] = useState(0)
      const onFile = (ev) => {
        const file = ev.target.files && ev.target.files[0]
        ev.target.value = ''
        if (!file) return
        if (file.size > 3 * 1024 * 1024) {
          window.alert('图片太大了，微信头像也没这么大：请压缩到 3MB 以内')
          return
        }
        setBusy(true)
        const fr = new FileReader()
        fr.onload = async () => {
          try {
            const res = await api('/avatar', 'POST', {
              kind: props.kind,
              id: props.id || '',
              dataUrl: String(fr.result || ''),
            })
            // The file name is stable per entity, so refresh the cached picture
            // and force the avatar to remount with it.
            const name = res && res.avatar
            if (name && fr.result) {
              AV_CACHE.set(String(name), String(fr.result))
              setBump((n) => n + 1)
            }
            if (props.onDone) props.onDone()
          } catch (e) {
            window.alert('上传失败：' + ((e && e.message) || e))
          } finally {
            setBusy(false)
          }
        }
        fr.readAsDataURL(file)
      }
      return h(
        'span',
        { className: 'dbot-avup', onClick: () => ref.current && ref.current.click(), title: '点击更换头像' },
        h(Av, { key: String(bump), size, name: props.name, avatar: props.avatar }),
        h('input', {
          type: 'file',
          accept: 'image/png,image/jpeg,image/webp,image/gif',
          ref,
          style: { display: 'none' },
          onChange: onFile,
        }),
      )
    }

    /* Icons are inline SVG symbols, never emoji glyphs. The sprite is rendered once
       by BotPanel; every icon is a <use> that inherits currentColor. */
    const SPRITE_HTML = [
      '<symbol id="bot" viewBox="0 0 24 24"><path d="M5 6.5 8.3 9h7.4L19 6.5v10a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3z"/><path d="M9 12.5v1m6-1v1m-5 3h4"/></symbol>',
      '<symbol id="chat" viewBox="0 0 24 24"><path d="M5 4.5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3v-15a2 2 0 0 1 2-2Z"/><path d="M8 9h8m-8 4h5"/></symbol>',
      '<symbol id="org" viewBox="0 0 24 24"><rect x="8" y="3" width="8" height="5" rx="1.5"/><path d="M12 8v5M5 13h14M5 13v3m14-3v3"/><rect x="2" y="16" width="6" height="5" rx="1.2"/><rect x="16" y="16" width="6" height="5" rx="1.2"/></symbol>',
      '<symbol id="group" viewBox="0 0 24 24"><path d="M14 7a3.3 3.3 0 1 1-6.6 0 3.3 3.3 0 0 1 6.6 0Zm3-2a3 3 0 0 1 0 6M3 21v-3a5 5 0 0 1 5-5h5a5 5 0 0 1 5 5v3m1-8a4 4 0 0 1 3 4v3"/></symbol>',
      '<symbol id="task" viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="m8 10 1.5 1.5L12 9m2 2h2m-8 5h8"/></symbol>',
      '<symbol id="clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/></symbol>',
      '<symbol id="plane" viewBox="0 0 24 24"><path d="m3 10 18-7-7 18-3-8-8-3Zm8 3 10-10"/></symbol>',
      '<symbol id="sliders" viewBox="0 0 24 24"><path d="M4 7h7m5 0h4M4 17h3m5 0h8"/><circle cx="13.5" cy="7" r="2.5"/><circle cx="9.5" cy="17" r="2.5"/></symbol>',
      '<symbol id="plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>',
      '<symbol id="up" viewBox="0 0 24 24"><path d="M12 19V5m-5 5 5-5 5 5"/></symbol>',
      '<symbol id="arrow" viewBox="0 0 24 24"><path d="m9 5 7 7-7 7"/></symbol>',
      '<symbol id="copy" viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v13h5"/></symbol>',
      '<symbol id="check" viewBox="0 0 24 24"><path d="m5 12 5 5L20 6"/></symbol>',
      '<symbol id="x" viewBox="0 0 24 24"><path d="m6 6 12 12M6 18 18 6"/></symbol>',
      '<symbol id="search" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></symbol>',
      '<symbol id="shield" viewBox="0 0 24 24"><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/></symbol>',
    ].join('')

    function Icon(props) {
      const size = props.size || 18
      return h(
        'svg',
        {
          className: 'dbot-icon' + (props.cls ? ' ' + props.cls : ''),
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('use', { href: '#' + props.name }),
      )
    }

    function Sprite() {
      return h('svg', {
        className: 'dbot-sprite',
        'aria-hidden': 'true',
        focusable: 'false',
        dangerouslySetInnerHTML: { __html: '<defs>' + SPRITE_HTML + '</defs>' },
      })
    }

    function Field(props) {
      return h(
        'label',
        { className: 'dbot-field' },
        h('span', { className: 'dbot-field-k' }, props.label),
        props.multiline
          ? h('textarea', {
              className: 'dbot-in',
              rows: props.rows || 3,
              placeholder: props.placeholder || '',
              value: props.value,
              onChange: (e) => props.onChange(e.target.value),
            })
          : h('input', {
              className: 'dbot-in',
              placeholder: props.placeholder || '',
              value: props.value,
              onChange: (e) => props.onChange(e.target.value),
            }),
        props.hint ? h('span', { className: 'dbot-field-h' }, props.hint) : null,
      )
    }

    /* Process traces: off unless the boss turns them on. Ordinary users want the
       answer, not the transcript of how it was produced. A module-level flag is
       enough because BotPanel re-renders the whole tree when it flips. */
    let UI_SHOW_TRACE = false

    function Trace(props) {
      const lines = props.lines || []
      const [open, setOpen] = useState(Boolean(props.open))
      if (!lines.length) return null
      if (!UI_SHOW_TRACE && !props.force) return null
      return h(
        'div',
        { className: 'dbot-trace' },
        h(
          'button',
          {
            className: 'dbot-trace-toggle',
            'aria-expanded': open ? 'true' : 'false',
            onClick: () => setOpen(!open),
          },
          h(Icon, { name: 'arrow', size: 13, cls: open ? 'open' : '' }),
          h('span', null, '过程 · ' + lines.length + ' 步'),
        ),
        open
          ? h(
              'div',
              { className: 'dbot-trace-body' },
              lines.map((line, i) => {
                const kind = line.kind || 'text'
                if (kind === 'tool') {
                  return h(
                    'div',
                    { key: i, className: 'dbot-line tool' },
                    h('b', null, line.name || 'tool'),
                    line.args ? '  ' + line.args : '',
                  )
                }
                if (kind === 'result') return h('div', { key: i, className: 'dbot-line result' }, line.text || '')
                if (kind === 'think') return h('div', { key: i, className: 'dbot-line think' }, line.text || '')
                if (kind === 'step') return h('div', { key: i, className: 'dbot-line result' }, '— ' + (line.text || 'step'))
                return h('div', { key: i, className: 'dbot-line text' }, line.text || '')
              }),
            )
          : null,
      )
    }

    const ATT_CACHE = {}

    function AttImg(props) {
      const id = props.file.id
      const [src, setSrc] = useState(ATT_CACHE[id] || '')
      useEffect(() => {
        let alive = true
        if (ATT_CACHE[id]) {
          setSrc(ATT_CACHE[id])
          return
        }
        api('/files/' + encodeURIComponent(id))
          .then((r) => {
            if (!alive || !r || !r.file || !r.file.data) return
            const url = 'data:' + (r.file.type || 'image/png') + ';base64,' + r.file.data
            ATT_CACHE[id] = url
            setSrc(url)
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [id])
      if (!src) {
        return h('div', { className: 'dbot-img wait' }, props.file.name)
      }
      return h(
        'a',
        { className: 'dbot-img', href: src, target: '_blank', rel: 'noreferrer', title: props.file.name },
        h('img', { src, alt: props.file.name }),
      )
    }

    // Attachments render next to the words, like a chat app: a picture shows itself,
    // anything else is a chip with its name and size.
    function AttList(props) {
      const files = props.files || []
      if (!files.length) return null
      return h(
        'div',
        { className: 'dbot-atts-out' },
        files.map((f) =>
          f.kind === 'image'
            ? h(AttImg, { key: f.id, file: f })
            : h(
                'span',
                { key: f.id, className: 'dbot-att', title: f.name },
                h('span', { className: 'dbot-att-n' }, '📄 ' + f.name + (f.size ? ' · ' + Math.max(1, Math.round(f.size / 1024)) + 'KB' : '')),
              ),
        ),
      )
    }

    function Bubble(props) {
      const msg = props.msg
      const mine = msg.role === 'user'
      const who = mine ? '' : msg.author || props.author || '助理'
      if (mine) {
        return h(
          'div',
          { className: 'dbot-row me' },
          h(
            'div',
            { className: 'dbot-usercol' },
            h('div', { className: 'dbot-user' }, msg.text || ''),
            h(AttList, { files: msg.files }),
            msg.from === 'feishu' ? h('div', { className: 'dbot-from' }, '来自飞书 · 手机') : null,
          ),
        )
      }
      return h(
        'div',
        { className: 'dbot-row' },
        h(Av, { name: who, size: 27 }),
        h(
          'div',
          { className: 'dbot-reply' },
          h(
            'div',
            { className: 'dbot-name' },
            h('span', null, who),
            msg.at ? h('span', { className: 'dbot-time' }, clock(msg.at)) : null,
          ),
          h('div', { className: 'dbot-answer' }, msg.text || ''),
          h(AttList, { files: msg.files }),
          msg.from === 'feishu' ? h('div', { className: 'dbot-from' }, '来自飞书 · 手机') : null,
          h(Trace, { lines: msg.trace, open: false }),
        ),
      )
    }

    function LiveCard(props) {
      const act = props.act || {}
      // While a step trace is hidden, show that work is happening, not what it is.
      const lines = UI_SHOW_TRACE ? (act.lines || []).slice(-6) : []
      return h(
        'div',
        { className: 'dbot-live' },
        h(Av, { name: props.name || act.label || '?', size: 34 }),
        h(
          'div',
          { className: 'dbot-live-body' },
          h(
            'div',
            { className: 'dbot-live-head' },
            h('span', { className: 'dbot-pulse' }),
            h('span', null, (act.label || props.name || '员工') + ' 正在处理…'),
          ),
          lines.length
            ? lines.map((l, i) =>
                h(
                  'div',
                  { key: i, className: 'dbot-line ' + (l.kind || 'text') },
                  l.kind === 'tool' ? (l.name || '') + (l.args ? '  ' + l.args : '') : l.text || '',
                ),
              )
            : UI_SHOW_TRACE
              ? h('div', { className: 'dbot-line result' }, '正在思考…')
              : null,
        ),
      )
    }

    function Composer(props) {
      const [text, setText] = useState('')
      const [busy, setBusy] = useState(false)
      const [atts, setAtts] = useState([])
      const [uploading, setUploading] = useState(false)
      const [err, setErr] = useState('')
      const fileRef = useRef(null)
      const canSend = (text.trim().length > 0 || atts.length > 0) && !busy && !props.disabled && !uploading

      // Each picked file is uploaded immediately and replaced by its id, so sending is
      // just a reference write — the browser never has to hold the bytes in the message.
      async function take(list) {
        const picked = Array.from(list || []).slice(0, 6)
        if (!picked.length) return
        setErr('')
        setUploading(true)
        try {
          const done = []
          for (const f of picked) {
            const data = await readAsDataUrl(f)
            const r = await api('/upload', 'POST', { name: f.name || 'file', data })
            if (r && r.file) done.push(r.file)
            else setErr((r && (r.error || r.message)) || '这个文件没传上去')
          }
          if (done.length) setAtts((prev) => prev.concat(done).slice(0, 6))
        } catch (e) {
          setErr('这个文件没传上去')
        } finally {
          setUploading(false)
        }
      }

      async function send() {
        const value = text.trim()
        if ((!value && !atts.length) || busy || uploading) return
        setBusy(true)
        try {
          await props.onSend(value, atts)
          setText('')
          setAtts([])
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { className: 'dbot-composer-wrap' },
        props.hint
          ? h('div', { className: 'dbot-busy' }, h('span', { className: 'dbot-dot' }), h('span', null, props.hint))
          : null,
        h(
          'div',
          {
            className: 'dbot-composer',
            onDragOver: (e) => {
              e.preventDefault()
            },
            onDrop: (e) => {
              e.preventDefault()
              if (e.dataTransfer && e.dataTransfer.files) take(e.dataTransfer.files)
            },
          },
          atts.length || uploading || err
            ? h(
                'div',
                { className: 'dbot-atts' },
                atts.map((f) =>
                  h(
                    'span',
                    { key: f.id, className: 'dbot-att' },
                    h('span', { className: 'dbot-att-n' }, (f.kind === 'image' ? '图片 · ' : '文件 · ') + f.name),
                    h('button', { className: 'dbot-att-x', 'aria-label': '移除附件', onClick: () => setAtts((prev) => prev.filter((x) => x.id !== f.id)) }, h(Icon, { name: 'x', size: 11 })),
                  ),
                ),
                uploading ? h('span', { className: 'dbot-att' }, h('span', { className: 'dbot-att-n' }, '正在上传…')) : null,
                err ? h('span', { className: 'dbot-att err' }, err) : null,
              )
            : null,
          h('textarea', {
            className: 'dbot-input',
            value: text,
            rows: 2,
            'aria-label': props.ariaLabel || '给助理发消息',
            placeholder: props.placeholder || '告诉助理，你想做什么…',
            onChange: (e) => setText(e.target.value),
            onPaste: (e) => {
              const items = (e.clipboardData && e.clipboardData.files) || []
              if (items.length) {
                e.preventDefault()
                take(items)
              }
            },
            onKeyDown: (e) => {
              const composing = (e.nativeEvent && e.nativeEvent.isComposing) || e.isComposing || e.keyCode === 229
              if (e.key === 'Enter' && !e.shiftKey && !composing) {
                e.preventDefault()
                send()
              }
            },
          }),
          h(
            'div',
            { className: 'dbot-composer-bar' },
            h(
              'div',
              { className: 'dbot-composer-left' },
              h(
                'button',
                {
                  className: 'dbot-attach',
                  title: '加文件或图片（也可以直接拖进来、粘贴截图）',
                  'aria-label': '添加文件或图片',
                  disabled: uploading,
                  onClick: () => fileRef.current && fileRef.current.click(),
                },
                h(Icon, { name: 'plus', size: 15 }),
                h('span', null, '添加附件'),
              ),
              h('input', {
                ref: fileRef,
                type: 'file',
                multiple: true,
                style: { display: 'none' },
                onChange: (e) => {
                  take(e.target.files)
                  e.target.value = ''
                },
              }),
            ),
            h(
              'div',
              { className: 'dbot-composer-right' },
              h('span', { className: 'dbot-kbd' }, 'Enter 发送 · Shift + Enter 换行'),
              h(
                'button',
                { className: 'dbot-send', disabled: !canSend, onClick: send },
                h(Icon, { name: 'up', size: 14 }),
                h('span', null, busy ? '发送中…' : props.interject ? '插一句' : '发送'),
              ),
            ),
          ),
        ),
        h('p', { className: 'dbot-note' }, props.note || '可以直接说目标，也可以随时补充一句。'),
      )
    }

    function readAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const fr = new FileReader()
        fr.onload = () => resolve(String(fr.result || ''))
        fr.onerror = () => reject(fr.error)
        fr.readAsDataURL(file)
      })
    }

    /* ------------------------------------------------------------- rail */

    const TABS = [
      { id: 'assistant', label: '助理', icon: 'M4 6h16v11H9l-5 4V6Z' },
      { id: 'org', label: '组织', icon: 'M4 20V10h5v10M15 20V4h5v16M3 20h18' },
      { id: 'groups', label: '群', icon: 'M4 5h16v10H9l-5 4V5Z' },
      { id: 'tasks', label: '任务', icon: 'M5 4h14v16H5zM8 9h8M8 13h8M8 17h5' },
      { id: 'sched', label: '定时', icon: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z' },
      { id: 'feishu', label: '飞书', icon: 'M21.5 3.2 2.8 10.6l6.9 2.6 2.6 7.1 9.2-17.1Z' },
    ]

    const TAB_ICONS = { assistant: 'chat', org: 'org', groups: 'group', tasks: 'task', sched: 'clock', feishu: 'plane' }

    function Rail(props) {
      return h(
        'nav',
        { className: 'dbot-rail', 'aria-label': '模块导航' },
        h('div', { className: 'dbot-brand', title: 'milancat bot' }, h(Icon, { name: 'bot', size: 20 })),
        TABS.map((t) =>
          h(
            'button',
            {
              key: t.id,
              className: 'dbot-navitem' + (props.tab === t.id ? ' is-on' : ''),
              onClick: () => props.onTab(t.id),
              title: t.label,
              'aria-label': t.label,
              'aria-current': props.tab === t.id ? 'page' : undefined,
            },
            h(Icon, { name: TAB_ICONS[t.id] || 'chat', size: 20 }),
            h('span', { className: 'dbot-navlabel' }, t.label),
          ),
        ),
        h(
          'div',
          { className: 'dbot-railbottom' },
          props.counts && props.counts.running
            ? h('div', { className: 'dbot-railpill', title: '进行中' }, String(props.counts.running))
            : null,
          h('div', { className: 'dbot-monogram', title: 'milancat' }, 'M'),
        ),
      )
    }

    /* --------------------------------------------------------- list panes */

    function Item(props) {
      return h(
        'div',
        { className: 'dbot-item' + (props.active ? ' is-on' : ''), onClick: props.onClick },
        props.avatar,
        h(
          'div',
          { className: 'dbot-item-main' },
          h(
            'div',
            { className: 'dbot-item-title' },
            props.dot ? h('span', { className: 'dbot-dot ' + props.dot }) : null,
            h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, props.title),
          ),
          props.sub ? h('div', { className: 'dbot-item-sub' }, props.sub) : null,
        ),
      )
    }

    function AssistantList(props) {
      return h(
        'div',
        { className: 'dbot-listbody' },
        h(Item, {
          active: true,
          avatar: h(Av, { name: '助理', size: 36 }),
          title: '总裁助理',
          sub: props.busy ? '正在为你工作…' : '随时待命',
          dot: props.busy ? 'run' : '',
        }),
      )
    }

    function DeptList(props) {
      const all = (props.state && props.state.org && props.state.org.departments) || []
      const emps = (props.state && props.state.org && props.state.org.employees) || []
      const q = String(props.q || '').trim()
      const depts = q
        ? all.filter((d) => (d.name || '').includes(q) || emps.some((e) => e.deptId === d.id && (e.name || '').includes(q)))
        : all
      return h(
        'div',
        { className: 'dbot-listbody' },
        depts.length
          ? depts.map((d) => {
              const staff = emps.filter((e) => e.deptId === d.id)
              return h(Item, {
                key: d.id,
                active: props.sel === d.id,
                avatar: h(Av, { name: d.name, size: 36 }),
                title: d.name,
                sub: staff.length ? staff.length + ' 人 · ' + staff.map((s) => s.name).join('、') : '还没有员工',
                onClick: () => props.onSelect(d.id),
              })
            })
          : h('div', { className: 'dbot-listempty' }, '还没有部门，让助理帮你招人'),
        h('div', { className: 'dbot-quick', onClick: props.onNew }, h('span', { className: 'dbot-quick-i' }, h(Icon, { name: 'plus', size: 13 })), h('span', null, '新建部门')),
      )
    }

    function GroupList(props) {
      const allDepts = (props.state && props.state.org && props.state.org.departments) || []
      const groups = (props.state && props.state.groups) || []
      const tasks = (props.state && props.state.tasks) || []
      const q = String(props.q || '').trim()
      const depts = q ? allDepts.filter((d) => (d.name || '').includes(q)) : allDepts
      return h(
        'div',
        { className: 'dbot-listbody' },
        depts.map((d) => {
          const g = groups.find((x) => x.deptId === d.id)
          const msgs = (g && g.messages) || []
          const last = msgs[msgs.length - 1]
          const busy = tasks.some((t) => t.deptId === d.id && (t.status === 'running' || t.status === 'queued'))
          return h(Item, {
            key: d.id,
            active: props.sel === d.id,
            avatar: h(Av, { name: d.name, size: 36 }),
            title: d.name + ' 群',
            sub: busy
              ? '正在处理…'
              : last
              ? (last.role === 'user' ? '你：' : (last.author || '') + '：') + last.text
              : '还没有消息',
            dot: busy ? 'run' : '',
            onClick: () => props.onSelect(d.id),
          })
        }),
      )
    }

    function TaskList(props) {
      const all = (props.state && props.state.tasks) || []
      const depts = (props.state && props.state.org && props.state.org.departments) || []
      const q = String(props.q || '').trim()
      const tasks = q ? all.filter((t) => ((t.title || '') + ' ' + (t.brief || '')).includes(q)) : all
      const nameOf = (id) => {
        const d = depts.find((x) => x.id === id)
        return d ? d.name : ''
      }
      return h(
        'div',
        { className: 'dbot-listbody' },
        tasks.length
          ? tasks
              .slice()
              .reverse()
              .map((t) =>
                h(Item, {
                  key: t.id,
                  active: props.sel === t.id,
                  avatar: h(Av, { name: nameOf(t.deptId) || '任务', size: 36 }),
                  title: t.title || t.brief || '(无标题)',
                  sub: (nameOf(t.deptId) || '') + ' · ' + (STATUS_TEXT[t.status] || t.status) + ' · ' + ago(t.updatedAt || t.createdAt),
                  dot: STATUS_DOT[t.status] || '',
                  onClick: () => props.onSelect(t.id),
                }),
              )
          : h('div', { className: 'dbot-listempty' }, '还没有任务，去部门群派一件事'),
      )
    }

    /* ------------------------------------------------------------ detail */

    function Head(props) {
      return h(
        'div',
        { className: 'dbot-head' },
        props.left || h(Av, { name: props.name || '助理', size: 30 }),
        h(
          'div',
          { style: { minWidth: 0 } },
          h('div', { className: 'dbot-head-title' }, props.title || ''),
          props.sub ? h('div', { className: 'dbot-head-sub' }, props.sub) : null,
        ),
        h('div', { style: { flex: 1 } }),
        props.actions || null,
      )
    }

    /** One employee card: view + inline editing of description / ability prompt. */
    function EmpCard(props) {
      const e = props.emp
      const [open, setOpen] = useState(false)
      const [saving, setSaving] = useState(false)
      const [f, setF] = useState({
        name: e.name || '',
        title: e.title || '',
        description: e.description || '',
        duties: e.duties || '',
        skills: (e.skills || []).join('，'),
        persona: e.persona || '',
        caps: capsOf(e),
      })
      const set = (k) => (v) => setF((p) => Object.assign({}, p, { [k]: v }))
      async function save() {
        setSaving(true)
        try {
          await api('/employees/' + e.id, 'PATCH', {
            name: f.name.trim(),
            title: f.title.trim(),
            description: f.description.trim(),
            duties: f.duties.trim(),
            skills: f.skills.split(/[,，、\s]+/).filter(Boolean),
            persona: f.persona,
            caps: f.caps,
          })
          setOpen(false)
          props.onChanged()
        } catch (err) {
          window.alert('保存失败：' + ((err && err.message) || err))
        } finally {
          setSaving(false)
        }
      }
      return h(
        'div',
        { className: 'dbot-card' },
        h(
          'div',
          { className: 'dbot-card-head' },
          h(AvaUp, {
            kind: 'employee',
            id: e.id,
            name: e.name,
            size: 32,
            avatar: e.avatar,
            onDone: props.onChanged,
          }),
          h(
            'div',
            { style: { minWidth: 0 } },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
              h('div', { className: 'dbot-role' }, e.name),
              props.isLead ? h('span', { className: 'dbot-chip lead' }, '负责人') : null,
            ),
            h('div', { className: 'dbot-item-sub' }, e.title),
          ),
          h('div', { style: { flex: 1 } }),
          h('button', { className: 'dbot-btn', onClick: () => setOpen(!open) }, open ? '收起' : '编辑'),
        ),
        e.description ? h('div', { className: 'dbot-desc' }, e.description) : null,
        open
          ? h(
              'div',
              { className: 'dbot-form' },
              h(Field, { label: '姓名', value: f.name, onChange: set('name') }),
              h(Field, { label: '职位', value: f.title, onChange: set('title') }),
              h(Field, {
                label: '描述',
                value: f.description,
                onChange: set('description'),
                placeholder: '一句话：这个人是谁、擅长什么',
                hint: '显示在名片上，也让助理知道他能干什么',
              }),
              h(Field, {
                label: '职责',
                value: f.duties,
                onChange: set('duties'),
                multiline: true,
                rows: 3,
                placeholder: '做什么、交付什么、标准是什么',
              }),
              h(Field, { label: '技能', value: f.skills, onChange: set('skills'), placeholder: '用逗号分隔' }),
              h(Field, {
                label: '能力（角色提示词）',
                value: f.persona,
                onChange: set('persona'),
                multiline: true,
                rows: 7,
                placeholder: '你是……\n你判断好坏的顺序是……\n你交付时总是……',
                hint: '这段文字会作为他干活时遵守的角色设定，越具体越像这个人',
              }),
              h(CapPick, { value: f.caps, onChange: set('caps') }),
              h(
                'div',
                { className: 'dbot-actions' },
                h('button', { className: 'dbot-btn primary', onClick: save, disabled: saving }, saving ? '保存中…' : '保存'),
                h('button', { className: 'dbot-btn', onClick: () => setOpen(false) }, '取消'),
                h('div', { style: { flex: 1 } }),
                h(
                  'button',
                  {
                    className: 'dbot-btn danger',
                    onClick: async () => {
                      if (!window.confirm('辞退「' + e.name + '」？')) return
                      await api('/employees/' + e.id, 'DELETE')
                      props.onChanged()
                    },
                  },
                  '辞退',
                ),
              ),
            )
          : h(
              'div',
              null,
              e.duties ? h('div', { className: 'dbot-desc' }, e.duties) : null,
              e.persona
                ? h(
                    'div',
                    { className: 'dbot-ab' },
                    h('span', { className: 'dbot-ab-k' }, '能力'),
                    h('span', { className: 'dbot-ab-v' }, e.persona.replace(/\s+/g, ' ').slice(0, 90) + (e.persona.length > 90 ? '…' : '')),
                  )
                : h('div', { className: 'dbot-ab dbot-ab-empty' }, '还没有设置能力提示词，点「编辑」补上'),
              e.skills && e.skills.length
                ? h('div', { className: 'dbot-tags' }, e.skills.map((s, i) => h('span', { key: i, className: 'dbot-tag' }, s)))
                : null,
            ),
      )
    }

    /** The assistant's own description + ability prompt. */
    const CAPS = [
      { id: 'look', label: '看图', hint: '读图片、截图里的内容' },
      { id: 'computer', label: '操作电脑', hint: '截屏、点击、按键、输入' },
      { id: 'web', label: '联网', hint: '搜索和读网页' },
      { id: 'schedule', label: '定时', hint: '定时提醒、等待' },
      { id: 'memory', label: '记忆', hint: '写入长期记忆、查历史' },
    ]
    const CAP_ALL = CAPS.map((c) => c.id)
    function capsOf(entity) {
      const v = entity && entity.caps
      return Array.isArray(v) ? v : CAP_ALL
    }

    function CapPick(props) {
      const on = props.value || []
      const toggle = (id) => {
        const has = on.indexOf(id) >= 0
        props.onChange(has ? on.filter((x) => x !== id) : on.concat([id]))
      }
      return h(
        'div',
        { className: 'dbot-caps' },
        h('div', { className: 'dbot-field-k' }, '可用能力'),
        h(
          'div',
          { className: 'dbot-caps-row' },
          CAPS.map((c) =>
            h(
              'button',
              {
                key: c.id,
                className: 'dbot-cap' + (on.indexOf(c.id) >= 0 ? ' on' : ''),
                title: c.hint,
                onClick: () => toggle(c.id),
              },
              c.label,
            ),
          ),
        ),
      )
    }

    function AssistantConfig(props) {
      const a = props.assistant || {}
      const [f, setF] = useState({ name: a.name || '总裁助理', description: a.description || '', persona: a.persona || '', caps: capsOf(a) })
      const [saving, setSaving] = useState(false)
      const boxRef = useRef(null)
      const backRef = useRef(null)
      const set = (k) => (v) => setF((p) => Object.assign({}, p, { [k]: v }))
      const showTrace = Boolean(props.ui && props.ui.showTrace)

      // A dialog drawer, not a card in the flow: Escape closes, Tab stays inside,
      // and focus returns to the button that opened it.
      useEffect(() => {
        backRef.current = document.activeElement
        const box = boxRef.current
        const firstInput = box && box.querySelector('input, textarea')
        if (firstInput && firstInput.focus) firstInput.focus()
        function onKey(e) {
          if (e.key === 'Escape') {
            e.stopPropagation()
            e.preventDefault()
            props.onClose()
            return
          }
          if (e.key !== 'Tab' || !box) return
          const all = Array.from(box.querySelectorAll('input, textarea, button, select, a[href]'))
          const items = all.filter((el) => !el.disabled && el.offsetParent !== null)
          if (!items.length) return
          const first = items[0]
          const last = items[items.length - 1]
          if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault()
            first.focus()
          } else if (e.shiftKey && document.activeElement === first) {
            e.preventDefault()
            last.focus()
          }
        }
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('keydown', onKey, true)
          const back = backRef.current
          if (back && back.focus) back.focus()
        }
      }, [])

      async function save() {
        setSaving(true)
        try {
          await api('/assistant', 'PATCH', { name: f.name, description: f.description, persona: f.persona, caps: f.caps })
          props.onClose()
          props.onChanged()
        } catch (err) {
          window.alert('保存失败：' + ((err && err.message) || err))
        } finally {
          setSaving(false)
        }
      }

      return h(
        'div',
        { className: 'dbot-modal' },
        h('div', { className: 'dbot-veil', onClick: props.onClose }),
        h(
          'aside',
          {
            className: 'dbot-drawer',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': '助理的能力设定',
            ref: boxRef,
          },
          h(
            'div',
            { className: 'dbot-drawer-head' },
            h('h2', null, '助理的能力设定'),
            h('button', { className: 'dbot-iconbtn', onClick: props.onClose, 'aria-label': '关闭能力设置' }, h(Icon, { name: 'x', size: 15 })),
          ),
          h(Field, { label: '名字', value: f.name, onChange: set('name') }),
          h(Field, { label: '描述', value: f.description, onChange: set('description'), placeholder: '一句话说明这位助理的风格' }),
          h(Field, {
            label: '角色提示词',
            value: f.persona,
            onChange: set('persona'),
            multiline: true,
            rows: 6,
            placeholder: '留空则使用默认的幕僚长设定',
            hint: '这段文字会作为助理工作时遵守的角色设定。',
          }),
          h('div', { className: 'dbot-caps-label' }, '能力'),
          h(CapPick, { value: f.caps, onChange: set('caps') }),
          h(
            'div',
            { className: 'dbot-switchrow' },
            h(
              'div',
              { className: 'dbot-switchtext' },
              h('div', null, '显示执行过程'),
              h('small', { className: 'dbot-field-h' }, '关闭时只看结果；打开后显示工具与执行记录。'),
            ),
            h(
              'button',
              {
                className: 'dbot-switch' + (showTrace ? ' on' : ''),
                role: 'switch',
                'aria-checked': showTrace ? 'true' : 'false',
                'aria-label': '显示执行过程',
                onClick: () => props.onShowTrace && props.onShowTrace(!showTrace),
              },
              h('span', { className: 'dbot-switch-dot' }),
            ),
          ),
          h(
            'div',
            { className: 'dbot-settings-foot' },
            h('button', { className: 'dbot-send', onClick: save, disabled: saving }, saving ? '保存中…' : '保存'),
            h('button', { className: 'dbot-btn', onClick: props.onClose }, '取消'),
            h('span', { className: 'dbot-foot-gap' }),
            h(
              'button',
              {
                className: 'dbot-btn danger',
                onClick: async () => {
                  const n = ((props.state && props.state.assistant && props.state.assistant.messages) || []).length
                  if (!n) return
                  if (!window.confirm('清空助理的聊天记录？组织、任务、部门群都不动，只删这一栏对话。')) return
                  try {
                    await api('/assistant/clear', 'POST', {})
                    props.onChanged && props.onChanged()
                    props.onClose && props.onClose()
                  } catch (e) {
                    window.alert('清空失败：' + ((e && e.message) || e))
                  }
                },
              },
              '清空聊天记录',
            ),
          ),
        ),
      )
    }

    function AssistantPane(props) {
      const state = props.state || {}
      const messages = (state.assistant && state.assistant.messages) || []
      const live = (state.assistant && state.assistant.live) || []
      const busy = Boolean(state.assistant && state.assistant.busy)
      // Only show the live preview while the assistant is actually answering,
      // so a stale preview from a crashed turn can never stay on screen.
      const typing = busy ? String(props.typing || '') : ''
      const runtime = props.runtime || {}
      const scrollRef = useRef(null)
      const [cfg, setCfg] = useState(false)
      const count = messages.length + live.length + (typing ? 1 : 0)
      useEffect(() => {
        const el = scrollRef.current
        if (el) el.scrollTop = el.scrollHeight
      }, [count])
      const chips = [
        { label: '搭一个小红书团队', prompt: '帮我搭一个做小红书账号的团队' },
        { label: '配齐短视频带货的人手', prompt: '我要做短视频带货，帮我配人' },
        { label: '看看这周的任务进展', prompt: '这周的任务推进得怎么样' },
      ]
      const name = (state.assistant && state.assistant.name) || '总裁助理'
      return h(
        'div',
        { className: 'dbot-main' },
        h(Head, {
          name,
          title: name,
          sub: runtime.hasParent ? (busy ? '正在为你工作…' : '在线 · 随时待命') : '没有可用的会话，请先打开一个对话',
          left: h(AvaUp, {
            kind: 'assistant',
            id: 'me',
            name: '助理',
            size: 32,
            avatar: state.assistant && state.assistant.avatar,
            onDone: props.onChanged,
          }),
          actions: h(
            'div',
            { className: 'dbot-headacts' },
            h(
              'span',
              { className: 'dbot-connection' },
              h(Icon, { name: 'shield', size: 13 }),
              h('span', null, 'milancat bot'),
            ),
            h(
              'button',
              { className: 'dbot-btn', onClick: () => setCfg(true), 'aria-haspopup': 'dialog' },
              h(Icon, { name: 'sliders', size: 15 }),
              h('span', null, '能力设置'),
            ),
          ),
        }),
        h(
          'div',
          { className: 'dbot-scroll', ref: scrollRef },
          messages.length
            ? messages.map((m) => (m.role === 'system' ? h('div', { key: m.id, className: 'dbot-sys' }, m.text) : h(Bubble, { key: m.id, msg: m })))
            : h(
                'div',
                { className: 'dbot-empty' },
                h('div', { className: 'dbot-mark' }, h(Icon, { name: 'bot', size: 24 })),
                h('div', { className: 'dbot-eyebrow' }, '你的总裁助理'),
                h('h2', { className: 'dbot-welcome-title' }, '今天，想一起推进什么？'),
                h(
                  'p',
                  { className: 'dbot-welcome-text' },
                  '告诉我你的目标。我来搭部门、配人、派活，你可以随时补充想法，或问问事情进展。',
                ),
                h(
                  'div',
                  { className: 'dbot-chips' },
                  chips.map((c) => h('button', { key: c.label, className: 'dbot-chip', onClick: () => props.onQuick(c.prompt) }, c.label)),
                ),
              ),
          live.map((act, i) => h(LiveCard, { key: 'live' + i, act, name: '助理' })),
          // 助理一边写一边显示，省掉「盯着空屏等整段生成完」的那几秒。
          typing
            ? h(
                'div',
                { className: 'dbot-row' },
                h(Av, { name: '助理', size: 27 }),
                h(
                  'div',
                  { className: 'dbot-reply' },
                  h(
                    'div',
                    { className: 'dbot-name' },
                    h('span', null, '助理'),
                    h('span', { className: 'dbot-time' }, '正在输入'),
                  ),
                  h('div', { className: 'dbot-answer dbot-typing' }, typing, h('span', { className: 'dbot-caret' }, '▍')),
                ),
              )
            : null,
        ),
        h(Composer, {
          placeholder: '告诉助理，你想做什么…',
          hint: busy ? '助理还在回上一条，你可以再补充一句。' : '',
          interject: busy,
          disabled: !runtime.hasParent,
          onSend: props.onSend,
        }),
        cfg
          ? h(AssistantConfig, {
              assistant: state.assistant,
              ui: state.ui || {},
              onShowTrace: props.onShowTrace,
              onClose: () => setCfg(false),
              onChanged: props.onChanged,
            })
          : null,
      )
    }

    function GroupPane(props) {
      const dept = props.dept
      const state = props.state || {}
      const groups = state.groups || []
      const group = groups.find((g) => g.deptId === dept.id)
      const messages = (group && group.messages) || []
      const tasks = state.tasks || []
      const running = tasks.filter((t) => t.deptId === dept.id && (t.status === 'running' || t.status === 'queued'))
      const staff = ((state.org && state.org.employees) || []).filter((e) => e.deptId === dept.id)
      const scrollRef = useRef(null)
      const count = messages.length + running.length
      useEffect(() => {
        const el = scrollRef.current
        if (el) el.scrollTop = el.scrollHeight
      }, [count])
      return h(
        'div',
        { className: 'dbot-main' },
        h(Head, {
          name: dept.name,
          title: dept.name + ' 群',
          sub: staff.length ? staff.map((s) => s.name).join('、') : '还没有员工',
          left: h(AvaUp, {
            kind: 'group',
            id: dept.id,
            name: dept.name,
            size: 30,
            avatar: (() => {
              const g = ((props.state && props.state.groups) || []).find((x) => x.deptId === dept.id)
              return (g && g.avatar) || dept.avatar
            })(),
            onDone: props.onChanged,
          }),
        }),
        h(
          'div',
          { className: 'dbot-scroll', ref: scrollRef },
          messages.length
            ? messages.map((m) => h(Bubble, { key: m.id, msg: m }))
            : h(
                'div',
                { className: 'dbot-empty' },
                h('div', null, '这是「' + dept.name + '」的工作群。助理派活会出现在这里，负责人在群里拆活，员工把结果回到群里。'),
                staff.length
                  ? h(
                      'div',
                      { className: 'dbot-chips' },
                      staff.slice(0, 4).map((s) => h('span', { key: s.id, className: 'dbot-chip', style: { cursor: 'default' } }, s.name + ' · ' + s.title)),
                    )
                  : h('div', { className: 'dbot-chips' }, h('span', { className: 'dbot-chip', onClick: () => props.onTab('org') }, '先去招人')),
              ),
          running.map((t) => (t.live || []).map((act, i) => h(LiveCard, { key: t.id + i, act, name: act.label || dept.name }))),
        ),
        h(
          'div',
          { className: 'dbot-groupfoot' },
          h(
            'div',
            { className: 'dbot-groupfoot-t' },
            '你也可以像走进部门一样在这里直接说话（部门会照办）；想让它以「助理」的身份派活，就去助理页交代。',
            h('button', { className: 'dbot-link', onClick: () => props.onTab('assistant') }, '去跟助理说'),
          ),
          h(Composer, {
            placeholder: '在「' + dept.name + '」群里直接说…',
            note: 'Enter 发送；Shift+Enter 换行；文件可以拖进来',
            disabled: !props.runtime || !props.runtime.hasParent,
            onSend: props.onSend,
          }),
        ),
      )
    }

    function DeptPane(props) {      const dept = props.dept
      const state = props.state || {}
      const staff = ((state.org && state.org.employees) || []).filter((e) => e.deptId === dept.id)
      const lead = staff.find((e) => e.id === dept.leadId) || staff[0]
      const [adding, setAdding] = useState(false)
      const [form, setForm] = useState({ name: '', title: '', duties: '', skills: '' })
      const set = (k) => (e) => setForm(Object.assign({}, form, { [k]: e.target.value }))
      async function setLead(empId) {
        await api('/departments/' + dept.id, 'PATCH', { leadId: empId })
        props.onChanged()
      }
      async function submit() {
        if (!form.name.trim()) return
        await api('/employees', 'POST', {
          deptId: dept.id,
          name: form.name.trim(),
          title: form.title.trim() || '员工',
          duties: form.duties.trim(),
          skills: form.skills.split(/[,，、\s]+/).filter(Boolean),
        })
        setForm({ name: '', title: '', duties: '', skills: '' })
        setAdding(false)
        props.onChanged()
      }
      return h(
        'div',
        { className: 'dbot-main' },
        h(Head, {
          name: dept.name,
          title: dept.name,
          sub: dept.brief || staff.length + ' 人',
          left: h(AvaUp, {
            kind: 'department',
            id: dept.id,
            name: dept.name,
            size: 30,
            avatar: dept.avatar,
            onDone: props.onChanged,
          }),
          actions: h(
            'div',
            { className: 'dbot-headacts' },
            h('button', { className: 'dbot-btn', onClick: () => props.onOpenGroup(dept.id) }, '部门群'),
            h('button', { className: 'dbot-btn', onClick: () => setAdding(!adding) }, adding ? '取消' : '＋ 加人'),
            h(
              'button',
              {
                className: 'dbot-btn danger',
                onClick: async () => {
                  if (!window.confirm('解散「' + dept.name + '」？员工会一起移除。')) return
                  await api('/departments/' + dept.id, 'DELETE')
                  props.onDeleted()
                },
              },
              '解散',
            ),
          ),
        }),
        h(
          'div',
          { className: 'dbot-pane' },
          staff.length > 1
            ? h(
                'div',
                { className: 'dbot-card' },
                h(
                  'div',
                  { className: 'dbot-card-head' },
                  h('span', { className: 'dbot-role' }, '部门负责人'),
                  h('div', { style: { flex: 1 } }),
                  h(
                    'select',
                    {
                      className: 'dbot-in dbot-leadsel',
                      value: lead ? lead.id : '',
                      onChange: (e) => setLead(e.target.value),
                    },
                    staff.map((e) => h('option', { key: e.id, value: e.id }, e.name + (e.title ? ' · ' + e.title : ''))),
                  ),
                ),
                h(
                  'div',
                  { className: 'dbot-desc' },
                  '你派的活由他来拆给其他人、最后汇总。默认是部门里第一个进来的人。',
                ),
              )
            : null,
          adding
            ? h(
                'div',
                { className: 'dbot-card' },
                h('div', { className: 'dbot-card-head' }, h('span', { className: 'dbot-role' }, '新员工')),
                h(
                  'div',
                  { className: 'dbot-form' },
                  h('input', { className: 'dbot-in', placeholder: '姓名（如 小林）', value: form.name, onChange: set('name') }),
                  h('input', { className: 'dbot-in', placeholder: '职位（如 内容编辑）', value: form.title, onChange: set('title') }),
                  h('textarea', { className: 'dbot-in', rows: 3, placeholder: '职责：做什么、交付什么、标准是什么', value: form.duties, onChange: set('duties') }),
                  h('input', { className: 'dbot-in', placeholder: '技能，用逗号分隔', value: form.skills, onChange: set('skills') }),
                  h('div', { className: 'dbot-actions' }, h('button', { className: 'dbot-btn primary', onClick: submit }, '招进来')),
                ),
              )
            : null,
          staff.length
            ? staff.map((e) => h(EmpCard, { key: e.id, emp: e, isLead: lead && lead.id === e.id, onChanged: props.onChanged }))
            : h('div', { className: 'dbot-card' }, h('div', { className: 'dbot-desc' }, '这个部门还没有人。加一个人，或者让助理帮你配齐。')),
        ),
      )
    }

    /* ------------------------------------------------------------ 定时任务 */

    const DAY_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

    function daysText(days) {
      const d = Array.isArray(days) ? days.slice().sort() : []
      if (d.length === 7) return '每天'
      if (d.join(',') === '1,2,3,4,5') return '工作日'
      if (d.join(',') === '0,6') return '周末'
      return d.map((n) => DAY_LABEL[n] || n).join(' ')
    }

    function whenText(s) {
      return daysText(s.days) + ' ' + s.at
    }

    function SchedPane(props) {
      const state = props.state || {}
      const depts = (state.org && state.org.departments) || []
      const [list, setList] = useState([])
      const [clock, setClock] = useState('')
      const [at, setAt] = useState('08:00')
      const [days, setDays] = useState('daily')
      const [title, setTitle] = useState('')
      const [brief, setBrief] = useState('')
      const [target, setTarget] = useState('')
      const [note, setNote] = useState('')
      const [busy, setBusy] = useState(false)

      const load = useCallback(async () => {
        try {
          const r = await api('/schedules')
          setList(r.schedules || [])
          setClock(r.now || '')
        } catch (e) {
          setNote(String((e && e.message) || e))
        }
      }, [])

      useEffect(() => {
        load()
        const t = setInterval(load, 20000)
        return () => clearInterval(t)
      }, [load])

      async function add() {
        if (busy) return
        if (!title.trim()) {
          setNote('先给它起个名字，比如「早报」')
          return
        }
        const mode = target ? 'task' : 'assistant'
        setBusy(true)
        try {
          await api('/schedules', 'POST', {
            at,
            days,
            title: title.trim(),
            brief: brief.trim(),
            mode,
            deptId: target,
          })
          setTitle('')
          setBrief('')
          setNote('加好了。到点它会自己开始，不用你开着对话框。')
          await load()
        } catch (e) {
          setNote(String((e && e.message) || e))
        } finally {
          setBusy(false)
        }
      }

      async function act(id, tail, body) {
        try {
          await api('/schedules/' + id + '/' + tail, 'POST', body || {})
          await load()
          if (tail === 'run') setNote('已经让它现在跑一次，结果会出现在助理对话框里。')
        } catch (e) {
          setNote(String((e && e.message) || e))
        }
      }

      const rows = list.map((s) =>
        h(
          'div',
          { key: s.id, className: 'dbot-kv', style: { alignItems: 'flex-start', gap: '10px' } },
          h(
            'div',
            { style: { flex: '1 1 auto', minWidth: 0 } },
            h('div', { style: { fontWeight: 600, color: '#1A1A1A' } }, whenText(s) + '  ' + s.title),
            h(
              'div',
              { className: 'dbot-kv-k', style: { marginTop: '2px' } },
              (s.enabled ? '' : '已暂停 · ') +
                (s.mode === 'task'
                  ? '直接派给 ' + ((depts.find((d) => d.id === s.deptId) || {}).name || '部门')
                  : '交给总裁助理') +
                (s.lastAt ? ' · 上次 ' + new Date(s.lastAt).toLocaleString('zh-CN', { hour12: false }) : ' · 还没跑过') +
                (s.lastError ? ' · ' + s.lastError : ''),
            ),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: '6px', flex: '0 0 auto' } },
            h('button', { className: 'dbot-card-act', onClick: () => act(s.id, 'run') }, '跑一次'),
            h('button', { className: 'dbot-card-act', onClick: () => act(s.id, 'toggle') }, s.enabled ? '暂停' : '恢复'),
            h('button', { className: 'dbot-card-act', onClick: () => act(s.id, 'delete') }, '删'),
          ),
        ),
      )

      return h(
        'div',
        { className: 'dbot-main' },
        h(Head, { name: '定时', title: '定时任务', sub: clock ? '现在 ' + clock : '' }),
        h(
          'div',
          { className: 'dbot-scroll' },
          note ? h('div', { className: 'dbot-hint' }, note) : null,
          h(
            'div',
            { className: 'dbot-card' },
            h('div', { className: 'dbot-card-title' }, '新建一个'),
            h(
              'div',
              { className: 'dbot-kv' },
              h('span', { className: 'dbot-kv-k' }, '时间'),
              h(
                'div',
                { className: 'dbot-inline' },
                h('input', {
                  className: 'dbot-in',
                  type: 'time',
                  value: at,
                  onChange: (e) => setAt(e.target.value),
                  style: { flex: '0 0 auto', width: '118px' },
                  'aria-label': '几点开始',
                }),
                h(
                  'select',
                  {
                    className: 'dbot-in',
                    value: days,
                    onChange: (e) => setDays(e.target.value),
                    style: { flex: '0 0 auto', width: '118px' },
                    'aria-label': '哪几天',
                  },
                  h('option', { value: 'daily' }, '每天'),
                  h('option', { value: 'workdays' }, '工作日'),
                  h('option', { value: 'weekend' }, '周末'),
                ),
              ),
            ),
            h(
              'div',
              { className: 'dbot-kv' },
              h('span', { className: 'dbot-kv-k' }, '名字'),
              h('input', {
                className: 'dbot-in',
                placeholder: '早报',
                value: title,
                onChange: (e) => setTitle(e.target.value),
                style: { flex: '1 1 auto', minWidth: 0, maxWidth: '320px' },
              }),
            ),
            h(
              'div',
              { className: 'dbot-kv', style: { alignItems: 'flex-start' } },
              h('span', { className: 'dbot-kv-k' }, '要它做什么'),
              h('textarea', {
                className: 'dbot-in',
                rows: 3,
                placeholder: '整理今天的安排和待办，用三句话讲重点。',
                value: brief,
                onChange: (e) => setBrief(e.target.value),
                style: { resize: 'vertical', minHeight: '64px', flex: '1 1 auto', minWidth: 0, maxWidth: '320px' },
              }),
            ),
            h(
              'div',
              { className: 'dbot-kv' },
              h('span', { className: 'dbot-kv-k' }, '交给'),
              h(
                'select',
                {
                  className: 'dbot-in',
                  value: target,
                  onChange: (e) => setTarget(e.target.value),
                  style: { flex: '1 1 auto', minWidth: 0, maxWidth: '320px' },
                },
                h('option', { value: '' }, '总裁助理（它自己决定派给谁）'),
                depts.map((d) => h('option', { key: d.id, value: d.id }, '直接派给「' + d.name + '」')),
              ),
            ),
            h(
              'div',
              { className: 'dbot-chips' },
              h('button', { className: 'dbot-btn primary', onClick: add, disabled: busy }, busy ? '加…' : '加进定时'),
            ),
            h(
              'div',
              { className: 'dbot-kv-k', style: { marginTop: '6px', lineHeight: 1.6 } },
              '到点时如果总裁助理正在处理别的事，会等它这一轮结束再开始；电脑关着就跳过，超过 4 小时不补跑。',
            ),
          ),
          rows.length
            ? h('div', { className: 'dbot-card' }, h('div', { className: 'dbot-card-title' }, '已经在跑的'), rows)
            : h('div', { className: 'dbot-kv-k' }, '还没有定时任务。'),
        ),
      )
    }

    function TaskPane(props) {
      const task = props.task
      const depts = (props.state && props.state.org && props.state.org.departments) || []
      const dept = depts.find((d) => d.id === task.deptId)
      const steps = task.steps || []
      const live = task.live || []
      const running = task.status === 'running' || task.status === 'queued'
      const [add, setAdd] = useState('')
      const [addNote, setAddNote] = useState('')
      const sendAdd = async () => {
        const text = String(add || '').trim()
        if (!text) return
        setAdd('')
        setAddNote('已顶上去，等它回话…')
        try {
          await api('/tasks/' + task.id + '/supplement', 'POST', { text })
          props.onChanged()
        } catch (e) {
          setAddNote('没顶进去：' + String((e && e.message) || e))
        }
      }
      return h(
        'div',
        { className: 'dbot-main' },
        h(Head, {
          name: (dept && dept.name) || '任务',
          title: task.title || task.brief || '任务',
          sub: (dept ? dept.name + ' · ' : '') + (STATUS_TEXT[task.status] || task.status) + ' · ' + ago(task.updatedAt || task.createdAt),
          actions: h(
            'div',
            { className: 'dbot-headacts' },
            running
              ? h(
                  'button',
                  {
                    className: 'dbot-btn danger',
                    onClick: async () => {
                      await api('/tasks/' + task.id + '/cancel', 'POST', {})
                      props.onChanged()
                    },
                  },
                  '停止',
                )
              : null,
            task.status === 'failed'
              ? h(
                  'button',
                  {
                    className: 'dbot-btn',
                    onClick: async () => {
                      await api('/tasks/' + task.id + '/retry', 'POST', {})
                      props.onChanged()
                    },
                  },
                  '重试',
                )
              : null,
            dept ? h('button', { className: 'dbot-btn', onClick: () => props.onOpenGroup(dept.id) }, '去群里看') : null,
            // Finished work lives in the task pane, but the boss reads the chat —
            // one click puts the delivered result back on the assistant's desk.
            task.status === 'done' || task.status === 'failed'
              ? h(
                  'button',
                  {
                    className: 'dbot-btn',
                    onClick: async () => {
                      try {
                        await api('/tasks/' + task.id + '/report', 'POST', {})
                        props.onChanged()
                      } catch (e) {
                        window.alert('没汇报成：' + String((e && e.message) || e))
                      }
                    },
                  },
                  '让助理汇报',
                )
              : null,
          ),
        }),
        h(
          'div',
          { className: 'dbot-pane' },
          h('div', { className: 'dbot-card' }, h('div', { className: 'dbot-desc' }, task.brief || task.title || '')),
          steps.map((s) =>
            h(
              'div',
              { key: s.id, className: 'dbot-card' },
              h(
                'div',
                { className: 'dbot-card-head' },
                h(Av, { name: s.kind === 'user' ? '你' : s.author || '系统', size: 26 }),
                h('div', { className: 'dbot-role' }, s.author || '系统'),
                h('div', { style: { flex: 1 } }),
                h('span', { className: 'dbot-item-sub' }, clock(s.at)),
              ),
              h('div', { className: 'dbot-desc' }, s.text || ''),
              s.trace && s.trace.length ? h(Trace, { lines: s.trace, open: false, force: true }) : null,
            ),
          ),
          live.map((act, i) => h(LiveCard, { key: 'lv' + i, act, name: act.label })),
          task.error ? h('div', { className: 'dbot-sys' }, task.error) : null,
          running
            ? h(
                'div',
                { className: 'dbot-card' },
                h('div', { className: 'dbot-role' }, '这件还在做：想起什么就直接补一句，顶进去，不另开一件'),
                h(
                  'div',
                  { className: 'dbot-composer-bar' },
                  h('input', {
                    className: 'dbot-in',
                    style: { flex: '1 1 auto', minWidth: 0 },
                    value: add,
                    placeholder: '比如：别发 PDF，改成 Word 再发我一份',
                    onChange: (e) => setAdd(e.target.value),
                    onKeyDown: (e) => {
                      if (e.key === 'Enter') sendAdd()
                    },
                  }),
                  h('button', { className: 'dbot-btn primary', onClick: sendAdd }, '顶上去'),
                ),
                addNote ? h('div', { className: 'dbot-item-sub' }, addNote) : null,
              )
            : null,
        ),
      )
    }

    /* ------------------------------------------------------------- feishu */

    function FeishuPane(props) {
      const [snap, setSnap] = useState(null)
      const [chats, setChats] = useState(null)
      const [busy, setBusy] = useState('')
      const [note, setNote] = useState('')
      const [doc, setDoc] = useState(null)
      const [appId, setAppId] = useState('')
      const [appSecret, setAppSecret] = useState('')
      const [appSaved, setAppSaved] = useState(false)

      const load = useCallback(async (probe) => {
        try {
          const r = await api('/feishu' + (probe ? '?probe=1' : ''))
          setSnap(r)
        } catch (e) {
          setNote(String((e && e.message) || e))
        }
      }, [])

      // The checklist shells out to lark-cli, so it is on demand, never on the 5 s poll.
      const check = useCallback(async () => {
        try {
          const r = await api('/feishu/doctor')
          if (r && r.doctor) {
            setDoc(r.doctor)
            // The checklist already knows which groups hold the bot; show them as
            // click-to-bind rows so the boss never has to press 刷新 first.
            if (r.doctor.chats && r.doctor.chats.length) setChats(r.doctor.chats)
          }
          else if (r && r.error) setNote('自检失败：' + r.error)
        } catch (e) {
          setNote(String((e && e.message) || e))
        }
      }, [])

      useEffect(() => {
        check()
      }, [check])

      useEffect(() => {
        let alive = true
        const tick = () => {
          if (alive) load(false)
        }
        tick()
        const timer = setInterval(tick, 5000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [load])

      async function act(path, body, label) {
        setBusy(label)
        try {
          const r = await api(path, 'POST', body || {})
          if (r && r.chats) setChats(r.chats)
          if (r && r.hint) setNote(r.hint)
          if (r && r.hello && !r.hello.ok) setNote('绑定成功，但群里发不出消息：' + (r.hello.error || ''))
          if (r && r.sent && !r.sent.ok) setNote('测试消息没发出去：' + (r.sent.error || ''))
          return r
        } catch (e) {
          setNote(String((e && e.message) || e))
        } finally {
          setBusy('')
          load(false)
        }
      }

      // Jump to the assistant conversation and hand it the request: the answer
      // belongs there, and a button that only shows a spinner looks dead.
      function walkThrough() {
        if (props.onTab) props.onTab('assistant')
        if (snap && snap.assistantBusy) return
        api('/assistant', 'POST', { text: '帮我一步步接上飞书：先自己测一遍现在卡在哪，然后一次只告诉我一步。' }).catch(() => {})
      }

      // The app credentials are the clean way in: the bot speaks as itself and the
      // channel needs no local CLI login. Saved once, they live in state.json.
      async function saveApp() {
        const id = String(appId || (snap && snap.feishu && snap.feishu.appId) || '').trim()
        if (!id) {
          setNote('先填 App ID')
          return
        }
        setBusy('app')
        try {
          const r = await api('/feishu/app', 'POST', { appId: id, appSecret: String(appSecret || '').trim() })
          if (r && r.ok) {
            setAppSaved(true)
            setAppSecret('')
            setNote(r.check && r.check.ok ? '凭证已保存，机器人可用' : '凭证已保存，但还没验证通过：' + ((r.check && r.check.error) || ''))
          } else if (r && r.hint) setNote(r.hint)
          else if (r && r.error) setNote('保存失败：' + r.error)
        } catch (e) {
          setNote(String((e && e.message) || e))
        } finally {
          setBusy('')
          load(false)
        }
      }

      const fs = (snap && snap.feishu) || {}
      const br = (snap && snap.bridge) || {}
      const cliOk = Boolean(snap && snap.cli)
      const bound = Boolean(fs.chatId)
      const rows = [
        ['机器人身份', cliOk ? 'lark-cli 已就绪' : '找不到 lark-cli（先装好并登录）'],
        [
          '通道进程',
          br.running
            ? br.mode === 'poll'
              ? '运行中 · 轮询兜底'
              : br.ready
                ? '运行中 · 已就绪'
                : '运行中 · 连接中'
            : bound
              ? '未运行'
              : '待绑定后启动',
        ],
        ['绑定群', bound ? fs.chatName || fs.chatId : '未绑定'],
        ['最近收到', fs.lastInAt ? ago(fs.lastInAt) : '—'],
        ['最近回复', fs.lastOutAt ? ago(fs.lastOutAt) : '—'],
      ]

      return h(
        'div',
        { className: 'dbot-main' },
        h(Head, {
          name: '飞书',
          title: '飞书通道',
          sub: bound ? '手机和这台电脑共用同一个助理' : '绑定一个群，就能在手机上直接派活',
        }),
        h(
          'div',
          { className: 'dbot-scroll' },
          doc && doc.steps
            ? h(
                'div',
                { className: 'dbot-card' },
                h(
                  'div',
                  { className: 'dbot-card-title' },
                  '接线自检 · ' + (doc.ok ? '全通了' : (doc.next ? '下一步：' + doc.next.label : '还差几步')),
                  h(
                    'button',
                    { className: 'dbot-card-act', onClick: check },
                    '重新测',
                  ),
                ),
                doc.steps.map((st) =>
                  h(
                    'div',
                    { key: st.key, className: 'dbot-kv' },
                    h('span', { className: 'dbot-kv-k' }, (st.ok ? '✅ ' : '⬜ ') + st.label),
                    h('span', { className: 'dbot-kv-v' }, st.detail || ''),
                  ),
                ),
                doc.next && doc.next.fix
                  ? h('div', { className: 'dbot-kv-err' }, '怎么过这一步：' + doc.next.fix)
                  : null,
              )
            : null,
          h(
            'div',
            { className: 'dbot-chips' },
            h('button', { className: 'dbot-chip', onClick: walkThrough }, '让助理带我接'),
          ),
          h(
            'div',
            { className: 'dbot-card' },
            h(
              'div',
              { className: 'dbot-card-title' },
              '你自己的机器人',
              fs.appId ? h('span', { className: 'dbot-card-act' }, '已填 ' + fs.appId) : null,
            ),
            h(
              'div',
              { className: 'dbot-hint' },
              '换成你自己建的那个机器人：发消息由它自己发，收消息也由它自己收，不依赖这台电脑上登录过哪个账号。App ID 和 Secret 在开放平台 → 你的应用 → 凭证与基础信息里。',
            ),
            h(Field, {
              label: 'App ID',
              value: appId || fs.appId || '',
              onChange: (v) => {
                setAppId(v)
                setAppSaved(false)
              },
              placeholder: 'cli_…',
            }),
            h(Field, {
              label: 'App Secret',
              value: appSecret,
              onChange: (v) => {
                setAppSecret(v)
                setAppSaved(false)
              },
              placeholder: fs.hasSecret ? '已保存过，要换再填一次' : 'App Secret',
              hint: '只在这里填一次，之后面板里显示为 ••••••。',
            }),
            h(
              'div',
              { className: 'dbot-chips' },
              h(
                'button',
                { className: 'dbot-chip on', onClick: saveApp },
                busy === 'app' ? '正在保存…' : appSaved ? '已保存' : '保存并验证',
              ),
            ),
          ),
          h(
            'div',
            { className: 'dbot-card' },
            rows.map(([k, v]) =>
              h(
                'div',
                { key: k, className: 'dbot-kv' },
                h('span', { className: 'dbot-kv-k' }, k),
                h('span', { className: 'dbot-kv-v' }, v),
              ),
            ),
            fs.lastError ? h('div', { className: 'dbot-kv-err' }, '错误：' + fs.lastError) : null,
          ),
          h(
            'div',
            { className: 'dbot-chips' },
            h('button', { className: 'dbot-chip', onClick: () => act('/feishu/chats', {}, 'chats') }, busy === 'chats' ? '正在读群…' : '刷新机器人所在的群'),
            h('button', { className: 'dbot-chip', onClick: () => load(true) }, '检查连接'),
            bound ? h('button', { className: 'dbot-chip', onClick: () => act('/feishu/test', {}, 'test') }, '发测试消息') : null,
            bound ? h('button', { className: 'dbot-chip', onClick: () => act('/feishu/restart', {}, 'restart') }, '重启通道') : null,
            bound ? h('button', { className: 'dbot-chip warn', onClick: () => act('/feishu/unbind', {}, 'unbind') }, '解绑') : null,
          ),
          (br.discovered || []).length
            ? h(
                'div',
                { className: 'dbot-card' },
                h('div', { className: 'dbot-card-title' }, '机器人最近收到消息的群（点一个绑定）'),
                br.discovered.map((d) =>
                  h(
                    'div',
                    {
                      key: d.chatId,
                      className: 'dbot-chatrow' + (d.chatId === fs.chatId ? ' is-on' : ''),
                      onClick: () => act('/feishu/bind', { chatId: d.chatId, chatName: d.sample || '' }, 'bind'),
                    },
                    h('div', { className: 'dbot-chatrow-name' }, d.sample || d.chatId),
                    h('div', { className: 'dbot-item-sub' }, ago(d.lastAt) + ' · ' + d.chatId),
                  ),
                ),
              )
            : null,
          chats && chats.length
            ? h(                'div',
                { className: 'dbot-card' },
                h('div', { className: 'dbot-card-title' }, '机器人所在的群（点一个绑定）'),
                chats.map((c) =>
                  h(
                    'div',
                    {
                      key: c.chatId,
                      className: 'dbot-chatrow' + (c.chatId === fs.chatId ? ' is-on' : ''),
                      onClick: () => act('/feishu/bind', { chatId: c.chatId, chatName: c.name }, 'bind'),
                    },
                    h('div', { className: 'dbot-chatrow-name' }, c.name),
                    h('div', { className: 'dbot-item-sub' }, (c.members ? c.members + ' 人 · ' : '') + c.chatId),
                  ),
                ),
              )
            : null,
          h(
            'div',
            { className: 'dbot-card' },
            h('div', { className: 'dbot-card-title' }, '怎么接上'),
            h(
              'ol',
              { className: 'dbot-steps' },
              h(
                'li',
                null,
                '在飞书开放平台给这个应用开权限：消息与群组里的「以应用身份发消息」「读取群消息」「获取群列表」（im:message / im:message:readonly / im:chat:readonly），改完要创建版本并发布。',
              ),
              h('li', null, '在飞书里建一个群，把「milancat bot」这个机器人拉进去（群设置 → 机器人 → 添加）。'),
              h('li', null, '回到这里点「刷新机器人所在的群」，选中那个群。'),
              h('li', null, '绑定后电脑上的 DSH 要一直开着；你在手机上发的每句话都会变成助理的一轮对话，回答也会回到这个群。'),
            ),
          ),
          note ? h('div', { className: 'dbot-hint' }, note) : null,
        ),
      )
    }

    /* -------------------------------------------------------------- panel */

    function BotPanel() {
      const [{ state, runtime, typing, err }, reload] = useStore()
      const [tab, setTab] = useState('assistant')
      const [sel, setSel] = useState({ org: '', groups: '', tasks: '' })
      const [q, setQ] = useState('')
      const [notice, setNotice] = useState('')

      const depts = (state && state.org && state.org.departments) || []
      const tasks = (state && state.tasks) || []
      const deptOf = (id) => depts.find((d) => d.id === id)

      useEffect(() => {
        if (!state) return
        setSel((prev) => {
          const next = Object.assign({}, prev)
          if (tab === 'org' && !depts.some((d) => d.id === next.org)) next.org = depts.length ? depts[0].id : ''
          if (tab === 'groups' && !depts.some((d) => d.id === next.groups)) next.groups = depts.length ? depts[0].id : ''
          if (tab === 'tasks' && !tasks.some((t) => t.id === next.tasks)) next.tasks = tasks.length ? tasks[tasks.length - 1].id : ''
          return next
        })
      }, [state, tab])

      const runningCount = tasks.filter((t) => t.status === 'running' || t.status === 'queued').length

      // Panel preference lives in state.json so it survives reloads and is the
      // same everywhere; mirror it into the module flag before children render.
      UI_SHOW_TRACE = Boolean(state && state.ui && state.ui.showTrace)
      async function setShowTrace(v) {
        UI_SHOW_TRACE = v
        try {
          await api('/ui', 'POST', { showTrace: v })
        } catch (e) {
          setNotice(String((e && e.message) || e))
        }
        reload()
      }

      async function sendAssistant(text, files) {
        try {
          await api('/assistant', 'POST', { text, files: (files || []).map((f) => f.id) })
        } catch (e) {
          setNotice(String((e && e.message) || e))
        } finally {
          reload()
        }
      }
      function sendGroup(deptId) {
        return async (text, files) => {
          try {
            await api('/groups/' + deptId + '/message', 'POST', { text, files: (files || []).map((f) => f.id) })
          } catch (e) {
            setNotice(String((e && e.message) || e))
          } finally {
            reload()
          }
        }
      }
      async function newDept() {
        const name = window.prompt('新部门叫什么？（如 内容部）')
        if (!name) return
        const brief = window.prompt('这个部门负责什么？') || ''
        try {
          const r = await api('/departments', 'POST', { name, brief })
          await reload()
          if (r && r.department) setSel(Object.assign({}, sel, { org: r.department.id }))
        } catch (e) {
          setNotice(String((e && e.message) || e))
        }
      }
      const openGroup = (id) => {
        setTab('groups')
        setSel(Object.assign({}, sel, { groups: id }))
      }

      let detail = null
      if (tab === 'assistant') {
        detail = h(AssistantPane, {
          state,
          runtime,
          typing,
          onSend: sendAssistant,
          onQuick: sendAssistant,
          onChanged: reload,
          onShowTrace: setShowTrace,
        })
      } else if (tab === 'org') {
        const dept = deptOf(sel.org)
        detail = dept
          ? h(DeptPane, {
              key: dept.id,
              dept,
              state,
              onChanged: reload,
              onDeleted: () => {
                reload()
                setSel(Object.assign({}, sel, { org: '' }))
              },
              onOpenGroup: openGroup,
            })
          : h(
              'div',
              { className: 'dbot-main' },
              h(Head, { name: '组织', title: '组织架构' }),
              h(
                'div',
                { className: 'dbot-empty' },
                h('div', null, '还没有部门。'),
                h(
                  'div',
                  { className: 'dbot-chips' },
                  h('button', { className: 'dbot-chip', onClick: newDept }, '手动新建部门'),
                  h('button', { className: 'dbot-chip', onClick: () => setTab('assistant') }, '让助理帮我配'),
                ),
              ),
            )
      } else if (tab === 'groups') {
        const dept = deptOf(sel.groups)
        detail = dept
          ? h(GroupPane, {
            key: dept.id,
            dept,
            state,
            runtime,
            onSend: sendGroup(dept.id),
            onTab: setTab,
            onChanged: reload,
          })
          : h('div', { className: 'dbot-main' }, h(Head, { name: '群', title: '部门群' }), h('div', { className: 'dbot-empty' }, '还没有部门群。先去组织里建部门。'))
      } else if (tab === 'feishu') {
        detail = h(FeishuPane, { onTab: setTab })
      } else if (tab === 'sched') {
        detail = h(SchedPane, { state })
      } else {
        const task = tasks.find((t) => t.id === sel.tasks)
        detail = task
          ? h(TaskPane, { key: task.id, task, state, onChanged: reload, onOpenGroup: openGroup })
          : h('div', { className: 'dbot-main' }, h(Head, { name: '任务', title: '任务' }), h('div', { className: 'dbot-empty' }, '还没有任务。去部门群派一件事。'))
      }

      let list = null
      if (tab === 'assistant') {
        list = h(AssistantList, {
          busy: Boolean(state && state.assistant && state.assistant.busy),
        })
      } else if (tab === 'org') {
        list = h(DeptList, { state, q, sel: sel.org, onSelect: (id) => setSel(Object.assign({}, sel, { org: id })), onNew: newDept })
      } else if (tab === 'groups') {
        list = h(GroupList, { state, q, sel: sel.groups, onSelect: (id) => setSel(Object.assign({}, sel, { groups: id })) })
      } else if (tab === 'feishu') {
        const fsState = (state && state.feishu) || {}
        list = h(
          'div',
          { className: 'dbot-listbody' },
          h(Item, {
            active: true,
            avatar: h(Av, { name: '飞', size: 36 }),
            title: '飞书通道',
            sub: fsState.chatId ? '已连接 · ' + (fsState.chatName || '群') : '未绑定，手机还收不到',
            dot: fsState.chatId ? 'run' : '',
          }),
          h('div', { className: 'dbot-listsec' }, '手机派活'),
          h('div', { className: 'dbot-quick' }, h('span', { className: 'dbot-quick-i' }, '／'), h('span', null, '在飞书群里 @ 机器人 说话')),
        )
      } else if (tab === 'sched') {
        const n = ((state && state.schedules) || []).length
        list = h(
          'div',
          { className: 'dbot-listbody' },
          h(Item, {
            active: true,
            avatar: h(Av, { name: '时', size: 36 }),
            title: '定时任务',
            sub: n ? n + ' 个在跑' : '还没有，右边可以新建',
          }),
          h('div', { className: 'dbot-listsec' }, '常见用法'),
          h(
            'div',
            { className: 'dbot-quick' },
            h('span', { className: 'dbot-quick-i' }, '／'),
            h('span', null, '每天早上 8:00 让助理发简报'),
          ),
        )
      } else {
        list = h(TaskList, { state, q, sel: sel.tasks, onSelect: (id) => setSel(Object.assign({}, sel, { tasks: id })) })
      }

      const listTitle = { assistant: '助理', org: '组织', groups: '部门群', tasks: '任务', sched: '定时', feishu: '飞书' }[tab] || ''
      const listMeta = tab === 'org' ? depts.length + ' 个部门' : tab === 'tasks' ? tasks.length + ' 件' : ''

      return h(
        'div',
        { className: 'dbot-root' + (tab === 'assistant' ? ' is-assistant' : '') },
        h('style', { 'data-milancat': '' }, CSS),
        h(Rail, { tab, counts: { running: runningCount }, onTab: setTab }),
        h(Sprite, null),
        tab === 'assistant'
          ? null
          : h(
              'div',
              { className: 'dbot-list' },
              h(
                'div',
                { className: 'dbot-search' },
                h(
                  'div',
                  { className: 'dbot-search-in' },
                  h(Icon, { name: 'search', size: 13 }),
                  h('input', {
                    placeholder: '搜索',
                    'aria-label': '搜索列表',
                    value: q,
                    onChange: (e) => setQ(e.target.value),
                  }),
                ),
              ),
              list,
            ),
        detail,
        notice
          ? h('div', { className: 'dbot-toast', onClick: () => setNotice('') }, notice)
          : err
          ? h('div', { className: 'dbot-toast', onClick: () => setNotice('') }, err)
          : null,
      )
    }

    /* --------------------------------------------------------------- icon */

    function SidebarIcon(props) {
      const size = props.size || 18
      return h(
        'span',
        { style: { display: 'inline-flex', width: size, height: size } },
        h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.7,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          },
          h('rect', { x: 3.5, y: 6.5, width: 17, height: 12, rx: 3.5 }),
          h('circle', { cx: 9, cy: 12.5, r: 1.2, fill: 'currentColor', stroke: 'none' }),
          h('circle', { cx: 15, cy: 12.5, r: 1.2, fill: 'currentColor', stroke: 'none' }),
          h('path', { d: 'M12 3.6v2.9' }),
          h('circle', { cx: 12, cy: 2.9, r: 0.8, fill: 'currentColor', stroke: 'none' }),
        ),
      )
    }

    /* ---------------------------------------------------------------- css */

    const CSS = `
.dbot-root{position:relative;display:flex;height:100%;min-height:0;width:100%;overflow:hidden;container-type:inline-size;container-name:dbot;background:var(--dbot-bg);color:var(--dbot-text);font-family:var(--dbot-font);font-size:var(--dbot-font-body);-webkit-font-smoothing:antialiased;
  --dbot-bg:#F6F7F9;--dbot-bg-rail:#E9ECF1;--dbot-bg-header:#FAFBFC;--dbot-bg-list:#EEF1F5;--dbot-surface:#FFFFFF;--dbot-surface-raised:#E9EDF4;--dbot-surface-hover:#EDF1F7;--dbot-text:#20242C;--dbot-text-secondary:#586170;--dbot-text-muted:#606B7D;--dbot-border:#D1D7E1;--dbot-divider:#E0E5EC;--dbot-accent:#1465E9;--dbot-focus:#1465E9;--dbot-success:#23845D;--dbot-warning:#8A620E;--dbot-danger:#C33947;--dbot-action-top:#1D6AE8;--dbot-action-bottom:#1255D1;--dbot-action-active:#0846BA;--dbot-action-hover:#0C55D0;--dbot-disabled-bg:#E2E7EF;--dbot-disabled-fg:#7B8596;--dbot-input-border:#CCD3DF;--dbot-input-focus-border:#4385EC;--dbot-user-bubble-border:#D7DEE8;--dbot-input-placeholder:#606B7D;--dbot-input-top:#FFFFFF;--dbot-input-bottom:#F4F6FA;--dbot-avatar-top:#FFFFFF;--dbot-avatar-bottom:#E3E7ED;--dbot-avatar-border:#C8CED8;--dbot-control-inset:#F8F9FB;--dbot-overlay:rgba(31,40,58,.19);--dbot-highlight:rgba(255,255,255,.95);--dbot-shadow-input:0 1px 2px rgba(31,44,63,.04),0 12px 30px rgba(31,44,63,.075);--dbot-shadow-drawer:0 16px 60px rgba(31,44,63,.16);--dbot-font:"Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI","PingFang SC",system-ui,sans-serif;--dbot-font-mono:"Cascadia Code",Consolas,monospace;--dbot-font-body:13.5px;--dbot-font-title:14px;--dbot-rail-width:72px;--dbot-list-width:248px;--dbot-header-height:68px;--dbot-chat-width:816px;--dbot-radius-input:15px;--dbot-radius-card:12px;--dbot-motion-short:140ms}
.dbot-root *{box-sizing:border-box}
.dbot-sprite{position:absolute;width:0;height:0;overflow:hidden}
.dbot-icon{width:18px;height:18px;flex:none;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.dbot-root button{font-family:inherit}
.dbot-root button:focus-visible,.dbot-root [role="switch"]:focus-visible,.dbot-root select:focus-visible,.dbot-root a:focus-visible{outline:2px solid var(--dbot-focus);outline-offset:3px}
.dbot-root textarea:focus-visible,.dbot-root input:focus-visible{outline:none}
.dbot-root button:active:not(:disabled){transform:translateY(1px)}

/* rail */
.dbot-rail{display:flex;flex-direction:column;align-items:center;gap:5px;padding:20px 9px 14px;width:var(--dbot-rail-width);flex:none;background:var(--dbot-bg-rail);border-right:1px solid var(--dbot-divider)}
.dbot-brand{width:38px;height:38px;border-radius:12px;display:flex;align-items:center;justify-content:center;margin-bottom:23px;color:var(--dbot-accent);background:linear-gradient(155deg,var(--dbot-surface-raised),var(--dbot-bg-header));border:1px solid var(--dbot-avatar-border);box-shadow:inset 0 1px 0 var(--dbot-highlight),0 2px 7px rgba(31,44,63,.055)}
.dbot-navitem{position:relative;width:54px;min-height:55px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;border:0;border-radius:10px;background:transparent;color:var(--dbot-text-muted);font-size:10px;cursor:pointer;transition:background var(--dbot-motion-short) ease,color var(--dbot-motion-short) ease}
.dbot-navitem:hover{background:var(--dbot-surface);color:var(--dbot-text-secondary)}
.dbot-navitem.is-on{color:var(--dbot-accent);background:linear-gradient(160deg,#FFFFFF,#F5F7FB);box-shadow:inset 0 1px 0 var(--dbot-highlight),0 1px 3px rgba(31,44,63,.05)}
.dbot-navitem.is-on::before{content:"";position:absolute;left:-9px;top:18px;width:2px;height:18px;border-radius:2px;background:var(--dbot-accent)}
.dbot-navlabel{font-size:10px;line-height:1;letter-spacing:.01em}
.dbot-railbottom{margin-top:auto;display:flex;flex-direction:column;align-items:center;gap:8px}
.dbot-monogram{width:29px;height:29px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--dbot-text-muted);background:linear-gradient(160deg,#FFFFFF,#E3E7ED);border:1px solid var(--dbot-avatar-border)}
.dbot-railpill{min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:var(--dbot-accent);color:#fff;font-size:10px;line-height:20px;text-align:center}

/* context list */
.dbot-list{display:flex;flex-direction:column;min-height:0;width:var(--dbot-list-width);flex:none;overflow:hidden;background:var(--dbot-bg-list);border-right:1px solid var(--dbot-divider)}
.dbot-search{padding:14px 12px 8px;flex:none}
.dbot-search-in{display:flex;align-items:center;gap:7px;height:32px;padding:0 10px;border:1px solid var(--dbot-border);border-radius:8px;background:var(--dbot-surface);color:var(--dbot-text-muted)}
.dbot-search-in:focus-within{border-color:var(--dbot-input-focus-border)}
.dbot-search-in input{flex:1;min-width:0;border:0;background:transparent;outline:none;font:inherit;font-size:12px;color:var(--dbot-text)}
.dbot-search-in input::placeholder{color:var(--dbot-input-placeholder)}
.dbot-listbody{flex:1;min-height:0;overflow-y:auto;padding:4px 8px 12px}
.dbot-listsec{padding:14px 10px 6px;font-size:10px;color:var(--dbot-text-muted);letter-spacing:.05em}
.dbot-listempty{padding:16px 10px;font-size:12px;line-height:1.7;color:var(--dbot-text-muted)}
.dbot-quick{display:flex;align-items:flex-start;gap:8px;padding:9px 10px;border-radius:9px;font-size:12px;line-height:1.6;color:var(--dbot-text-secondary);cursor:pointer;transition:background var(--dbot-motion-short) ease}
.dbot-quick:hover{background:var(--dbot-surface-hover)}
.dbot-quick-i{color:var(--dbot-accent);font-weight:600;flex:none}
.dbot-item{display:flex;align-items:center;gap:10px;width:100%;padding:9px 10px;margin-bottom:2px;border:1px solid transparent;border-radius:9px;background:transparent;color:inherit;text-align:left;cursor:pointer;transition:background var(--dbot-motion-short) ease,border-color var(--dbot-motion-short) ease}
.dbot-item:hover{background:var(--dbot-surface-hover)}
.dbot-item.active{background:var(--dbot-surface);border-color:var(--dbot-border);box-shadow:inset 0 1px 0 var(--dbot-highlight),0 1px 2px rgba(31,44,63,.04)}
.dbot-item-main{flex:1;min-width:0}
.dbot-item-title{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;color:var(--dbot-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dbot-item-sub{margin-top:3px;font-size:11px;color:var(--dbot-text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dbot-dot{width:7px;height:7px;border-radius:50%;flex:none;background:#A6AFBE}
.dbot-dot.run{background:var(--dbot-accent)}
.dbot-dot.done{background:var(--dbot-success)}
.dbot-dot.warn{background:var(--dbot-warning)}
.dbot-dot.err{background:var(--dbot-danger)}
.dbot-dot.wait{background:#A6AFBE}
.dbot-dot.fail{background:var(--dbot-danger)}

/* avatar */
.dbot-avatar{display:flex;align-items:center;justify-content:center;flex:none;border-radius:9px;overflow:hidden;font-size:11px;font-weight:600;color:var(--dbot-text-secondary);background:linear-gradient(145deg,var(--dbot-avatar-top),var(--dbot-avatar-bottom));border:1px solid var(--dbot-avatar-border);box-shadow:inset 0 1px 0 var(--dbot-highlight)}
.dbot-avatar-img{width:100%;height:100%;object-fit:cover;display:block}
.dbot-avup{position:relative;display:inline-flex;border-radius:10px;cursor:pointer}

/* main column + header */
.dbot-main{position:relative;flex:1;min-width:0;display:flex;flex-direction:column;min-height:0;background:var(--dbot-bg)}
.dbot-head{display:flex;align-items:center;gap:11px;height:var(--dbot-header-height);flex:none;padding:0 30px;border-bottom:1px solid var(--dbot-divider);background:var(--dbot-bg-header)}
.dbot-head-title{font-size:var(--dbot-font-title);font-weight:600;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dbot-head-sub{display:flex;align-items:center;gap:5px;margin-top:3px;font-size:11px;color:var(--dbot-text-muted)}
.dbot-headacts{display:flex;align-items:center;gap:8px}
.dbot-connection{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--dbot-text-muted)}

/* buttons */
.dbot-btn{display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:0 12px;border:1px solid var(--dbot-border);border-radius:8px;background:var(--dbot-surface);color:var(--dbot-text-secondary);font:inherit;font-size:12px;cursor:pointer;box-shadow:inset 0 1px 0 rgba(255,255,255,.8);transition:background var(--dbot-motion-short) ease,border-color var(--dbot-motion-short) ease,color var(--dbot-motion-short) ease}
.dbot-btn:hover{background:var(--dbot-surface-hover);border-color:#B9C2D0;color:var(--dbot-text)}
.dbot-btn.primary{color:#fff;font-weight:600;border-color:var(--dbot-action-bottom);background:linear-gradient(180deg,var(--dbot-action-top),var(--dbot-action-bottom));box-shadow:inset 0 1px 0 rgba(255,255,255,.33),0 2px 4px rgba(21,91,209,.18)}
.dbot-btn.primary:hover{background:var(--dbot-action-hover);color:#fff}
.dbot-btn.primary:disabled{background:var(--dbot-disabled-bg);border-color:var(--dbot-disabled-bg);color:var(--dbot-disabled-fg);box-shadow:none;cursor:not-allowed}
.dbot-btn.danger{color:var(--dbot-danger);border-color:transparent;background:transparent;box-shadow:none}
.dbot-btn.danger:hover{background:#FBEEF0;border-color:#F0D2D6;color:var(--dbot-danger)}
.dbot-link{border:0;background:none;padding:0;font:inherit;font-size:12px;color:var(--dbot-accent);cursor:pointer}
.dbot-link:hover{text-decoration:underline}
.dbot-iconbtn{display:flex;align-items:center;justify-content:center;width:27px;height:27px;border:0;border-radius:6px;background:transparent;color:var(--dbot-text-muted);cursor:pointer;transition:background var(--dbot-motion-short) ease,color var(--dbot-motion-short) ease}
.dbot-iconbtn:hover{background:var(--dbot-surface-hover);color:var(--dbot-text)}

/* chat */
.dbot-scroll{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden}
.dbot-scroll > .dbot-card{width:auto;max-width:none;margin:16px 28px 14px}
.dbot-scroll > .dbot-hint{margin:16px 30px 0}
.dbot-row{display:grid;grid-template-columns:27px minmax(0,1fr);gap:13px;max-width:min(var(--dbot-chat-width),100%);margin:0 auto 23px;padding:0 28px}
.dbot-row:first-child{margin-top:29px}
.dbot-row.me{display:flex;justify-content:flex-end;margin-bottom:29px}
.dbot-usercol{display:flex;flex-direction:column;align-items:flex-end;gap:8px;max-width:80%;min-width:0}
.dbot-user{width:fit-content;max-width:100%;padding:12px 17px;border-radius:14px 14px 4px 14px;background:var(--dbot-surface-raised);border:1px solid var(--dbot-user-bubble-border);box-shadow:inset 0 1px 0 var(--dbot-highlight);font-size:13.5px;line-height:1.85;white-space:pre-wrap;word-break:break-word}
.dbot-reply{min-width:0}
.dbot-name{display:flex;align-items:baseline;gap:10px;margin:3px 0 10px;font-size:11px;color:var(--dbot-text-secondary)}
.dbot-time{font-size:10px;color:var(--dbot-text-muted)}
.dbot-answer{font-size:13.5px;line-height:1.95;white-space:pre-wrap;word-break:break-word;color:var(--dbot-text)}
.dbot-bubble{font-size:13.5px;line-height:1.95;white-space:pre-wrap;word-break:break-word;color:var(--dbot-text)}
.dbot-typing{color:var(--dbot-text-secondary)}
.dbot-caret{display:inline-block;margin-left:1px;color:var(--dbot-accent);animation:dbot-blink 1s steps(1) infinite}
.dbot-sys{max-width:min(var(--dbot-chat-width),100%);margin:0 auto 20px;padding:0 28px;font-size:11.5px;line-height:1.8;color:var(--dbot-text-muted);text-align:center}
.dbot-from{margin-top:6px;font-size:10.5px;color:var(--dbot-text-muted)}
.dbot-atts-out{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 0}
.dbot-img{display:block;max-width:260px;overflow:hidden;border:1px solid var(--dbot-border);border-radius:10px;background:var(--dbot-surface)}
.dbot-img img{display:block;max-width:100%}
.dbot-img.wait{padding:10px 12px;font-size:11px;color:var(--dbot-text-muted)}

/* welcome */
.dbot-empty{display:flex;flex-direction:column;justify-content:center;min-height:100%;max-width:min(var(--dbot-chat-width),100%);margin:0 auto;padding:38px 28px 20px}
.dbot-mark{display:flex;align-items:center;justify-content:center;width:47px;height:47px;margin-bottom:22px;border-radius:15px;color:var(--dbot-accent);background:linear-gradient(155deg,#FFFFFF,var(--dbot-surface-raised));border:1px solid var(--dbot-avatar-border);box-shadow:inset 0 1px 0 var(--dbot-highlight),0 2px 8px rgba(31,44,63,.06)}
.dbot-eyebrow{margin-bottom:10px;font-size:11px;letter-spacing:.08em;color:var(--dbot-text-muted)}
.dbot-welcome-title{margin:0 0 12px;font-size:clamp(22px,2.3vw,29px);font-weight:550;line-height:1.5;letter-spacing:-.025em;color:var(--dbot-text)}
.dbot-welcome-text{margin:0 0 22px;max-width:42em;font-size:13px;line-height:1.9;color:var(--dbot-text-secondary)}
.dbot-chips{display:flex;flex-wrap:wrap;gap:8px;max-width:690px}
.dbot-chip{padding:8px 12px;border:1px solid var(--dbot-border);border-radius:9px;background:rgba(255,255,255,.64);color:var(--dbot-text-secondary);font:inherit;font-size:12px;cursor:pointer;box-shadow:inset 0 1px 0 rgba(255,255,255,.8);transition:border-color var(--dbot-motion-short) ease,background var(--dbot-motion-short) ease,color var(--dbot-motion-short) ease}
.dbot-chip:hover{border-color:#A8BDE1;background:#FFFFFF;color:var(--dbot-text)}

/* process trace + live work */
.dbot-trace{margin-top:17px;padding-top:10px;border-top:1px solid var(--dbot-divider)}
.dbot-trace-toggle{display:flex;align-items:center;gap:7px;border:0;background:none;padding:0;font:inherit;font-size:11px;color:var(--dbot-text-secondary);cursor:pointer}
.dbot-trace-toggle .dbot-icon{transition:transform var(--dbot-motion-short) ease}
.dbot-trace-toggle .dbot-icon.open{transform:rotate(90deg)}
.dbot-trace-body{margin:13px 0 5px;padding:1px 0 1px 13px;max-height:260px;overflow:auto;border-left:1px solid var(--dbot-border);font:11px/2 var(--dbot-font-mono);color:var(--dbot-text-muted)}
.dbot-line{white-space:pre-wrap;word-break:break-word}
.dbot-line.tool{color:var(--dbot-accent)}
.dbot-line.result{color:var(--dbot-text-secondary)}
.dbot-line.think{color:var(--dbot-warning)}
.dbot-live{display:grid;grid-template-columns:27px minmax(0,1fr);gap:13px;max-width:min(var(--dbot-chat-width),100%);margin:0 auto 20px;padding:0 28px;font-size:12px;color:var(--dbot-text-secondary)}
.dbot-live-body{min-width:0;padding-left:13px;border-left:1px solid var(--dbot-border)}
.dbot-live-head{display:flex;align-items:center;gap:6px;margin-bottom:4px;color:var(--dbot-text-secondary)}
.dbot-pulse{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--dbot-accent);animation:dbot-pulse 1.4s ease-in-out infinite}

/* composer */
.dbot-composer-wrap{flex:none;align-self:center;width:min(var(--dbot-chat-width),100%);padding:10px 28px 22px}
.dbot-busy{display:flex;align-items:center;gap:6px;margin:0 0 8px;font-size:11px;color:var(--dbot-text-secondary)}
.dbot-busy .dbot-dot{background:var(--dbot-accent)}
.dbot-composer{padding:15px 16px 12px;border:1px solid var(--dbot-input-border);border-radius:var(--dbot-radius-input);background:linear-gradient(175deg,var(--dbot-input-top),var(--dbot-input-bottom));box-shadow:inset 0 1px 0 var(--dbot-highlight),var(--dbot-shadow-input);transition:border-color var(--dbot-motion-short) ease,box-shadow var(--dbot-motion-short) ease}
.dbot-composer:focus-within{box-shadow:inset 0 1px 0 var(--dbot-highlight),var(--dbot-shadow-input)}
.dbot-input{display:block;width:100%;min-height:48px;max-height:160px;padding:0;border:0;background:transparent;outline:none;resize:none;font:inherit;font-size:13px;line-height:1.8;color:var(--dbot-text)}
.dbot-input::placeholder{color:var(--dbot-input-placeholder)}
.dbot-composer-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:7px}
.dbot-composer-left{display:flex;align-items:center;gap:10px;min-width:0}
.dbot-composer-right{display:flex;align-items:center;gap:10px}
.dbot-attach{display:inline-flex;align-items:center;gap:7px;border:0;background:transparent;padding:5px 0;font:inherit;font-size:11px;color:var(--dbot-text-secondary);cursor:pointer}
.dbot-attach:hover{color:var(--dbot-accent)}
.dbot-attach:disabled{color:var(--dbot-disabled-fg);cursor:not-allowed}
.dbot-kbd{font-size:10px;color:var(--dbot-text-muted);white-space:nowrap}
.dbot-send{display:inline-flex;align-items:center;justify-content:center;gap:5px;min-width:73px;height:32px;padding:0 13px;border:1px solid var(--dbot-action-bottom);border-radius:8px;background:linear-gradient(180deg,var(--dbot-action-top),var(--dbot-action-bottom));color:#fff;font:inherit;font-size:11px;font-weight:600;cursor:pointer;box-shadow:inset 0 1px 0 rgba(255,255,255,.33),0 2px 4px rgba(21,91,209,.18)}
.dbot-send:hover{background:var(--dbot-action-hover)}
.dbot-send:active{background:var(--dbot-action-active)}
.dbot-send:disabled{background:var(--dbot-disabled-bg);border-color:var(--dbot-disabled-bg);color:var(--dbot-disabled-fg);box-shadow:none;cursor:not-allowed}
.dbot-note{margin:9px 0 0;font-size:10px;line-height:1.5;color:var(--dbot-text-muted)}
.dbot-chint{font-size:11px;color:var(--dbot-text-secondary)}
.dbot-atts{display:flex;flex-wrap:wrap;gap:6px;padding:0 0 9px}
.dbot-att{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:4px 8px;border:1px solid var(--dbot-border);border-radius:7px;background:var(--dbot-control-inset);font-size:11px;color:var(--dbot-text-secondary)}
.dbot-att-n{max-width:220px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dbot-att-x{display:inline-flex;align-items:center;border:0;background:transparent;padding:0;color:var(--dbot-text-muted);cursor:pointer}
.dbot-att-x:hover{color:var(--dbot-danger)}
.dbot-att.err{border-color:#E9B7BE;background:#FDF2F3;color:var(--dbot-danger)}

/* settings drawer */
.dbot-modal{position:static}
.dbot-veil{position:absolute;inset:var(--dbot-header-height) 0 0;z-index:9;background:var(--dbot-overlay);backdrop-filter:blur(2px);animation:dbot-fade 160ms ease}
.dbot-drawer{position:absolute;right:16px;top:calc(var(--dbot-header-height) + 12px);bottom:16px;z-index:10;width:min(360px,calc(100% - 32px));padding:21px;overflow:auto;border:1px solid #C9D0DB;border-radius:15px;background:linear-gradient(150deg,#FCFCFD,#F1F3F7);box-shadow:inset 0 1px 0 var(--dbot-highlight),var(--dbot-shadow-drawer);animation:dbot-slide 160ms ease}
.dbot-drawer-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:18px}
.dbot-drawer-head h2{margin:0;font-size:15px;font-weight:600;color:var(--dbot-text)}
.dbot-field{display:block;margin:0 0 16px;font-size:11px;color:var(--dbot-text-secondary)}
.dbot-field-k{display:block;margin-bottom:7px}
.dbot-in{display:block;width:100%;padding:9px 11px;border:1px solid #C8D0DC;border-radius:8px;background:var(--dbot-control-inset);color:var(--dbot-text);font:inherit;font-size:12px;line-height:1.7;outline:none;resize:vertical;transition:border-color var(--dbot-motion-short) ease,box-shadow var(--dbot-motion-short) ease}
.dbot-in:focus{border-color:var(--dbot-input-focus-border)}
.dbot-field-h{display:block;margin-top:5px;font-size:10px;line-height:1.6;color:var(--dbot-text-muted)}
.dbot-form{display:block}
.dbot-caps-label{margin:0 0 8px;font-size:11px;color:var(--dbot-text-secondary)}
.dbot-caps{display:flex;flex-wrap:wrap;gap:7px;margin:0 0 16px}
.dbot-caps-row{display:flex;flex-wrap:wrap;gap:7px}
.dbot-cap{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid var(--dbot-border);border-radius:8px;background:var(--dbot-control-inset);color:var(--dbot-text-secondary);font:inherit;font-size:11.5px;cursor:pointer;transition:border-color var(--dbot-motion-short) ease,background var(--dbot-motion-short) ease,color var(--dbot-motion-short) ease}
.dbot-cap:hover{border-color:#9DBEEF;color:var(--dbot-text)}
.dbot-cap.on{border-color:#9DBEEF;background:#EAF2FE;color:#0C55D0}
.dbot-switchrow{display:flex;align-items:center;justify-content:space-between;gap:14px;margin:5px 0 18px;padding-top:17px;border-top:1px solid var(--dbot-divider);font-size:12px;color:var(--dbot-text)}
.dbot-switchtext{min-width:0}
.dbot-switch{display:flex;align-items:center;width:36px;height:21px;padding:3px;border:0;border-radius:20px;background:#C2CAD5;cursor:pointer;transition:background var(--dbot-motion-short) ease}
.dbot-switch.on{background:var(--dbot-accent)}
.dbot-switch-dot{width:15px;height:15px;border-radius:50%;background:#FFFFFF;transition:transform var(--dbot-motion-short) ease}
.dbot-switch.on .dbot-switch-dot{transform:translateX(15px)}
.dbot-settings-foot{display:flex;align-items:center;gap:8px}
.dbot-foot-gap{flex:1 1 auto}
.dbot-pref{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:14px;border-top:1px solid var(--dbot-divider)}
.dbot-pref-title{font-size:12px;color:var(--dbot-text)}
.dbot-pref-sub{font-size:10px;color:var(--dbot-text-muted);margin-top:4px;line-height:1.5}

/* org / group / task / schedule / feishu panes */
.dbot-pane{flex:1;min-height:0;overflow-y:auto;width:100%;max-width:min(980px,100%);margin:0 auto;padding:18px 28px 26px}
.dbot-card{padding:16px 18px;margin-bottom:14px;border:1px solid var(--dbot-divider);border-radius:var(--dbot-radius-card);background:var(--dbot-surface);box-shadow:inset 0 1px 0 rgba(255,255,255,.9)}
.dbot-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}
.dbot-card-title{margin:0;font-size:13px;font-weight:600;color:var(--dbot-text)}
.dbot-card-act{display:flex;align-items:center;gap:8px}
.dbot-role{font-size:13px;font-weight:600;color:var(--dbot-text)}
.dbot-desc{margin:6px 0 0;font-size:12px;line-height:1.8;color:var(--dbot-text-secondary)}
.dbot-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:13px}
.dbot-hint{margin:0;font-size:10.5px;line-height:1.7;color:var(--dbot-text-muted)}
.dbot-tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
.dbot-tag{padding:1px 6px;border-radius:5px;background:var(--dbot-surface-raised);font-size:10px;color:var(--dbot-text-secondary)}
.dbot-kv{display:grid;grid-template-columns:92px minmax(0,1fr);gap:7px 12px;align-items:center;font-size:12px}
.dbot-kv + .dbot-kv{margin-top:2px}
.dbot-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.dbot-kv-k{font-size:11px;color:var(--dbot-text-muted)}
.dbot-kv-v{color:var(--dbot-text);word-break:break-word}
.dbot-kv-err{color:var(--dbot-danger)}
.dbot-steps{display:flex;flex-direction:column;margin-top:12px}
.dbot-ab{display:grid;grid-template-columns:62px minmax(0,1fr) 56px;gap:10px;align-items:baseline;padding:8px 0;border-bottom:1px solid var(--dbot-divider);font-size:11.5px}
.dbot-ab:last-child{border-bottom:0}
.dbot-ab-k{font-size:10.5px;color:var(--dbot-text-muted)}
.dbot-ab-v{min-width:0;color:var(--dbot-text-secondary);word-break:break-word}
.dbot-ab-empty{font-size:11.5px;color:var(--dbot-text-muted)}
.dbot-chatrow{display:flex;align-items:baseline;gap:10px;padding:9px 0;border-bottom:1px solid var(--dbot-divider);font-size:12px;line-height:1.8}
.dbot-chatrow:last-child{border-bottom:0}
.dbot-chatrow-name{flex:none;width:56px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:11px;color:var(--dbot-text-secondary)}
.dbot-groupfoot{display:block;flex:none;padding:10px 28px 8px;border-top:1px solid var(--dbot-divider);background:var(--dbot-bg-header)}
.dbot-groupfoot-t{font-size:10.5px;line-height:1.7;color:var(--dbot-text-muted);margin-bottom:2px}
.dbot-groupfoot .dbot-link{margin-left:6px}
.dbot-groupfoot .dbot-composer-wrap{width:100%;padding:8px 0 0}
.dbot-groupfoot .dbot-note{display:none}
.dbot-leadsel{min-height:30px;padding:4px 8px;border:1px solid var(--dbot-border);border-radius:7px;background:var(--dbot-surface);color:var(--dbot-text-secondary);font:inherit;font-size:11.5px;outline:none}
.dbot-leadsel:focus{border-color:var(--dbot-input-focus-border)}
.dbot-toast{position:absolute;left:50%;bottom:22px;z-index:20;max-width:min(560px,calc(100% - 40px));padding:10px 14px;border-radius:10px;background:#20242C;color:#FFFFFF;font-size:12px;box-shadow:0 10px 30px rgba(20,28,40,.28);cursor:pointer;transform:translateX(-50%)}

@keyframes dbot-blink{0%,49%{opacity:1}50%,100%{opacity:0}}
@keyframes dbot-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.82)}}
@keyframes dbot-fade{from{opacity:0}to{opacity:1}}
@keyframes dbot-slide{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}

@container dbot (max-width:900px){
  .dbot-list{width:216px}
  .dbot-pane{padding:16px 20px 22px}
  .dbot-scroll > .dbot-card{margin:14px 20px 12px}
  .dbot-scroll > .dbot-hint{margin:14px 22px 0}
}
@container dbot (max-width:800px){
  .dbot-rail{width:64px;padding:16px 5px 12px}
  .dbot-navitem{width:54px;min-height:52px}
  .dbot-head{height:62px;padding:0 19px}
  .dbot-row{padding:0 24px}
  .dbot-composer-wrap{padding:10px 20px 18px}
  .dbot-empty{padding:30px 20px 18px}
  .dbot-kbd{display:none}
  .dbot-chips{flex-direction:column;align-items:stretch}
  .dbot-connection{display:none}
}
@container dbot (max-width:640px){
  .dbot-list{width:184px}
  .dbot-pane{padding:14px 16px 20px}
  .dbot-composer-right .dbot-kbd{display:none}
}
@container dbot (max-width:520px){
  .dbot-list{width:156px}
  .dbot-item{gap:8px;padding:8px}
  .dbot-item-title{font-size:12px}
  .dbot-item-sub{font-size:10.5px}
}
@container dbot (max-width:480px){
  .dbot-rail{width:54px;padding:12px 3px 10px}
  .dbot-brand{width:34px;height:34px;border-radius:10px;margin-bottom:16px}
  .dbot-navitem{width:46px;min-height:48px}
  .dbot-navitem.is-on::before{left:-3px;top:14px;height:20px}
  .dbot-navlabel{font-size:9px}
  .dbot-head{height:59px;padding:0 14px;gap:9px}
  .dbot-head-title{font-size:13px}
  .dbot-head-sub{font-size:10.5px}
  .dbot-headacts .dbot-btn{padding:0 9px;font-size:11px}
  .dbot-row{padding:0 16px;grid-template-columns:23px minmax(0,1fr);gap:9px;margin-bottom:19px}
  .dbot-user{max-width:94%;padding:10px 13px;font-size:12.5px}
  .dbot-answer,.dbot-bubble{font-size:12px}
  .dbot-sys{padding:0 16px;font-size:11px}
  .dbot-composer-wrap{padding:8px 12px 14px}
  .dbot-composer{padding:12px;border-radius:12px}
  .dbot-input{font-size:12px;min-height:44px}
  .dbot-empty{padding:24px 16px 14px}
  .dbot-welcome-title{font-size:21px}
  .dbot-live{padding:0 16px;gap:9px;grid-template-columns:23px minmax(0,1fr)}
  .dbot-drawer{right:9px;bottom:9px;width:calc(100% - 18px);padding:16px}
  .dbot-pane{padding:12px 14px 18px}
}
@container dbot (max-width:400px){
  .dbot-list{width:132px}
  .dbot-search{padding:10px 8px 6px}
  .dbot-listbody{padding:2px 5px 10px}
  .dbot-rail{width:48px}
  .dbot-navitem{width:40px}
  .dbot-monogram{display:none}
}
@media (prefers-reduced-motion:reduce){
  .dbot-root *,.dbot-root *::before,.dbot-root *::after{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important}
}
`

    /* --------------------------------------------------------------- apply */

    return {
      inject: ['slots'],
      apply(ctx) {
        CTX = ctx
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: 'bot', order: 6, label: () => 'bot' }, SidebarIcon),
        )
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'bot' }, BotPanel))
      },
    }
  },
})
