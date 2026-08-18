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
//       maxBytes: 3000          # per-file cap before injection
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
// Read + truncate the configured files. Called at each prompt assembly so the
// injected memory reflects file edits without a plugin reload.
function loadSnapshot(files, maxBytes) {
    const parts = [];
    const errors = [];
    for (const raw of files) {
        const abs = resolve(expandHome(raw));
        try {
            const content = readFileSync(abs, 'utf-8');
            parts.push(`--- ${raw} ---\n${content.slice(0, maxBytes)}`);
        }
        catch (e) {
            errors.push(`${raw}: ${e.message}`);
        }
    }
    if (parts.length === 0) {
        return `MEMORY-SNAPSHOT-ERROR: 无法读取任何记忆文件。${errors.join('; ')}`;
    }
    return parts.join('\n\n') + (errors.length ? `\n\n(部分文件读取失败: ${errors.join('; ')})` : '');
}
export function apply(ctx, config) {
    // config is the second argument (merged with defaults) per the Cordis
    // object/function plugin convention. The Schema has already been run by
    // Cordis, so the fields are validated; the spread guards a bare invocation.
    const cfg = { ...DEFAULTS, ...(config ?? {}) };
    const { order, marker } = cfg;
    // Rebind files/maxBytes so the provider closure stays current.
    const files = cfg.files;
    const maxBytes = cfg.maxBytes;
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
            loadSnapshot(files, maxBytes),
            '---',
            '记忆快照结束。请勿复述以上内容，只需在相关问题时使用它。',
        ].join('\n'),
    });
}
