/* 员工技能文件：每个员工目录下的一页 技能.md
 *
 * 记忆回答「发生过什么」，技能回答「这类事怎么做」——
 * 由老板（或助理）写定的可复用做法，每次开工都会注入提示词。
 * 员工自己也可以在干完活后往里追加（同一目录，闸门允许）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const FILE = '技能.md'
const MAX = 4000

export function skillPath(dir) {
  return join(dir, FILE)
}

export function readSkill(dir) {
  try {
    const p = skillPath(dir)
    if (!existsSync(p)) return ''
    return String(readFileSync(p, 'utf8')).slice(0, MAX).trim()
  } catch {
    return ''
  }
}

export function writeSkill(dir, text) {
  const body = String(text || '').slice(0, MAX)
  try {
    writeFileSync(skillPath(dir), body.trim() ? `${body.trim()}\n` : '', 'utf8')
    return true
  } catch {
    return false
  }
}

/** 拼进提示词的那一段（没有技能文件就返回空串）。 */
export function skillCard(emp, dir) {
  const text = readSkill(dir)
  if (!text) return ''
  return [
    `你的技能手册（${(emp && emp.name) || '员工'} 自己在用的做法，必须照这个来）：`,
    text,
  ].join('\n')
}

/** 员工可以自己追加一条做法（一行一条，重复的不写）。 */
export function appendSkill(dir, line) {
  const t = String(line || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
  if (t.length < 6) return false
  const cur = readSkill(dir)
  if (cur.includes(t)) return false
  const next = cur ? `${cur}\n- ${t}` : `# 技能手册\n\n- ${t}`
  return writeSkill(dir, next)
}
