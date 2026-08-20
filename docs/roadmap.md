# roadmap — dsh-memory-snapshot

> 迭代方向，按优先级排列。编号沿用规划时的序号。原则：保持零依赖、单向只读注入的定位；不做记忆引擎功能（自动吸收、蒸馏、检索、模型侧写回）。

## v0.1.2（已完成）

| # | 项目 | 说明 |
|---|------|------|
| 1 | maxBytes 真按字节截断 | 现状 `content.slice()` 按字符截断，中文内容实际注入字节数约为配置值 3 倍；改为 Buffer 按字节截断，不切断多字节字符 |
| 2 | 智能截断 | 触发截断时回退到最近的换行边界，并追加「…[已截断]」标记，让模型知道记忆不完整 |
| 4 | totalMaxBytes 总预算 | 新增配置：所有文件合计注入字节上限，超出按列表顺序跳过并标注，防多文件合计撑爆系统提示词 |

## 后续版本（按优先级）

| # | 项目 | 说明 |
|---|------|------|
| 3 | 目录支持 | `files` 允许写目录，自动收集其中 `*.md`，可配递归深度上限 |
| 5 | front-matter 剥离 | 剥掉文件头的 YAML front-matter 块，不白烧 token |
| 6 | 注入新鲜度标记 | section 头部带快照生成时间与各文件 mtime，供模型判断记忆可能过时 |
| 7 | skipMissing 选项 | 读取失败的文件静默跳过（多设备路径不一致场景），不注入错误文本 |
| 9 | install.mjs --uninstall/--update | 补卸载/更新路径 + 跨层（home/profile）duplicate id 预检 |
| 10 | CI | GitHub Actions：build + check + unit（e2e 依赖真实 dsh，单独 job 或跳过） |
| 8 | npm 发布（dsh.bundle 路线） | 等 dsh 插件 API 稳定后走 `dsh plugin add`；见 architecture.md「npm 发布评估」 |

## 明确不做

自动吸收对话、蒸馏、检索、模型侧写入通道——记忆引擎路线。社区已有 dsh-statecore 等选择，做了就丢掉本插件「零依赖、原地注入」的定位差异。
