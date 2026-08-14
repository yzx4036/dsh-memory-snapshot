# dsh-memory-snapshot

[中文文档](README.md)

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

```bash
node install.mjs        # one command: locate DSH_HOME, copy plugin, write config
```

> Options: `--profile headless` installs only that profile; `--files A.md,B.md` also sets initial memory files; `--verify` self-checks after install. Don't install into both home and a profile — dsh fails to boot with `duplicate loader entry id`. Pick one.

## Usage

Installed = active. **Every dsh session now carries your memory files automatically** — nothing else to do:

```bash
dsh --profile headless "What is in your memory snapshot?"
```

To change memory sources, edit `files` under the `memory-snapshot` entry in `~/.dsh/cordis.patch.yml` (paths support `~`), restart dsh.

Config:

- `files`: memory file paths, default `['./MEMORY.md']`, multiple allowed
- `maxBytes`: per-file byte cap, default 3000, protects system prompt size
- `order`: section order, default 50
- `marker`: marker prefix, default `MEMORY-SNAPSHOT`

Files that fail to read are reported inside the injected section — the session never crashes.

## How it works

The plugin implements the Cordis plugin contract (function form):

- `export const inject = ['systemPrompt']` — declares the section injection point; the framework loads the plugin only after the `systemPrompt` service is ready
- `export const Config = { '~standard': { validate } }` — **zero-dependency** Standard Schema config validation (no zod). zod / Schemastery are wrappers over this same interface, so implementing it directly is legal and dependency-free; matching what Cordis expects via `Config['~standard'].validate(config)`
- `apply(ctx, config)` — **config arrives as the second argument** (Cordis object/function-plugin convention; verified empirically that `ctx.plugin.config` is not populated)
- `text` is a **provider function** `(context) => string`, re-read at each prompt assembly — edit a memory file without reloading the plugin, and the change shows next turn

The snapshot appears in the session's Trajectory log (`~/.dsh/sessions/<cwd>/<session-id>/session.jsonl.zstd`, event `request/header` `system` field) — so you can always audit exactly what the model received. Dev details: [docs/architecture.md](docs/architecture.md).

## Test

```bash
npm test                # 21 automated tests (incl. real dsh session)
```

Optional manual acceptance (7-step details: [docs/MANUAL-TEST.md](docs/MANUAL-TEST.md)):

```sh
dsh --profile headless "What is in your memory snapshot?"
```

## License

MIT — see [LICENSE](LICENSE).