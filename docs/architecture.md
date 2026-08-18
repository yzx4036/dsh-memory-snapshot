# architecture — dsh-memory-snapshot

> as-built 架构。开发规则见仓库根 `AGENTS.md`；安装/用法见 `../README.md`。

## 这是什么

零依赖的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）Cordis 插件。宗旨：用户通常已在用其他 Agent 工具（Codex、Claude Code、Hermes、OpenCode 等），各自积累了约束规则或长期记忆等 markdown 文档，散在不同目录；或攒了一套知识库仓库，里面存着想随时注入的规则、文档、知识。本插件把这些文档路径列进 `files`，dsh 每次会话装配系统提示词时全文注入，跨工作区生效（home 级安装 + 绝对路径）。单向只读，不写回文件。原版 dsh 的 AGENTS.md 自动加载只覆盖 `~/.dsh/AGENTS.md`（全局单文件）和项目目录链，读不到其他工具的全局文档。

定位：dsh 没有内置全局记忆（官方 50+ 包无 memory 包，用户文档无记忆章节，2026-08 核对）。社区记忆插件（dsh-statecore / Nowledge Mem / Hindsight）走「记忆引擎」路线——服务 + 数据库 + 自动吸收蒸馏，能力强但重。本插件在另一极：已有文档不动、原地注入。无引擎、无数据库、无写入通道，只读注入。

## 组成

```
dsh-memory-snapshot/
├── src/index.ts    # 插件本体（TypeScript 源码）：函数形式 Cordis 插件（name/inject/apply + Config schema）
├── dist/           # tsc 构建产物，入库（用户 clone 即用，无需 toolchain）
├── install.mjs     # 一键安装器：复制插件 + 合并 cordis.patch 到 DSH_HOME
├── package.json    # npm 包声明：exports/engines/scripts（可发布，见下）
├── README.md       # 中文主文档（含英文版链接）
├── README.en.md    # 英文文档
├── tests/          # 自动化测试（test.mjs）+ 手动验收步骤（MANUAL-TEST.md）
└── docs/
    ├── architecture.md   # 本文：as-built 架构
    └── forge-brief.md    # 早期 onboarding 快照（历史文档，内容以本文为准）
```

## 插件本体（index.js）

按官方插件标准（`docs/user/develop/basic/index.md` 函数形式）组织：

```js
export const name   = 'dsh-memory-snapshot'
export const inject = ['systemPrompt']   // 依赖 systemPrompt 服务才加载
export const Config = { '~standard': { validate } }
export function apply(ctx, config) { /* ... */ }
```

### 关键契约点

1. **`apply(ctx, config)`，config 是第二参数** —— Cordis 对象/函数插件约定，config 由 schema 校验合并后作为第二参数传入，不是 `ctx.plugin.config`。本插件直接消费第二参数。
2. **`inject = ['systemPrompt']`** —— 声明依赖。dsh 的 `systemPrompt` 是注册在 `@deepseek-ai/cordis` `Context` 上的服务（实测源：`packages/core/system-prompt/src/index.ts`）。框架等它就绪才加载本插件。
3. **`Config` 是手写的 Standard Schema（`~standard` 接口）** —— 关键决策：官方 `docs/user/develop/basic/config.md` 明说「不要导出普通对象当 Config」，但 zod / Schemastery 内部实现的正是 `~standard` 接口。本插件直接实现该接口，零依赖同时合法。schema 负责填充默认值，所以 `apply` 拿到的 config 是完整的。
4. **`ctx.systemPrompt.section({ name, order, text })`** —— 与官方 `PromptSection` 签名完全一致。`text` 用 provider 函数 `(context) => string`，每次装配时才读文件，因此编辑记忆文件后无需重载插件就能反映到下次会话。section 注册由 Cordis 在插件卸载时自动清理（effect disposer）。
5. **order 约定** —— 官方约定 persona=0、工具指引占 100–199；本插件默认 `order: 50`，落在 persona 之后、工具指引之前，合理。

### Config 字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `files` | `['./MEMORY.md']` | 读的文件路径数组，`~` 展开，相对路径按 cwd。校验为 string 数组正失败 |
| `maxBytes` | `3000` | 每文件注入前字节上限；校验为正有限数否则加载即失败 |
| `order` | `50` | `systemPrompt.section` 顺序 |
| `marker` | `MEMORY-SNAPSHOT` | 快照前标记 `<marker>-MARKER:` |

校验失败走「fail loudly」路线（`config.md` 原则）：`validate` 返回 `issues`，Cordis 在加载期报错，而不是运行时坏配置悄悄发生。

## 安装模型（install.mjs）

本地文件复制 + cordis.patch 合并，两条路径不变更用户已有内容：

1. 定位 DSH_HOME（`$DSH_HOME` → `~/.dsh`）
2. 复制 `index.js` + 最小 `package.json`（`"type":"module"`）到 `$DSH_HOME/plugins/dsh-memory-snapshot/` —— ESM 声明避免 `MODULE_TYPELESS_PACKAGE_JSON` 警告
3. 合并 cordis patch：空文件直接写、有内容追加、装过跳过

patch 里 `name` 用 `file:///` URL 指向复制后的 `index.js`（`pathToFileURL`，Windows 反斜杠会炸）。可 `--profile <name>` 只装单个 profile，`--verify` 先 `node --check` 复制产物再 `dsh --dump-config` 确认入口。

install.mjs 两个实测修过的坑：

- **「空 patch」判定要穿注释** —— dsh 新建的 profile patch 是「注释头 + `[]`」占位。若只认 `''`/`'[]'` 为「空」，带注释的 `[]` 会走「追加」路径，产出 `[]\n- insert:` 的非法 YAML（boot 报 `YAMLException`）。现在先剥离注释行再判定为「空则整体替换」。
- **`--verify` 的 dsh 调用要 `shell:true`** —— Windows 上 `dsh` 是 PATH shim（fnm/nvm），裸 `spawnSync` 直接起不来（status null）。走 shell 且用固定 flag 命令串（无用户输入注入面）。

另一个注意：`memory-snapshot` 别同时装到 home 层和某个 profile 层 —— 两行同 `id` 会让 `dsh` boot 报 `duplicate loader entry id`。要么装 home（全局），要么装指定 profile，二选一。`install.mjs` 只对**当前合并的 patch 文件**去重，不跨层检查。

## npm 发布评估

本插件**当前以 install.mjs 为主路径**，但结构上可按 npm 发布（`package.json` 已配 `exports/engines/scripts`，`files` 收录插件与文档）。

- **不发布**（当前推荐）：零依赖卖点是「拿过去就能用」。install.mjs 免注册表、免 `dsh plugin add`，对单文件小插件最省事。
- **发布**（未来可选）：若走官方 `dsh.bundle` 路线，需在仓库根加 `cordis.patch.yml`（patch 用包名而非 `file:///`）+ `dsh.bundle.patch` 声明，然后 `dsh plugin add dsh-memory-snapshot`。参考 `docs/user/develop/basic/publish.md` 与 dsh-TUI 仓库。

两套路径 patch 引用方式不同（`file:///` vs 包名），互不冲突，选一条主线即可。

## 验证

```bash
npm run check                      # node --check index.js + install.mjs
npm run smoke                      # dsh --profile headless --dump-config | grep memory-snapshot
node install.mjs --verify          # 复制后自检（--check + dump-config）
dsh --profile headless "你的记忆快照里有什么？"   # 实机会话验证
```

注入内容进会话 Trajectory 日志（`~/.dsh/sessions/<cwd>/<session>/session.jsonl.zstd`，`request/header.system`），可审计模型实际吃了什么。
