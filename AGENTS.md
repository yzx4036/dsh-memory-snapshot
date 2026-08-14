# AGENTS.md — dsh-memory-snapshot 项目规则

> 给未来 agent 的项目须知。通读一遍即可开工；细化规则在链接的文档里，别在本文重复。

## 这是什么

零依赖的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）Cordis 插件：把本地 markdown 文件快照注入每个会话的系统提示词，当长期记忆。不装服务、不建库、不用模型账户。

改代码前先读官方插件开发文档：`https://github.com/deepseek-ai/deepseek-harness` 的 `docs/user/develop/basic/`（index/config/publish）+ `packages/core/system-prompt/src/index.ts`（`systemPrompt` 服务真实签名，本文据此核对）。拿不准先读文档再写。

## 如何开发（插件 API 标准）

- 插件是**函数形式** Cordis 插件，命名导出 `name` / `inject` / `apply`（见 `basic/index.md`）：
  ```js
  export const name   = 'dsh-memory-snapshot'
  export const inject = ['systemPrompt']
  export const Config = { '~standard': { validate } }
  export function apply(ctx, config) { ... }
  ```
- `inject` 声明服务依赖；`systemPrompt` 是注册在 `@deepseek-ai/cordis` `Context` 上的服务。等它就绪才加载。
- `Config` 用手写 Standard Schema 接口（`~standard`），**零依赖、合法**。zod/Schemastery 只是这接口的包装。schema 填充默认值 → `apply` 收到的 config 是完整合并后的。
- 调用 `ctx.systemPrompt.section({ name, order, text })` 注入 section，签名见 `packages/core/system-prompt` 的 `PromptSection`。`text` 可用 provider 函数 `(context) => string`，每次装配时才算。
- 关键坑：`apply(ctx, config)` 的 **config 是第二参数**，不是 `ctx.plugin.config`。

## 如何构建 / 验证

```bash
npm run check       # node --check index.js + install.mjs（语法）
npm run smoke       # dsh --profile headless --dump-config | grep memory-snapshot
node install.mjs --verify   # 复制后自检（--check 复制产物 + dump-config）
dsh --profile headless "你的记忆快照里有什么？"  # 实机会话验证
```

改动后至少跑 `npm run check` + `npm run smoke`。无测试框架，验证靠上面的命令 + 实机会话。

## 文档规范

- `README.md` 中文为主，语言链接放开头，口语化、去 AI 味（忌「此外/值得一提的是」）。`README.en.md` 是对应英文版，改中文要同步。
- as-built 架构在 `docs/architecture.md`；早期 onboarding 在 `docs/forge-brief.md`（历史保留，不以它为准）。
- 文档写当前状态，不写「之前/现在/后来」的变化叙事。
- 代码/文档明确禁止出现「小贤哥」称呼。

## git 提交规范

- 格式：`[type] 中文摘要`，如 `[feat]` / `[fix]` / `[docs]` / `[refactor]`。
- 只 stage 本意文件，不提交本地验证材料/绝对路径/个人信息。

## 关键坑

1. **`apply(ctx, config)` 第二参数** —— Cordis 对象/函数插件约定，`ctx.plugin.config` 实测为空，别用。
2. **`package.json` 要 `"type": "module"`** —— 安装到 `$DSH_HOME/plugins/` 时也写最小 ESM package.json，否则 `MODULE_TYPELESS_PACKAGE_JSON` 警告。
3. **Windows 路径用 `file:///` URL**（`pathToFileURL`）—— patch 里 `name` 反斜杠会炸。
4. **build 环境零依赖** —— 别顺手引入第三方包；若官方标准硬性要求依赖才加，且要在 README/架构说明理由，别悄悄引。
