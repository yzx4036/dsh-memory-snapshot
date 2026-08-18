# forge-brief — dsh-memory-snapshot

> 生成：2026-08-14 · 来源：OpenCode /forge-onboard 逆向
>
> 历史快照，定位描述已过时——当前宗旨（注入其他 Agent 工具散落的 markdown 文档，跨工作区生效）与生态对比以 ../README.md、architecture.md 为准。

## 项目概述

零依赖的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件：把本地 markdown 文件快照注入每次会话的系统提示词，当长期记忆用。

定位：dsh 官方记忆方案是 MCP 接第三方服务（Memorix/Engram，默认全关、不背书），本插件只做一件事——读你手头已有的 markdown 文件。不装服务、不建库、不用模型账户。

## 技术栈

- Node.js ESM（JavaScript，零第三方依赖）
- Cordis 插件机制（`inject`/`Config`/`apply` 契约）
- 手写 Standard Schema（`~standard`）配置校验，不引 zod

## 仓库结构

| 文件 | 职责 |
|---|---|
| `index.js` | 插件本体（~109 行）。`inject=['systemPrompt']`，`apply(ctx, config)` 读文件、按 `maxBytes` 截断、注册 systemPrompt section |
| `install.mjs` | 一键安装器。自动找 DSH_HOME，复制插件 + 合并 cordis.patch.yml（不覆盖已有内容），支持 `--profile/--yes/--verify/--files` |
| `README.md` / `README.en.md` | 中英双语文档（中文为主，英文链接在开头） |
| `verify-overlay.yml` | 验证用（gitignore） |
| `test-memory.md` | 测试用，含验证口令（gitignore） |
| `.gitignore` | 忽略 verify-overlay.yml、test-memory.md、docs/.hermes、node_modules |

## 入口点 / 运行方式

```bash
# 安装（用户侧）
node install.mjs [--profile <name>] [--files A.md,B.md] [--yes] [--verify]

# 插件生效验证
dsh --profile headless --dump-config | grep memory-snapshot
dsh --profile headless "你的记忆快照里有什么？"
```

## 关键设计决策（as-built）

1. **`apply(ctx, config)` 的 config 是第二个参数**——Cordis 对象插件约定，`ctx.plugin.config` 实测是空的（已踩坑，代码双兜底）
2. **安装时写最小 package.json**（`"type": "module"`）——否则 Node 报 `MODULE_TYPELESS_PACKAGE_JSON` 警告
3. **Windows 路径转 `file:///` URL**（`pathToFileURL`）——plugin loader 要求，反斜杠会炸
4. **patch 合并不覆盖用户内容**——空文件直接写、有内容追加、装过跳过
5. 配置项：`files`（默认 `['./MEMORY.md']`，支持 `~`）、`maxBytes`（默认 3000）、`order`（默认 50）、`marker`（默认 `MEMORY-SNAPSHOT`）

## 版本注意

dsh 处于 v0.1.0-rc.x 开发者预览期，插件 API 可能破坏性变更，升级前看 breaking changes。

## 仓库状态

- master 分支 5 个提交（feat + fix + docs），历史干净（无个人信息/称呼）
- 提交规范：`[type] 中文摘要`（`[feat]`/`[fix]`/`[docs]`）
- 代码总量约 300 行，小项目，新 agent 入口浅