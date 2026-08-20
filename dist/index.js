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
//
// Config (via cordis.patch.yml):
//   - id: memory-snapshot
//     name: '<path-to-built>/dist/index.js'     # or file:///...
//     config:
//       files: ['./MEMORY.md', '~/notes/context.md']  # paths, ~ supported
//       maxBytes: 3000          # per-file UTF-8 byte cap before injection
//       totalMaxBytes: 0        # combined cap across all files (0 = unlimited)
//       order: 50               # systemPrompt section order (persona=0, tools=100-199)
//       marker: 'MEMORY-SNAPSHOT'  # marker text before the snapshot
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
export const name = 'dsh-memory-snapshot';
export const inject = ['systemPrompt'];
const DEFAULTS = {
    files: ['./MEMORY.md'],
    maxBytes: 3000,
    totalMaxBytes: 0,
    order: 50,
    marker: 'MEMORY-SNAPSHOT',
};
export const Config = {
    '~standard': {
        version: 1,
        vendor: 'dsh-memory-snapshot',
        validate(value) {
            const issues = [];
            const input = value === undefined || value === null ? {} : value;
            const files = input.files ?? DEFAULTS.files;
            if (!Array.isArray(files)) {
                issues.push({ message: 'files must be an array of paths', path: ['files'] });
            }
            else if (files.some(f => typeof f !== 'string')) {
                issues.push({ message: 'every file path must be a string', path: ['files'] });
            }
            if (input.maxBytes !== undefined && (typeof input.maxBytes !== 'number' || !Number.isFinite(input.maxBytes) || input.maxBytes <= 0)) {
                issues.push({ message: 'maxBytes must be a positive finite number', path: ['maxBytes'] });
            }
            if (input.totalMaxBytes !== undefined && (typeof input.totalMaxBytes !== 'number' || !Number.isFinite(input.totalMaxBytes) || input.totalMaxBytes < 0)) {
                issues.push({ message: 'totalMaxBytes must be a non-negative finite number', path: ['totalMaxBytes'] });
            }
            if (input.order !== undefined && (typeof input.order !== 'number' || !Number.isFinite(input.order))) {
                issues.push({ message: 'order must be a finite number', path: ['order'] });
            }
            if (input.marker !== undefined && typeof input.marker !== 'string') {
                issues.push({ message: 'marker must be a string', path: ['marker'] });
            }
            if (issues.length)
                return { issues };
            const merged = { ...DEFAULTS, ...input };
            merged.files = [...files];
            return { value: merged };
        },
    },
};
function expandHome(p) {
    if (p === '~')
        return homedir();
    if (p.startsWith('~/') || p.startsWith('~\\'))
        return resolve(homedir(), p.slice(2));
    return p;
}
// Truncate text to at most `maxBytes` UTF-8 bytes without splitting a
// multi-byte character. Iterates code points, so each `ch` is a whole glyph
// and Buffer.byteLength(ch) is its full UTF-8 width.
function truncateUtf8(text, maxBytes) {
    let out = '';
    let bytes = 0;
    for (const ch of text) {
        const n = Buffer.byteLength(ch, 'utf8');
        if (bytes + n > maxBytes)
            break;
        out += ch;
        bytes += n;
    }
    return out;
}
// Read + truncate the configured files. Called at each prompt assembly so the
// injected memory reflects file edits without a plugin reload.
// - maxBytes: per-file UTF-8 byte cap (real bytes, not UTF-16 code units).
// - totalMaxBytes: combined cap across all files (0 = unlimited), greedy in
//   `files` order. A file whose injected text (header + content + marker)
//   exceeds the remaining budget is skipped and noted; smaller later files
//   can still make it in.
function loadSnapshot(files, maxBytes, totalMaxBytes) {
    const parts = [];
    const errors = [];
    const skipped = [];
    let remaining = totalMaxBytes;
    for (const raw of files) {
        const abs = resolve(expandHome(raw));
        try {
            const content = readFileSync(abs, 'utf-8');
            const originalBytes = Buffer.byteLength(content, 'utf8');
            let text = content;
            let truncated = false;
            if (originalBytes > maxBytes) {
                text = truncateUtf8(content, maxBytes);
                const lastNl = text.lastIndexOf('\n');
                if (lastNl !== -1)
                    text = text.slice(0, lastNl + 1);
                truncated = true;
            }
            let body = text;
            if (truncated) {
                const injectedBytes = Buffer.byteLength(text, 'utf8');
                const nl = text.endsWith('\n') ? '' : '\n';
                body = `${text}${nl}…[已截断，原文 ${originalBytes} 字节，注入前 ${injectedBytes} 字节]`;
            }
            const full = `--- ${raw} ---\n${body}`;
            const bytes = Buffer.byteLength(full, 'utf8');
            if (totalMaxBytes > 0 && bytes > remaining) {
                skipped.push(`[未注入: ${raw}，超出总预算]`);
                continue;
            }
            parts.push(full);
            if (totalMaxBytes > 0)
                remaining -= bytes;
        }
        catch (e) {
            errors.push(`${raw}: ${e.message}`);
        }
    }
    const skipNote = skipped.length ? `\n\n(部分文件未注入: ${skipped.join('; ')})` : '';
    const errorNote = errors.length ? `\n\n(部分文件读取失败: ${errors.join('; ')})` : '';
    if (parts.length === 0) {
        if (errors.length)
            return `MEMORY-SNAPSHOT-ERROR: 无法读取任何记忆文件。${errors.join('; ')}${skipNote}`;
        if (skipped.length)
            return `MEMORY-SNAPSHOT-ERROR: 无文件注入（全部超出总预算）。${skipped.join('; ')}`;
        return 'MEMORY-SNAPSHOT-ERROR: 无记忆文件。';
    }
    return parts.join('\n\n') + skipNote + errorNote;
}
export function apply(ctx, config) {
    // config is the second argument (merged with defaults) per the Cordis
    // object/function plugin convention. The Schema has already been run by
    // Cordis, so the fields are validated; the spread guards a bare invocation.
    const cfg = { ...DEFAULTS, ...(config ?? {}) };
    const { order, marker } = cfg;
    // Rebind files/maxBytes/totalMaxBytes so the provider closure stays current.
    const files = cfg.files;
    const maxBytes = cfg.maxBytes;
    const totalMaxBytes = cfg.totalMaxBytes;
    // text is a provider evaluated at each assembly, so the snapshot stays
    // current (see PromptSection.text: string | (context) => string in
    // packages/core/system-prompt). Returns the disposer automatically handled
    // by Cordis on unload.
    ctx.systemPrompt.section({
        name: 'memory-snapshot',
        order,
        text: () => [
            `${marker}-MARKER: 用户记忆快照已注入。`,
            '以下是用户的长期记忆文件（持久化，跨会话持续有效，回答用户问题时优先参考）：',
            '---',
            loadSnapshot(files, maxBytes, totalMaxBytes),
            '---',
            '记忆快照结束。请勿复述以上内容，只需在相关问题时使用它。',
        ].join('\n'),
    });
}
