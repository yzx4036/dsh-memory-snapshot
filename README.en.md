# dsh-memory-snapshot

[中文文档](README.md)

Zero-dependency lightweight snapshot (memory) injection plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). The whole point in one line: **the important markdown documents you've built up in Codex, Claude Code, Hermes, OpenCode and other Agent tools — constraint rules, long-term memory, or content from a knowledge-base repo — scattered across different directories. List their paths here, and dsh proactively injects them into every session, across all workspaces.** No moving files, no duplicate copies, no reminding the model to read them.

> **Compatibility**: requires dsh **0.2.x** (verified against 0.2.0-rc.2: assembly, injection, literal `{{}}` preservation). Earlier versions interpolate `{{variable}}` refs in section text with no opt-out — a memory file containing `{{name}}` fails the session. dsh is still in developer preview: check the [breaking changes](https://github.com/deepseek-ai/deepseek-harness/releases) before upgrading.

## Why

dsh has no built-in global memory. Its AGENTS.md auto-load reads exactly one global file — `~/.dsh/AGENTS.md` — and workspace-level only walks the project directory chain; global documents of other tools (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`) are never read (checked against the official repo in 2026-08).

But most dsh users already run other Agent tools, or keep a knowledge-base repo — the rules, memory and knowledge inside are all markdown, already the seed of cross-session global memory; dsh just doesn't know they exist.

The community has other memory plugins, but they're all built as "memory engines": auto-ingest, distillation, retrieval, plus services and databases to set up — pretty heavy. If your existing markdown documents are exactly the memory you need, that's a sledgehammer to crack a nut.

So this plugin takes the light path: **documents stay put, injected in place**. List the paths in `files`, and every session's system prompt carries them in full. No engine, no database, no write path, about 150 lines of plugin body.

Of course you could also tell dsh to read the files manually each time, but in headless batches and automation pipelines where nobody is around, the plugin keeps memory present by default. If you only drive dsh interactively and always remember to prompt it, this plugin won't do much for you — saying so up front.

## What it does, and what it doesn't

Does:

- One or more md files or **directories** (`~` supported), injected in full at every prompt assembly; directory entries collect their `*.md` files (`dirDepth` controls recursion)
- Edits take effect next session
- Per-file byte cap (`maxBytes`), truncated by UTF-8 bytes, rolled back to a line boundary, with a "truncated" marker; plus a combined budget (`totalMaxBytes`) so many files together can't blow up the system prompt
- Leading YAML front-matter is stripped (`stripFrontMatter`); the snapshot header carries its build time and each file its mtime (`freshness`)
- Unreadable files are reported with the reason (or skipped silently via `skipMissing`); the session never crashes
- Injected content lands in the Trajectory log — you can always audit what the model received

Doesn't (need these → look at the memory-engine plugins):

- No auto-recording of conversations — you maintain the files yourself
- No write tools for the model — it never writes into your files
- No retrieval or distillation — full-text injection; big files just burn tokens, so this suits curated KB-sized content

## Install

Two mutually exclusive ways (**don't install at both levels** — the same `id` triggers `duplicate loader entry id`):

**A. `dsh plugin add` (profile-level, standard ecosystem path)**

```bash
dsh plugin --profile <your-profile> add dsh-memory-snapshot
# or straight from GitHub: dsh plugin --profile <your-profile> add github:yzx4036/dsh-memory-snapshot
```

Uninstall: `dsh plugin --profile <your-profile> remove dsh-memory-snapshot`

**B. `node install.mjs` (home-level, registry-free)**

```bash
node install.mjs        # one command: locate DSH_HOME, copy the plugin, write config
```

> Other options: `--profile headless` installs into one profile only; `--files A.md,B.md` also configures the memory files; `--verify` runs a self-check after install; `--update` refreshes plugin files only (keeps your config); `--uninstall` removes the files and the config entry; a cross-layer duplicate entry blocks installs (`--force` skips the precheck).

## Usage

It works as soon as installed — every dsh session automatically carries your documents:

```bash
dsh --profile headless "What is in your memory snapshot?"
```

To change memory sources, edit `files` under the `memory-snapshot` entry in `~/.dsh/cordis.patch.yml`, list your document paths, and restart dsh.

Common config:

- `files`: list of paths (files or directories), default `['./MEMORY.md']`, multiple allowed; directories collect their `*.md` children. **For cross-workspace effect use absolute paths or `~`** — relative paths resolve against dsh's launch directory, so each workspace ends up looking for its own copy
- `maxBytes`: per-file injection cap, default 3000 bytes (truncated by UTF-8 bytes, never splitting a multi-byte character, rolled back to a line boundary)
- `totalMaxBytes`: combined injection cap across all files, default `0` (no combined cap). When exceeded, files are skipped in `files` order and noted at the end
- `dirDepth`: directory recursion depth, default `1` (direct children only; `2` includes one subdirectory level). Dot-directories are skipped
- `skipMissing`: default `false` (missing entries are listed in a footnote); `true` skips them silently — for machines with different path layouts
- `freshness`: default `true` — the snapshot header carries its build time and every file header carries the file's mtime; `false` disables
- `stripFrontMatter`: default `true` — leading YAML front-matter blocks are stripped (unclosed blocks are kept); `false` preserves them
- `order`: section order, default 50
- `marker`: marker prefix, default `MEMORY-SNAPSHOT`

> Cross-workspace = installed at home level `~/.dsh/cordis.patch.yml` (install.mjs default) + absolute paths in files. With both in place, dsh carries these documents no matter which directory you launch it from. One-way and read-only: dsh never writes back to these files, and your other Agent tools don't notice the injection.

## How it works

A function-style Cordis plugin: `inject = ['systemPrompt']` declares the injection point; `Config` implements the `~standard` interface directly for validation (no zod); `text` uses a provider function, so files are re-read at every assembly. Development details in [docs/architecture.md](docs/architecture.md).

## Test

```bash
npm test                # 66 automated tests (unit 54 + e2e 12; live-session cases skip without credentials)
```

Manual acceptance (optional, full 7 steps in [tests/MANUAL-TEST.md](tests/MANUAL-TEST.md)):

```sh
dsh --profile headless "What is in your memory snapshot?"
```

## License

MIT, see [LICENSE](LICENSE).
