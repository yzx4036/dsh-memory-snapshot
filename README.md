# dsh-memory-snapshot

零依赖的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件：把本地 markdown/文本文件的快照注入**每一次会话的系统提示词**，作为轻量级长期记忆。

> ⚠️ dsh 处于开发者预览阶段（v0.1.0-rc.x）。插件 API 可能随版本破坏性变更，升级前留意 [breaking changes](https://github.com/deepseek-ai/deepseek-harness/releases)。

## 为什么

dsh 官方的记忆方案是 MCP 接入第三方服务（[Memorix](https://github.com/AVIDS2/memorix)、[Engram](https://github.com/Gentleman-Programming/engram)、[MCP Reference Memory](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)）——全部默认关闭、官方明确不背书，而且每个都要安装服务端/数据库/模型账户。

这个插件覆盖最朴素的需求：**读你已经有的 markdown 文件**。不需要服务端、不需要数据库、不需要模型、不需要账户。指向 `MEMORY.md`、`NOTES.md`、知识库——完事。

### 为什么要插件？dsh 自己就能读 markdown。

问得好。dsh 自带 `read`/`glob` 工具，你随时可以提示它「读一下 ~/MEMORY.md」。差别在于**谁来决定记忆被消费**：

| | 不用插件（被动） | 用插件（主动） |
|---|---|---|
| 记忆在场 | 只有你提示它，或模型碰巧决定读 | **每次会话都无条件在系统提示词里** |
| headless / 自动化调用 | 没有人在中间说「查一下记忆」 | 记忆默认在场，调用方零改动 |
| 工作区范围 | AGENTS.md 自动加载**只限工作区内**（且只是 user 层低级别 reminder，实机验证过） | 插件可指向**任意路径**，工作区之外也行 |
| 每次任务成本 | 多一轮工具调用往返，读多读少看模型心情 | 固定快照，`maxBytes` 截断，Trajectory 里格式统一 |
| 可靠性 | 模型可能只扫 200 字节就开干 | 每次都是完整可控的快照 |

所以这个插件不是给 dsh 加「读文件能力」——它本来就有。而是把记忆从**「可能被想起」变成「必然在场」**。主战场是无人值守场景：headless 批量、自动化流水线、多 agent 协作——这些地方没有人类在中间说「查一下记忆」。如果你只交互式使用 dsh 且记得每次提示它，这插件的价值有限——这是诚实的取舍。

## 安装

### 一键安装（推荐）

```bash
node install.mjs                    # 装到 home 层，所有 profile 生效
node install.mjs --profile headless # 只装到指定 profile
node install.mjs --files A.md,B.md  # 同时配置初始记忆文件
node install.mjs --yes              # 跳过确认
node install.mjs --verify           # 装完自动跑 dsh --dump-config 校验
```

脚本会自动：
1. **定位 DSH_HOME**（`$DSH_HOME` 环境变量 → 回退 `~/.dsh`）
2. 复制 `index.js` + `package.json`（ESM 声明）到 `$DSH_HOME/plugins/dsh-memory-snapshot/`
3. **合并** cordis patch——绝不覆盖你已有内容：空文件直接写、有内容追加、已装过跳过（幂等）

### 手动安装

1. 把 `index.js` 复制到任意位置（如 `~/.dsh/plugins/dsh-memory-snapshot/index.js`）
2. 在 `~/.dsh/cordis.patch.yml`（所有 profile）或 `~/.dsh/profiles/<name>/cordis.patch.yml`（单 profile）加：

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

3. 运行 `dsh --profile headless --dump-config` 确认 `memory-snapshot` 出现

## 配置

| 键 | 默认值 | 说明 |
|---|---|---|
| `files` | `['./MEMORY.md']` | 要读取的文件路径数组。`~` 展开为 home；相对路径按 cwd 解析 |
| `maxBytes` | `3000` | 每个文件注入前的字节上限（保护系统提示词体积） |
| `order` | `50` | `systemPrompt.section` 顺序——越小越靠前 |
| `marker` | `MEMORY-SNAPSHOT` | 标记文本前缀（快照前出现 `<marker>-MARKER:`） |

读取失败的文件会在注入段里标注原因，而不是让会话崩溃。所有路径支持 `~`。

## 工作原理

插件实现 Cordis 插件契约：

- `export const inject = ['systemPrompt']` — 声明注入点
- `export const Config = { '~standard': { validate } }` — **零依赖** Standard Schema 配置校验（不引入 zod），匹配 Cordis 的 `Config['~standard'].validate(config)` 约定
- `apply(ctx, config)` — **config 作为第二个参数传入**（Cordis 对象插件约定，实测 `ctx.plugin.config` 取不到），读取每个文件（UTF-8、按 `maxBytes` 截断），注册 `systemPrompt.section`

快照会出现在会话的 Trajectory 日志里（`~/.dsh/sessions/<cwd>/<session-id>/session.jsonl.zstd`，`request/header` 事件的 `system` 字段）——模型到底收到什么，永远可审计。

## 验证

```sh
# 1. 写入/读取：跑一个会话确认 marker 注入
dsh --profile headless "你的记忆快照里有什么？"   # 回答应引用你的文件

# 2. 新会话回忆：新开会话，问只有你文件里才知道的事
dsh --profile headless "根据记忆，<你文件里的事实>是什么？"

# 3. 审计：解码最新轨迹，在 request/header.system 里看到快照
```

## License

MIT — 见 [LICENSE](LICENSE)。

[English](README.en.md)