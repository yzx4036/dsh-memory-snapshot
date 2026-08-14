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

### 一键安装

```bash
node install.mjs                    # 装到 home，所有 profile 生效
node install.mjs --profile headless # 只装某个 profile
node install.mjs --files A.md,B.md  # 顺便配初始记忆文件
node install.mjs --yes              # 跳过确认
node install.mjs --verify           # 装完跑 dump-config 自检
```

脚本做的事：

1. 找 DSH_HOME（`$DSH_HOME` 环境变量，没有就用 `~/.dsh`）
2. 把 `index.js` 和 `package.json` 复制到 `$DSH_HOME/plugins/dsh-memory-snapshot/`
3. 合并 cordis patch——不动你已有的内容：空文件直接写，有内容就追加，装过的跳过

> 别把 `memory-snapshot` 同时装到 home 层和某个 profile 层——两个 `- id: memory-snapshot` 会让 dsh 启动报 `duplicate loader entry id`。要么装 home（全局生效），要么装指定 profile，二选一。

### 手动安装

1. 把 `index.js` 放到任意位置，比如 `~/.dsh/plugins/dsh-memory-snapshot/index.js`
2. 在 `~/.dsh/cordis.patch.yml`（所有 profile）或 `~/.dsh/profiles/<name>/cordis.patch.yml`（单个）加：

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

3. 跑 `dsh --profile headless --dump-config`，看到 `memory-snapshot` 就对了

## 配置

- `files`：要读的文件路径数组，默认 `['./MEMORY.md']`。`~` 会展开成 home，相对路径按 cwd 算
- `maxBytes`：每个文件注入前的字节上限，默认 3000，防止系统提示词撑爆
- `order`：`systemPrompt.section` 顺序，默认 50，越小越靠前
- `marker`：标记前缀，默认 `MEMORY-SNAPSHOT`，快照前会有一行 `<marker>-MARKER:`

读不到的文件会在注入段里标出原因，不会让会话崩。路径都支持 `~`。

## 原理

就是个 Cordis 插件（函数形式）：

- `inject = ['systemPrompt']` 声明注入点，等 `systemPrompt` 服务就绪才加载
- `Config` 实现 `~standard` 接口做配置校验，不引 zod —— zod / Schemastery 内部就是这接口的包装，直接实现即可合法且零依赖
- `apply(ctx, config)`——注意 config 是第二个参数（Cordis 对象/函数插件约定，实测 `ctx.plugin.config` 是空的）
- `text` 用 provider 函数，每次装配时重新读文件——改记忆文件不用重载插件，下次会话就生效

注入内容会进会话的 Trajectory 日志（`~/.dsh/sessions/<cwd>/<session-id>/session.jsonl.zstd`，看 `request/header` 的 `system` 字段），模型到底吃了什么，随时能查。开发细节见 [docs/architecture.md](docs/architecture.md)。

## 验证

```sh
dsh --profile headless "你的记忆快照里有什么？"
# 新开会话问：根据记忆，<你文件里的事实>是什么？
# 想看得更细就解最新轨迹日志，request/header.system 里有快照
```

## License

MIT — [LICENSE](LICENSE)。