// dsh-memory-snapshot
// Zero-dependency DeepSeek Harness (dsh) plugin: inject a snapshot of local
// markdown/text files into every session's system prompt as lightweight memory.
//
// Why: most dsh users already run other Agent tools (Codex, Claude Code,
// Hermes, OpenCode, ...), each with its own rule files and long-term-memory
// markdown documents scattered across different directories; some also keep
// a knowledge-base repo of rules, docs and knowledge they want carried
// along. This plugin lets you list those document paths in `files`; dsh then
// proactively injects them into every session's system prompt — across all
// workspaces (home-level install + absolute paths). Stock dsh's AGENTS.md
// auto-load only covers `~/.dsh/AGENTS.md` (one global file) and the project
// directory chain — it never reads other tools' global documents. One-way
// and read-only: dsh never writes back.
// No server, no database, no model account, no dependency.
//
// Plugin contract (official standard):
//   - A plugin is a TypeScript module that exports `apply` — see
//     docs/user/develop/basic/index.md ("Your first plugin").
//   - Config is the SECOND argument of apply(ctx, config) — object/function
//     plugins receive it there, not via ctx.plugin.config.
//   - Config schema: Cordis checks `Config["~standard"].validate`. zod and
//     Schemastery are convenience wrappers over that same interface; this
//     plugin implements it directly to stay dependency-free. The schema fills
//     defaults, so apply() receives a fully-populated config.
//   - section(): registers an ordered systemPrompt section (see
//     docs/user/develop/basic/config.md and packages/core/system-prompt).
//     `interpolate: false` keeps the snapshot literal: dsh 0.2.x interpolates
//     `{{variable}}` refs in sections by default and throws on unknown names.
//
// Config (via cordis.patch.yml):
//   - id: memory-snapshot
//     name: '<path-to-built>/dist/index.js'     # or file:///... or package name
//     config:
//       files: ['./MEMORY.md', '~/notes/context.md', '~/notes']  # files or directories
//       maxBytes: 3000          # per-file UTF-8 byte cap before injection
//       totalMaxBytes: 0        # combined cap across all files (0 = unlimited)
//       dirDepth: 1             # directory recursion depth (1 = direct children only)
//       skipMissing: false      # true = silently skip missing/unreadable entries
//       freshness: true         # true = snapshot time + per-file mtime in headers
//       stripFrontMatter: true  # true = strip leading YAML front-matter blocks
//       order: 50               # systemPrompt section order (persona=0, tools=1000+)
//       marker: 'MEMORY-SNAPSHOT'  # marker text before the snapshot

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const name = 'dsh-memory-snapshot'
export const inject = ['systemPrompt']

export interface Config {
  files: string[]
  maxBytes: number
  totalMaxBytes: number
  dirDepth: number
  skipMissing: boolean
  freshness: boolean
  stripFrontMatter: boolean
  order: number
  marker: string
}

const DEFAULTS: Config = {
  files: ['./MEMORY.md'],
  maxBytes: 3000,
  totalMaxBytes: 0,
  dirDepth: 1,
  skipMissing: false,
  freshness: true,
  stripFrontMatter: true,
  order: 50,
  marker: 'MEMORY-SNAPSHOT',
}

// ---- Hand-written Standard Schema Config (zero-dep) ----
// Cordis validates config via `Config["~standard"].validate(value)`. This is
// the same interface zod / @deepseek-ai/schemastery implement internally, so
// a primitive (valid) schema here needs no external dependency. Per the
// official "Fail loudly on invalid configuration" principle, invalid input
// returns issues at load time instead of silently misbehaving later.
type StdResult =
  | { value: Config }
  | { issues: { message: string; path: (string | number)[] }[] }

interface StdIssue {
  message: string
  path: (string | number)[]
}

export const Config: { '~standard': { version: 1; vendor: string; validate(value: unknown): StdResult } } = {
  '~standard': {
    version: 1,
    vendor: 'dsh-memory-snapshot',
    validate(value: unknown): StdResult {
      const issues: StdIssue[] = []
      const input: Record<string, unknown> =
        value === undefined || value === null ? {} : (value as Record<string, unknown>)
      const files = (input.files as unknown) ?? DEFAULTS.files
      if (!Array.isArray(files)) {
        issues.push({ message: 'files must be an array of paths', path: ['files'] })
      } else if (files.some(f => typeof f !== 'string')) {
        issues.push({ message: 'every file path must be a string', path: ['files'] })
      }
      if (input.maxBytes !== undefined && (typeof input.maxBytes !== 'number' || !Number.isFinite(input.maxBytes) || input.maxBytes <= 0)) {
        issues.push({ message: 'maxBytes must be a positive finite number', path: ['maxBytes'] })
      }
      if (input.totalMaxBytes !== undefined && (typeof input.totalMaxBytes !== 'number' || !Number.isFinite(input.totalMaxBytes) || input.totalMaxBytes < 0)) {
        issues.push({ message: 'totalMaxBytes must be a non-negative finite number', path: ['totalMaxBytes'] })
      }
      if (input.dirDepth !== undefined && (typeof input.dirDepth !== 'number' || !Number.isFinite(input.dirDepth) || !Number.isInteger(input.dirDepth) || input.dirDepth < 1)) {
        issues.push({ message: 'dirDepth must be a positive integer', path: ['dirDepth'] })
      }
      if (input.skipMissing !== undefined && typeof input.skipMissing !== 'boolean') {
        issues.push({ message: 'skipMissing must be a boolean', path: ['skipMissing'] })
      }
      if (input.freshness !== undefined && typeof input.freshness !== 'boolean') {
        issues.push({ message: 'freshness must be a boolean', path: ['freshness'] })
      }
      if (input.stripFrontMatter !== undefined && typeof input.stripFrontMatter !== 'boolean') {
        issues.push({ message: 'stripFrontMatter must be a boolean', path: ['stripFrontMatter'] })
      }
      if (input.order !== undefined && (typeof input.order !== 'number' || !Number.isFinite(input.order))) {
        issues.push({ message: 'order must be a finite number', path: ['order'] })
      }
      if (input.marker !== undefined && typeof input.marker !== 'string') {
        issues.push({ message: 'marker must be a string', path: ['marker'] })
      }
      if (issues.length) return { issues }
      const merged: Config = { ...DEFAULTS, ...(input as Partial<Config>) }
      merged.files = [...(files as string[])]
      return { value: merged }
    },
  },
}

function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return resolve(homedir(), p.slice(2))
  return p
}

function statOrNull(p: string): { isDirectory(): boolean; mtime: Date } | null {
  try {
    return statSync(p)
  } catch {
    return null
  }
}

// Local time as `YYYY-MM-DD HH:mm ±HH:MM` (fixed width) — used for the
// snapshot timestamp and per-file mtimes.
function formatLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const tzMin = -d.getTimezoneOffset()
  const sign = tzMin >= 0 ? '+' : '-'
  const abs = Math.abs(tzMin)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} ${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

// Strip a leading YAML front-matter block (a `---` first line up to a closing
// `---` or `...` line). An unclosed block is kept as-is — conservative: it
// must never swallow the document body.
function stripFrontMatter(text: string): string {
  const lines = text.split('\n')
  if ((lines[0] ?? '').replace(/\r$/, '') !== '---') return text
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '')
    if (line === '---' || line === '...') return lines.slice(i + 1).join('\n')
  }
  return text
}

// Collect `*.md` paths (relative to `dir`) down to `maxDepth` directory
// levels (1 = direct children only). Dot-directories are skipped; the caller
// sorts the result for a deterministic order.
function collectMarkdown(dir: string, depth: number, maxDepth: number, out: string[], prefix: string): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name
    if (ent.isDirectory()) {
      if (depth < maxDepth) collectMarkdown(join(dir, ent.name), depth + 1, maxDepth, out, rel)
    } else if (/\.md$/i.test(ent.name)) {
      out.push(rel)
    }
  }
}

// Truncate text to at most `maxBytes` UTF-8 bytes without splitting a
// multi-byte character. Iterates code points, so each `ch` is a whole glyph
// and Buffer.byteLength(ch) is its full UTF-8 width.
function truncateUtf8(text: string, maxBytes: number): string {
  let out = ''
  let bytes = 0
  for (const ch of text) {
    const n = Buffer.byteLength(ch, 'utf8')
    if (bytes + n > maxBytes) break
    out += ch
    bytes += n
  }
  return out
}

interface SnapshotOptions {
  maxBytes: number
  totalMaxBytes: number
  dirDepth: number
  skipMissing: boolean
  freshness: boolean
  stripFrontMatter: boolean
}

// Read + truncate the configured entries. Called at each prompt assembly so
// the injected memory reflects file edits without a plugin reload.
// - Directory entries expand to their `*.md` children (dirDepth levels,
//   deterministic order). Each expanded file keeps its own cap/budget rules.
// - maxBytes: per-file UTF-8 byte cap (real bytes, not UTF-16 code units).
// - totalMaxBytes: combined cap across all files (0 = unlimited), greedy in
//   expanded order. A file whose injected text (header + content + notes)
//   exceeds the remaining budget is skipped and noted.
// - skipMissing: missing/unreadable entries are dropped silently; without it
//   they surface in a trailing note (or the sole error line when nothing is
//   left).
// - freshness: header lines carry the snapshot time and per-file mtime.
// - stripFrontMatter: leading YAML front-matter blocks are removed before
//   truncation.
function loadSnapshot(files: string[], opts: SnapshotOptions): string {
  const parts: string[] = []
  const errors: string[] = []
  const skipped: string[] = []
  const unavailable: { raw: string; reason: string }[] = []
  const expanded: { raw: string; abs: string }[] = []
  let remaining = opts.totalMaxBytes

  // Expand directory entries first, so a missing/unreadable path still
  // surfaces even when it could not contribute any file.
  for (const raw of files) {
    const abs = resolve(expandHome(raw))
    const st = statOrNull(abs)
    if (st === null) {
      unavailable.push({ raw, reason: '不存在或不可访问' })
      continue
    }
    if (st.isDirectory()) {
      const rels: string[] = []
      collectMarkdown(abs, 1, opts.dirDepth, rels, '')
      rels.sort()
      if (rels.length === 0) {
        unavailable.push({ raw, reason: '目录中无 .md 文件' })
        continue
      }
      for (const rel of rels) expanded.push({ raw: `${raw}/${rel}`, abs: join(abs, rel) })
    } else {
      expanded.push({ raw, abs })
    }
  }

  for (const { raw, abs } of expanded) {
    const st = statOrNull(abs)
    if (st === null) {
      unavailable.push({ raw, reason: '不存在或不可访问' })
      continue
    }
    let content: string
    try {
      content = readFileSync(abs, 'utf-8')
    } catch (e) {
      unavailable.push({ raw, reason: (e as Error).message })
      continue
    }
    if (opts.stripFrontMatter) content = stripFrontMatter(content)
    const originalBytes = Buffer.byteLength(content, 'utf8')
    let text = content
    let truncated = false
    if (originalBytes > opts.maxBytes) {
      text = truncateUtf8(content, opts.maxBytes)
      const lastNl = text.lastIndexOf('\n')
      if (lastNl !== -1) text = text.slice(0, lastNl + 1)
      truncated = true
    }
    let body = text
    if (truncated) {
      const injectedBytes = Buffer.byteLength(text, 'utf8')
      const nl = text.endsWith('\n') ? '' : '\n'
      body = `${text}${nl}…[已截断，原文 ${originalBytes} 字节，注入前 ${injectedBytes} 字节]`
    }
    const header = opts.freshness
      ? `--- ${raw} (最后修改: ${formatLocal(st.mtime)}) ---`
      : `--- ${raw} ---`
    const full = `${header}\n${body}`
    const bytes = Buffer.byteLength(full, 'utf8')
    if (opts.totalMaxBytes > 0 && bytes > remaining) {
      skipped.push(`[未注入: ${raw}，超出总预算]`)
      continue
    }
    parts.push(full)
    if (opts.totalMaxBytes > 0) remaining -= bytes
  }

  // skipMissing=true keeps the output clean (no path list); otherwise missing
  // entries are reported like read failures.
  if (unavailable.length && !opts.skipMissing) {
    for (const u of unavailable) errors.push(`${u.raw}: ${u.reason}`)
  }
  const skipNote = skipped.length ? `\n\n(部分文件未注入: ${skipped.join('; ')})` : ''
  const errorNote = errors.length ? `\n\n(部分文件读取失败: ${errors.join('; ')})` : ''
  if (parts.length === 0) {
    if (errors.length) return `MEMORY-SNAPSHOT-ERROR: 无法读取任何记忆文件。${errors.join('; ')}${skipNote}`
    if (skipped.length) return `MEMORY-SNAPSHOT-ERROR: 无文件注入（全部超出总预算）。${skipped.join('; ')}`
    if (unavailable.length) return `MEMORY-SNAPSHOT-ERROR: 无可用记忆文件（skipMissing 已跳过 ${unavailable.length} 个缺失或不可读的条目）。`
    return 'MEMORY-SNAPSHOT-ERROR: 无记忆文件。'
  }
  return parts.join('\n\n') + skipNote + errorNote
}

export function apply(ctx: { systemPrompt: { section(opt: { name: string; order: number; text: string | (() => string); interpolate?: boolean }): void } }, config: Config) {
  // config is the second argument (merged with defaults) per the Cordis
  // object/function plugin convention. The Schema has already been run by
  // Cordis, so the fields are validated; the spread guards a bare invocation.
  const cfg: Config = { ...DEFAULTS, ...(config ?? {}) } as Config
  const { order, marker } = cfg
  // Rebind the snapshot options so the provider closure stays current.
  const files = cfg.files
  const opts: SnapshotOptions = {
    maxBytes: cfg.maxBytes,
    totalMaxBytes: cfg.totalMaxBytes,
    dirDepth: cfg.dirDepth,
    skipMissing: cfg.skipMissing,
    freshness: cfg.freshness,
    stripFrontMatter: cfg.stripFrontMatter,
  }

  // text is a provider evaluated at each assembly, so the snapshot stays
  // current (see PromptSection.text: string | (context) => string in
  // packages/core/system-prompt). Returns the disposer automatically handled
  // by Cordis on unload.
  ctx.systemPrompt.section({
    name: 'memory-snapshot',
    order,
    // Keep the snapshot literal: dsh 0.2.x interpolates `{{variable}}` refs in
    // sections by default and throws on unknown names — a memory file that
    // contains `{{foo}}` would otherwise kill the whole session (verified on
    // 0.2.0-rc.2). Memory files are raw user content, so never interpolate.
    interpolate: false,
    text: () => {
      const lines = [`${marker}-MARKER: 用户记忆快照已注入。`]
      if (cfg.freshness) lines.push(`快照生成时间：${formatLocal(new Date())}`)
      lines.push(
        '以下是用户的长期记忆文件（持久化，跨会话持续有效，回答用户问题时优先参考）：',
        '---',
        loadSnapshot(files, opts),
        '---',
        '记忆快照结束。请勿复述以上内容，只需在相关问题时使用它。',
      )
      return lines.join('\n')
    },
  })
}