# 手动测试步骤 — dsh-memory-snapshot

> 给在真实环境亲手验证的人。自动化测试（`npm test`）跑不过的覆盖这里全部人工过一遍。
> 环境：Windows + git-bash，dsh v0.1.0-rc.x 已全局安装。

## 0. 准备

```bash
cd <dsh-memory-snapshot 目录>
npm run build        # 构建 dist/
```

## 1. 一键安装（install.mjs）

```bash
node install.mjs --yes
```

**预期**：
```
copied index.js + package.json -> C:\Users\<你>\.dsh\plugins\dsh-memory-snapshot/
patch        : memory-snapshot entry appended...（或 already installed）
```

**手动验证点**：
- [ ] 输出显示复制到 `$DSH_HOME/plugins/dsh-memory-snapshot/`
- [ ] `ls ~/.dsh/plugins/dsh-memory-snapshot/` 能看到 `index.js` + `package.json`
- [ ] `cat ~/.dsh/cordis.patch.yml` 含 `memory-snapshot` 条目（且**你原有的其他插件条目还在**，没被覆盖）

**边界验证**：
- [ ] 再跑一次 `node install.mjs --yes` → 应显示 `already installed`（不重复追加）
- [ ] `node install.mjs --profile headless` → patch 写到 `~/.dsh/profiles/headless/cordis.patch.yml`（如果之前 home 装了，profile 层单独出现 "duplicate" 是**预期**——README 里写了二选一）

## 2. 插件被 dsh 装载

```bash
dsh --profile headless --dump-config | grep memory-snapshot
```

**预期**：能看到类似
```
- id: memory-snapshot
  name: file:///C:/Users/<你>/.dsh/plugins/dsh-memory-snapshot/index.js
```

**手动验证点**：
- [ ] `memory-snapshot` 条目出现（id + name + config）

## 3. 记忆真的注入系统提示词（核心）

```bash
dsh --profile headless "你的记忆快照里有什么？只说明来自哪些文件。"
```

**预期**：回答引用你的记忆文件（如 `MEMORY.md`），不是瞎编。

**手动验证点**：
- [ ] 模型提到你的记忆文件路径
- [ ] 换一个问题（如问记忆里的具体事实），仍能答出 → 说明快照在系统提示词里

## 4. Trajectory 审计（铁证）

```bash
# 找到最新会话日志
ls -t ~/.dsh/sessions/--C-Users-Administrator-dsh-memory-snapshot--/ | head -1
# 用 Python 解 zstd 日志看系统提示词
python -c "
import json,glob,os,zstandard
files=glob.glob(r'C:\Users\<你>\.dsh\sessions\*\*\session.jsonl.zstd')
files.sort(key=os.path.getmtime)
data=zstandard.ZstdDecompressor().stream_reader(open(files[-1],'rb')).read()
for line in data.decode('utf-8','replace').splitlines():
    try: ev=json.loads(line)
    except: continue
    if ev.get('type')=='request/header':
        print('含记忆快照:', 'MEMORY-SNAPSHOT-MARKER' in ev['data']['header'].get('system',''))
        break
"
```

**预期**：`含记忆快照: True`

**手动验证点**：
- [ ] 输出 `True`
- [ ] （可选）把 system 字段打出来，能看到 `MEMORY-SNAPSHOT-MARKER: ...` 和你的记忆文件内容

## 5. 改记忆文件后不重启也能生效

```bash
echo "# 新记忆行" >> <你的记忆文件>
dsh --profile headless "记忆快照里有'新记忆行'吗？只回答有/没有。"
```

**预期**：回答「有」——因为 text 是 provider 函数，每次装配重读文件。

**手动验证点**：
- [ ] 回答「有」（如果答没有，说明部署的是旧产物——重新 `npm run build` + `node install.mjs`）

## 6. 边界：读不到的文件不崩

```bash
# 临时把 patch 里的 files 指向一个不存在的文件，重启 dsh
dsh --profile headless "记忆快照加载状态如何？"
```

**预期**：会话不崩，注入段显示 `MEMORY-SNAPSHOT-ERROR: 无法读取任何记忆文件...`（或部分失败标注）

**手动验证点**：
- [ ] dsh 正常跑完，不报错退出
- [ ] 模型能说出「记忆文件读取失败」的原因

## 7. 反装（卸载）

```bash
# 从 ~/.dsh/cordis.patch.yml 删掉 memory-snapshot 条目（保留其他内容）
# 可选：删掉 ~/.dsh/plugins/dsh-memory-snapshot/
```

**手动验证点**：
- [ ] `dsh --profile headless --dump-config | grep memory-snapshot` 无输出
- [ ] 原有其他插件照常工作

---

## 验收标准汇总

| # | 步骤 | 通过标准 |
|---|------|----------|
| 1 | 安装 | 复制到 DSH_HOME/plugins + patch 追加不覆盖 |
| 2 | 装载 | dump-config 有 memory-snapshot |
| 3 | 注入 | 模型答出记忆文件内容 |
| 4 | 审计 | Trajectory 系统提示词含 marker |
| 5 | 热更新 | 改文件后新会话立即生效 |
| 6 | 容错 | 读不到文件不崩会话 |
| 7 | 卸载 | 移除条目后消失，其余插件不受影响 |