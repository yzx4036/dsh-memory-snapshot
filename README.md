# dsh-memory-snapshot

[English](README.en.md)

零依赖的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）轻量快照（记忆）注入插件。宗旨：**你在 Codex、Claude Code、Hermes、OpenCode 等 Agent 工具里攒的重要 markdown 文档——约束规则、长期记忆，或者知识库仓库里的内容——散在不同目录，把路径列进来，dsh 每次会话都会主动注入，跨工作区生效**。不用迁文件、不用复制副本、不用提醒模型去读。

> dsh 还是开发者预览版（v0.1.0-rc.x），插件 API 可能随版本变化，升级前看 [breaking changes](https://github.com/deepseek-ai/deepseek-harness/releases)。

## 为什么做这个

dsh 没有内置的全局记忆。它的 AGENTS.md 自动加载全局只认 `~/.dsh/AGENTS.md` 这一个文件，工作区级只管项目目录链；其他工具的全局文档（`~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md`）dsh 完全不读（2026-08 核对官方仓库）。

但多数用 dsh 的人手里有别的 Agent 工具，或者攒了知识库仓库——里面的规则、记忆、知识都是 markdown，本来就是跨会话全局记忆的雏形，只是 dsh 不知道它们存在。

社区有别的记忆插件，但都是奔着「记忆引擎」做的：自动吸收、蒸馏、检索，还得配服务和数据库，比较重。如果已有的 markdown 文档就是你要的记忆，那就杀鸡用牛刀了。

所以这个插件走轻的：**文档不动、原地注入**。把路径列进 `files`，每次会话装配系统提示词时全文带进去。没有引擎，没有数据库，没有写入通道，本体约 150 行。

当然你也可以每次手动叫 dsh 读文件，但 headless 批量、自动化流水线这些没人盯着的场景，插件能让记忆默认在场。如果你只手动用 dsh、每次都提一句，那这插件对你用处不大。

## 能做什么，不能做什么

能做：

- 一个或多个 md 文件，任意目录（支持 `~`），每次会话装配提示词时全文注入
- 改完文件下次会话就生效
- 单文件字节上限（`maxBytes`），防系统提示词撑爆
- 读不到的文件标出原因，不崩会话
- 注入内容进 Trajectory 日志，模型吃了什么随时能查

不能做（要这些就去找记忆引擎插件）：

- 不会自动记录对话，文件要你自己维护
- 没有模型侧写入工具，模型不会自己往文件里写东西
- 不做检索和蒸馏，全文注入，内容多了白烧 token，只适合 KB 级的精选内容

## 安装

```bash
node install.mjs        # 一键装好（自动找 DSH_HOME、复制插件、写入配置）
```

> 其他选项：`--profile headless` 只装某个 profile；`--files A.md,B.md` 顺带配好记忆文件；`--verify` 装完自检。别同时装 home 和 profile 两层，会报 `duplicate loader entry id`，二选一。

## 使用

装完就生效，之后 dsh 每个会话都自动带着你的文档：

```bash
dsh --profile headless "你的记忆快照里有什么？"
```

想换记忆源：改 `~/.dsh/cordis.patch.yml` 里 `memory-snapshot` 条目的 `files`，把文档路径列进去，重启 dsh 生效。

常用配置：

- `files`：文档路径清单，默认 `['./MEMORY.md']`，可写多个。**跨工作区生效请用绝对路径或 `~`**——相对路径按 dsh 启动目录解析，会变成「每个工作区各找各的」
- `maxBytes`：单个文件注入上限，默认 3000 字节
- `order`：section 顺序，默认 50
- `marker`：标记前缀，默认 `MEMORY-SNAPSHOT`

> 跨工作区 = 装在 home 级 `~/.dsh/cordis.patch.yml`（install.mjs 默认如此）+ files 用绝对路径。满足这两条，任何目录起 dsh 都带着这些文档。单向只读：dsh 不会写回这些文件，其他 Agent 工具也不感知注入。

## 原理

函数形式的 Cordis 插件：`inject = ['systemPrompt']` 声明注入点；`Config` 直接实现 `~standard` 接口做配置校验（不引 zod）；`text` 用 provider 函数，每次装配都重读文件。开发细节见 [docs/architecture.md](docs/architecture.md)。

## 测试

```bash
npm test                # 21 条自动化测试（含真实 dsh 会话）
```

手动验收（可选，完整 7 步见 [tests/MANUAL-TEST.md](tests/MANUAL-TEST.md)）：

```sh
dsh --profile headless "你的记忆快照里有什么？"
```

## License

MIT，见 [LICENSE](LICENSE)。
