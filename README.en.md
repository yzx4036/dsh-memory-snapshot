# dsh-memory-snapshot

[中文文档](README.md)

Zero-dependency lightweight snapshot (memory) injection plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). The whole point in one line: **the important markdown documents you've built up in Codex, Claude Code, Hermes, OpenCode and other Agent tools — constraint rules, long-term memory, or content from a knowledge-base repo — scattered across different directories. List their paths here, and dsh proactively injects them into every session, across all workspaces.** No moving files, no duplicate copies, no reminding the model to read them.

> dsh is still in developer preview. Plugin APIs may change between releases — check the [breaking changes](https://github.com/deepseek-ai/deepseek-harness/releases) before upgrading.

## Why

dsh has no built-in global memory. Its AGENTS.md auto-load reads exactly one global file — `~/.dsh/AGENTS.md` — and workspace-level only walks the project directory chain; global documents of other tools (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`) are never read (checked against the official repo in 2026-08).

But most dsh users already run other Agent tools, or keep a knowledge-base repo — the rules, memory and knowledge inside are all markdown, already the seed of cross-session global memory; dsh just doesn't know they exist.

The community has other memory plugins, but they're all built as "memory engines": auto-ingest, distillation, retrieval, plus services and databases to set up — pretty heavy. If your existing markdown documents are exactly the memory you need, that's a sledgehammer to crack a nut.

So this plugin takes the light path: **documents stay put, injected in place**. List the paths in `files`, and every session's system prompt carries them in full. No engine, no database, no write path, about 150 lines of plugin body.

Of course you could also tell dsh to read the files manually each time, but in headless batches and automation pipelines where nobody is around, the plugin keeps memory present by default. If you only drive dsh interactively and always remember to prompt it, this plugin won't do much for you — saying so up front.

## What it does, and what it doesn't

Does:

- One or more md files, any directory (`~` supported), injected in full at every prompt assembly
- Edits take effect next session
- Per-file byte cap (`maxBytes`) so the system prompt can't blow up
- Unreadable files are reported with the reason; the session never crashes
- Injected content lands in the Trajectory log — you can always audit what the model received

Doesn't (need these → look at the memory-engine plugins):

- No auto-recording of conversations — you maintain the files yourself
- No write tools for the model — it never writes into your files
- No retrieval or distillation — full-text injection; big files just burn tokens, so this suits curated KB-sized content

## Install

```bash
node install.mjs        # one command: locate DSH_HOME, copy the plugin, write config
```

> Other options: `--profile headless` installs into one profile only; `--files A.md,B.md` also configures the memory files; `--verify` runs a self-check after install. Don't install at both home and profile levels — you'll hit `duplicate loader entry id`; pick one.

## Usage

It works as soon as installed — every dsh session automatically carries your documents:

```bash
dsh --profile headless "What is in your memory snapshot?"
```

To change memory sources, edit `files` under the `memory-snapshot` entry in `~/.dsh/cordis.patch.yml`, list your document paths, and restart dsh.

Common config:

- `files`: list of document paths, default `['./MEMORY.md']`, multiple allowed. **For cross-workspace effect use absolute paths or `~`** — relative paths resolve against dsh's launch directory, so each workspace ends up looking for its own copy
- `maxBytes`: per-file injection cap, default 3000 bytes
- `order`: section order, default 50
- `marker`: marker prefix, default `MEMORY-SNAPSHOT`

> Cross-workspace = installed at home level `~/.dsh/cordis.patch.yml` (install.mjs default) + absolute paths in files. With both in place, dsh carries these documents no matter which directory you launch it from. One-way and read-only: dsh never writes back to these files, and your other Agent tools don't notice the injection.

## How it works

A function-style Cordis plugin: `inject = ['systemPrompt']` declares the injection point; `Config` implements the `~standard` interface directly for validation (no zod); `text` uses a provider function, so files are re-read at every assembly. Development details in [docs/architecture.md](docs/architecture.md).

## Test

```bash
npm test                # 21 automated tests (including a real dsh session)
```

Manual acceptance (optional, full 7 steps in [tests/MANUAL-TEST.md](tests/MANUAL-TEST.md)):

```sh
dsh --profile headless "What is in your memory snapshot?"
```

## License

MIT, see [LICENSE](LICENSE).
