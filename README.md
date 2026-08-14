# dsh-memory-snapshot

Zero-dependency [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin:
inject a snapshot of your local markdown/text files into **every session's system prompt** as lightweight long-term memory.

> ⚠️ dsh is in developer preview (v0.1.0-rc.x). Plugin APIs may change across releases — check [breaking changes](https://github.com/deepseek-ai/deepseek-harness/releases) when upgrading.

## Why

dsh's official memory story is MCP-backed third-party servers ([Memorix](https://github.com/AVIDS2/memorix), [Engram](https://github.com/Gentleman-Programming/engram), [MCP Reference Memory](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)) — all default-off, not endorsed by DeepSeek, and each requires installing a server, a database, or a model account.

This plugin covers the simplest need: **read the markdown files you already have**. No server. No database. No model. No account. Point it at `MEMORY.md`, `NOTES.md`, a knowledge base — done.

### Why a plugin? dsh can already read markdown.

Fair question. `dsh` ships `read`/`glob` tools — you can always prompt it "read ~/MEMORY.md". The difference is **who decides memory gets consumed**:

| | Without plugin (passive) | With plugin (active) |
|---|---|---|
| Memory present | Only if you prompt it, or the model happens to decide | **Always in the system prompt**, every session |
| Headless / automation calls | No human to say "check your memory" | Memory is there by default — no caller change needed |
| Workspace scope | AGENTS.md auto-load is **workspace-local** (and only a low-level user-role reminder, verified empirically) | Plugin can point at **any path**, outside the workspace |
| Cost per task | Extra tool-call round-trips, model-dependent read depth | Fixed snapshot, `maxBytes`-capped, uniform in Trajectory |
| Reliability | Model may skim 200 bytes and go | Complete controlled snapshot every time |

So this plugin is not about adding read capability — dsh already has it. It's about making memory **"always present" instead of "possibly remembered"**. The main battlefield is unattended scenarios: headless batches, automation pipelines, multi-agent flows, where no human is around to say "check your memory". If you only ever drive dsh interactively and remember to prompt it, the plugin's value is small — that's an honest trade-off.

## Install

The plugin is a single ESM file. No npm install needed.

1. Copy `index.js` anywhere on disk (e.g. `~/.dsh/plugins/dsh-memory-snapshot/index.js`).
2. Add a patch entry to your profile or home patch layer:

   `~/.dsh/cordis.patch.yml` (all profiles) or `~/.dsh/profiles/<name>/cordis.patch.yml` (one profile):

   ```yaml
   - insert:
       - id: memory-snapshot
         name: 'file:///C:/path/to/dsh-memory-snapshot/index.js'
         config:
           files:
             - '~/MEMORY.md'
             - 'C:/Proj/notes/context.md'
           maxBytes: 3000
           order: 50
           marker: 'MEMORY-SNAPSHOT'
   ```

3. Run `dsh --profile headless --dump-config` and confirm the `memory-snapshot` entry appears.

## Config

| Key | Default | Description |
|---|---|---|
| `files` | `['./MEMORY.md']` | Array of file paths to read. `~` expands to home. Relative paths resolve against cwd. |
| `maxBytes` | `3000` | Per-file byte cap before injection (protects system prompt size). |
| `order` | `50` | `systemPrompt.section` order — lower = earlier in prompt. |
| `marker` | `MEMORY-SNAPSHOT` | Marker text prefix (`<marker>-MARKER:` appears before the snapshot). |

Files that fail to read are reported inside the injected section instead of crashing the session. All paths support `~`.

## How it works

The plugin implements the Cordis plugin contract:

- `export const inject = ['systemPrompt']` — declares the section injection point
- `export const Config = { '~standard': { validate } }` — **zero-dependency** Standard Schema config validation (no zod), matching what Cordis expects via `Config['~standard'].validate(config)`
- `apply(ctx)` reads `ctx.plugin.config` (validated), loads each file (UTF-8, truncated to `maxBytes`), and registers a `systemPrompt.section`

The snapshot appears in the session's Trajectory log (`~/.dsh/sessions/<cwd>/<session-id>/session.jsonl.zstd`, event `request/header` `system` field) — so you can always audit exactly what the model received.

## Verify

```sh
# 1. write/read: run a session and confirm the marker is injected
dsh --profile headless "What is in your memory snapshot?"   # answer references your files

# 2. fresh-session recall: new session, ask something only your file knows
dsh --profile headless "According to memory, what is <fact in your file>?"

# 3. audit: decode the latest trajectory and see the snapshot in request/header.system
```

## License

MIT — see [LICENSE](LICENSE).