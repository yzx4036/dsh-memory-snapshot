# dsh-memory-snapshot

[English](README.en.md)

零依赖的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件：把本地 markdown 文件的快照注入每次会话的系统提示词，当长期记忆用。

> dsh 还是开发者预览版（v0.1.0-rc.x），插件 API 可能随版本变化，升级前看 [breaking changes](https://github.com/deepseek-ai/deepseek-harness/releases)。

## 为什么做

dsh 官方记忆方案是走 MCP 接第三方服务（[Memorix](https://github.com/AVIDS2/memorix)、[Engram](https://github.com/Gentleman-Programming/engram)、[MCP Reference Memory](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)），默认全关，官方也不背书，装一个还得配服务端、数据库、模型账户。

这个插件只做一件事：读你手头已有的 markdown 文件。不装服务，不建库，不用模型账户。指向 `MEMORY.md`、`NOTES.md` 或知识库，就行。

### 那 dsh 自己就能读文件，要插件干嘛？

dsh 确实自带 read/glob 工具，你也能让它「读 ~/MEMORY.md」。区别在于谁主动：

- 不用插件：记忆要不要被读，取决于你提没提，或者模型想不想起来
- 用插件：每个会话系统提示词里都有，不用谁提醒

差在无人值守场景。headless 批量、自动化流水线、多 agent 协作，这些地方没人中途说「去看下记忆」，插件是唯一让记忆默认在场的办法。另外 AGENTS.md 自动加载只覆盖工作区内（层级也低），插件能指任意路径。要是你只手动用 dsh、每次都会提一句，那这插件用处不大——话放这了。

## 安装

```bash
node install.mjs        # 一键装好（自动找 DSH_HOME、复制插件、写入配置）
```

> 其他选项：`--profile headless` 只装某 profile；`--files A.md,B.md` 顺带配记忆文件；`--verify` 装完自检。别同时装 home 和 profile 两层，会报 `duplicate loader entry id`——二选一。

## 使用

装完即生效——**dsh 每次会话自动带着你的记忆文件**，不用任何额外操作：

```bash
dsh --profile headless "你的记忆快照里有什么？"
```

想换记忆源：改 `~/.dsh/cordis.patch.yml` 里 `memory-snapshot` 的 `files`，指向你的 markdown 文件（支持 `~`），重启 dsh 生效。

常见配置：

- `files`：记忆文件路径，默认 `['./MEMORY.md']`，可多个
- `maxBytes`：每个文件注入上限，默认 3000，防系统提示词撑爆
- `order`：section 顺序，默认 50
- `marker`：标记前缀，默认 `MEMORY-SNAPSHOT`

读不到的文件会标出原因，不会让会话崩。

## 原理

就是个 Cordis 插件（函数形式）：`inject = ['systemPrompt']` 声明注入点；`Config` 实现 `~standard` 接口做配置校验（不引 zod，零依赖）；`apply(ctx, config)`——config 是第二个参数（`ctx.plugin.config` 是空的）；`text` 用 provider 函数每次装配重读文件——改记忆文件下次会话就生效。

注入内容进 Trajectory 日志（`~/.dsh/sessions/<cwd>/<session-id>/session.jsonl.zstd` 的 `request/header.system`），模型到底吃了什么随时能查。开发细节见 [docs/architecture.md](docs/architecture.md)。

## 测试

```bash
npm test                # 21 条自动化测试（含真实 dsh 会话）
```

手动验收（可选，详细 7 步见 [docs/MANUAL-TEST.md](docs/MANUAL-TEST.md)）：

```sh
dsh --profile headless "你的记忆快照里有什么？"
# 新开会话问：根据记忆，<你文件里的事实>是什么？
# 想看得更细就解最新轨迹日志，request/header.system 里有快照
```

## License

MIT — [LICENSE](LICENSE)。