// dsh-memory-snapshot
// Zero-dependency DeepSeek Harness (dsh) plugin: inject a snapshot of local
// markdown/text files into every session's system prompt as lightweight memory.
//
// Why: dsh's official memory story is MCP-backed third-party servers (Memorix,
// Engram, MCP reference memory — all default-off, not endorsed by DeepSeek).
// This plugin covers the simplest need: "read files I already have" — no
// server, no database, no model, no account.
//
// Config (via cordis patch overlay):
//   - id: memory-snapshot
//     name: '<path-to-this-plugin>/index.js'     # or file:///...
//     config:
//       files: ['./MEMORY.md', '~/notes/context.md']  # paths, ~ supported
//       maxBytes: 3000          # per-file cap before injection
//       order: 50               # systemPrompt section order
//       marker: 'MEMORY-SNAPSHOT'  # marker text before the snapshot
//
// Cordis config schema: standard-schema interface (`Config["~standard"].validate`).
// This plugin implements it by hand (zero dependency) instead of pulling in zod.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

export const name = 'dsh-memory-snapshot'
export const inject = ['systemPrompt']

const DEFAULTS = {
  files: ['./MEMORY.md'],
  maxBytes: 3000,
  order: 50,
  marker: 'MEMORY-SNAPSHOT',
}

// ---- Standard Schema compatible Config (zero-dep) ----
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-memory-snapshot',
    validate(value) {
      const issues = []
      if (value === undefined || value === null) value = {}
      if (!Array.isArray(value.files ?? DEFAULTS.files)) {
        issues.push({ message: 'files must be an array of paths', path: ['files'] })
      }
      if (value.maxBytes !== undefined && (typeof value.maxBytes !== 'number' || value.maxBytes <= 0)) {
        issues.push({ message: 'maxBytes must be a positive number', path: ['maxBytes'] })
      }
      if (value.order !== undefined && typeof value.order !== 'number') {
        issues.push({ message: 'order must be a number', path: ['order'] })
      }
      if (value.marker !== undefined && typeof value.marker !== 'string') {
        issues.push({ message: 'marker must be a string', path: ['marker'] })
      }
      if (issues.length) return { issues }
      return { value: { ...DEFAULTS, ...value } }
    },
  },
}

function expandHome(p) {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return resolve(homedir(), p.slice(2))
  return p
}

function loadSnapshot(filePaths, maxBytes) {
  const parts = []
  const errors = []
  for (const raw of filePaths) {
    const p = expandHome(raw)
    const abs = resolve(p)
    try {
      const content = readFileSync(abs, 'utf-8')
      const sliced = content.length > maxBytes ? content.slice(0, maxBytes) : content
      parts.push(`--- ${raw} ---\n${sliced}`)
    } catch (e) {
      errors.push(`${raw}: ${e.message}`)
    }
  }
  if (parts.length === 0) {
    return `MEMORY-SNAPSHOT-ERROR: 无法读取任何记忆文件。${errors.join('; ')}`
  }
  return parts.join('\n\n') + (errors.length ? `\n\n(部分文件读取失败: ${errors.join('; ')})` : '')
}

export function apply(ctx, config) {
  // Cordis object plugins receive config as the SECOND argument (apply(ctx, config)).
  // ctx.plugin?.config is kept as a fallback for environments that expose it there.
  const cfg = { ...DEFAULTS, ...(config ?? ctx.plugin?.config ?? {}) }
  const files = cfg.files
  const maxBytes = cfg.maxBytes
  const order = cfg.order
  const marker = cfg.marker

  const snapshot = loadSnapshot(files, maxBytes)
  ctx.systemPrompt.section({
    name: 'memory-snapshot',
    order,
    text: [
      `${marker}-MARKER: 用户记忆快照已注入。`,
      '以下是用户的长期记忆文件（持久化，跨会话持续有效，回答用户问题时优先参考）：',
      '---',
      snapshot,
      '---',
      '记忆快照结束。请勿复述以上内容，只需在相关问题时使用它。',
    ].join('\n'),
  })
}