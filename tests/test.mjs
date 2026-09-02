#!/usr/bin/env node
// dsh-memory-snapshot — 自动化测试（npm run test）
// 零依赖：node 内置 assert + 顶层 await；不引入 jest/vitest。
//
// 用法：
//   node test.mjs            # 默认单元测试
//   node test.mjs unit       # 只跑单元
//   node test.mjs e2e        # 只跑端到端（需要真实 dsh）
//   node test.mjs all        # 单元 + 端到端
//
// 覆盖：
//  [unit] Config schema：合法/非法/默认合并
//  [unit] apply() + text provider：注入、重读、marker、读不到标错
//  [e2e]  dist 构建产物加载形状
//  [e2e]  真实 dsh：dump-config 含 memory-snapshot + 实机会话
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

// ROOT = 项目根（tests/ 的上一级），dist/ 在项目根
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[/\\]$/, '')
let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  [PASS] ${name}`)
  } catch (e) {
    failed++
    console.error(`  [FAIL] ${name}\n     ${e.message}`)
  }
}

async function loadPlugin() {
  const url = pathToFileURL(join(ROOT, 'dist', 'index.js')).href
  return import(url)
}

// ---------- unit: Config schema ----------
async function unitConfig() {
  const { Config } = await loadPlugin()
  test('Config 合法输入返回 value（默认合并）', () => {
    const r = Config['~standard'].validate({ files: ['a.md'] })
    assert.ok('value' in r)
    assert.deepEqual(r.value.files, ['a.md'])
    assert.equal(r.value.maxBytes, 3000)
    assert.equal(r.value.totalMaxBytes, 0)
    assert.equal(r.value.order, 50)
    assert.equal(r.value.marker, 'MEMORY-SNAPSHOT')
  })
  test('Config 空输入补全默认', () => {
    const r = Config['~standard'].validate(undefined)
    assert.ok('value' in r)
    assert.deepEqual(r.value.files, ['./MEMORY.md'])
  })
  test('Config files 非数组 → issues', () => {
    const r = Config['~standard'].validate({ files: 'x' })
    assert.ok('issues' in r)
  })
  test('Config files 元素非 string → issues', () => {
    const r = Config['~standard'].validate({ files: [1] })
    assert.ok('issues' in r)
  })
  test('Config maxBytes 负数 → issues', () => {
    const r = Config['~standard'].validate({ maxBytes: -1 })
    assert.ok('issues' in r)
  })
  test('Config maxBytes Infinity → issues', () => {
    const r = Config['~standard'].validate({ maxBytes: Infinity })
    assert.ok('issues' in r)
  })
  test('Config order 非法 → issues', () => {
    const r = Config['~standard'].validate({ order: 'high' })
    assert.ok('issues' in r)
  })
  test('Config marker 非法 → issues', () => {
    const r = Config['~standard'].validate({ marker: 123 })
    assert.ok('issues' in r)
  })
  test('Config totalMaxBytes 负数 → issues', () => {
    const r = Config['~standard'].validate({ totalMaxBytes: -1 })
    assert.ok('issues' in r)
  })
  test('Config totalMaxBytes 非数 → issues', () => {
    const r = Config['~standard'].validate({ totalMaxBytes: 'x' })
    assert.ok('issues' in r)
  })
  test('Config totalMaxBytes=0 合法', () => {
    const r = Config['~standard'].validate({ totalMaxBytes: 0 })
    assert.ok('value' in r)
    assert.equal(r.value.totalMaxBytes, 0)
  })
}

// ---------- unit: apply() + text provider ----------
async function unitApply() {
  const mod = await loadPlugin()
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-mem-test-'))
  try {
    const memFile = join(tmp, 'MEMORY.md')
    writeFileSync(memFile, '秘密：TEST-42\n', 'utf-8')
    const sections = []
    const ctx = { systemPrompt: { section: (s) => sections.push(s) } }
    mod.apply(ctx, { files: [memFile], maxBytes: 100, order: 40, marker: 'TEST' })

    test('apply 注册 section 一次', () => assert.equal(sections.length, 1))
    test('section order 来自 config', () => assert.equal(sections[0].order, 40))

    const text1 = sections[0].text()
    test('注入文件内容', () => assert.ok(text1.includes('TEST-42')))
    test('marker 按配置渲染', () => assert.ok(text1.includes('TEST-MARKER')))

    writeFileSync(memFile, '秘密：TEST-99\n', 'utf-8')
    const text2 = sections[0].text()
    test('text provider 每次重读（文件改动后新内容）', () => {
      assert.ok(text2.includes('TEST-99'))
      assert.ok(!text2.includes('TEST-42'))
    })

    const sections2 = []
    mod.apply({ systemPrompt: { section: (s) => sections2.push(s) } },
      { files: [join(tmp, 'nope.md')], maxBytes: 100, order: 40, marker: 'TEST' })
    test('读不到文件标错不崩溃', () => {
      assert.ok(sections2[0].text().includes('MEMORY-SNAPSHOT-ERROR'))
    })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// ---------- unit: 截断 / 总预算 ----------
// 提取单个文件注入的 body（header 之后、收尾分隔之前）。
function extractBody(text, raw) {
  const header = `--- ${raw} ---\n`
  const start = text.indexOf(header)
  assert.ok(start !== -1, `header 存在: ${raw}`)
  const bodyStart = start + header.length
  const end = text.indexOf('\n---\n记忆快照结束', bodyStart)
  assert.ok(end !== -1, 'body 收尾分隔存在')
  return text.slice(bodyStart, end)
}

async function unitTruncation() {
  const mod = await loadPlugin()
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-mem-trunc-'))
  const applyWith = (config) => {
    const sections = []
    mod.apply({ systemPrompt: { section: (s) => sections.push(s) } }, config)
    return sections[0].text()
  }
  try {
    // R1：中文按字节截断，实际字节数 ≤ maxBytes，且不切断多字节
    const cnFile = join(tmp, 'cn.md')
    writeFileSync(cnFile, '你好世界'.repeat(10) + '\n', 'utf-8')
    const cnMax = 20
    const cnText = applyWith({ files: [cnFile], maxBytes: cnMax, order: 40, marker: 'TEST' })
    const cnBody = extractBody(cnText, cnFile)
    const m = cnBody.match(/注入前 (\d+) 字节/)
    test('中文按字节截断后注入字节数 ≤ maxBytes', () => {
      assert.ok(m, '有截断标记')
      assert.ok(Number(m[1]) <= cnMax)
    })
    test('截断不切断多字节（无替换字符）', () => {
      assert.ok(!cnBody.includes('\uFFFD'))
    })

    // R2：截断回退到换行边界 + 截断标记文本与字节数正确
    const nlFile = join(tmp, 'nl.md')
    const nlContent = '第一行\n第二行\n第三行内容\n'
    writeFileSync(nlFile, nlContent, 'utf-8')
    const nlMax = 30
    const nlText = applyWith({ files: [nlFile], maxBytes: nlMax, order: 40, marker: 'TEST' })
    const nlBody = extractBody(nlText, nlFile)
    test('截断回退到最后一个换行边界（丢弃不完整行）', () => {
      assert.ok(nlBody.startsWith('第一行\n第二行\n'))
      assert.ok(!nlBody.includes('第三行'))
    })
    test('截断标记文本与字节数正确', () => {
      const mm = nlBody.match(/…\[已截断，原文 (\d+) 字节，注入前 (\d+) 字节\]/)
      assert.ok(mm, '截断标记格式正确')
      assert.equal(Number(mm[1]), Buffer.byteLength(nlContent, 'utf8'))
      assert.equal(Number(mm[2]), Buffer.byteLength('第一行\n第二行\n', 'utf8'))
    })

    // R2：未超限时不出现截断标记
    const okFile = join(tmp, 'ok.md')
    writeFileSync(okFile, '短内容\n', 'utf-8')
    const okText = applyWith({ files: [okFile], maxBytes: 1000, order: 40, marker: 'TEST' })
    test('未超限时不出现截断标记', () => {
      assert.ok(!okText.includes('…[已截断'))
    })

    // P1 对抗边界：空文件、精确边界、极小预算、无换行和 4 字节字符
    const emptyFile = join(tmp, 'empty.md')
    writeFileSync(emptyFile, '', 'utf-8')
    const emptyText = applyWith({ files: [emptyFile], maxBytes: 1, order: 40, marker: 'TEST' })
    test('空文件作为 0 字节内容正常注入', () => {
      assert.equal(extractBody(emptyText, emptyFile), '')
      assert.ok(!emptyText.includes('MEMORY-SNAPSHOT-ERROR'))
      assert.ok(!emptyText.includes('…[已截断'))
    })

    const exactFile = join(tmp, 'exact.md')
    const exactContent = '边界😀'
    const exactBytes = Buffer.byteLength(exactContent, 'utf8')
    writeFileSync(exactFile, exactContent, 'utf-8')
    const exactText = applyWith({ files: [exactFile], maxBytes: exactBytes, order: 40, marker: 'TEST' })
    test('maxBytes 恰好等于文件字节数时不截断', () => {
      assert.equal(extractBody(exactText, exactFile), exactContent)
      assert.ok(!exactText.includes('…[已截断'))
    })

    const tinyFile = join(tmp, 'tiny.md')
    writeFileSync(tinyFile, '中', 'utf-8')
    const tinyText = applyWith({ files: [tinyFile], maxBytes: 1, order: 40, marker: 'TEST' })
    const tinyBody = extractBody(tinyText, tinyFile)
    test('maxBytes 小于首字符字节数时内容为空但保留截断标记', () => {
      const markerAt = tinyBody.indexOf('…[已截断')
      assert.ok(markerAt !== -1, '有截断标记')
      assert.equal(tinyBody.slice(0, markerAt).trim(), '')
      assert.ok(tinyBody.includes('原文 3 字节，注入前 0 字节'))
      assert.ok(!tinyBody.includes('中'))
    })

    const noNlFile = join(tmp, 'no-newline.md')
    writeFileSync(noNlFile, 'abcdef', 'utf-8')
    const noNlText = applyWith({ files: [noNlFile], maxBytes: 4, order: 40, marker: 'TEST' })
    const noNlBody = extractBody(noNlText, noNlFile)
    test('内容无换行符时保留字节截断结果', () => {
      assert.ok(noNlBody.startsWith('abcd\n…[已截断'))
      assert.ok(noNlBody.includes('注入前 4 字节'))
      assert.ok(!noNlBody.includes('abcde'))
    })

    const emojiFile = join(tmp, 'emoji.md')
    writeFileSync(emojiFile, '😀😀', 'utf-8')
    const emojiText = applyWith({ files: [emojiFile], maxBytes: 5, order: 40, marker: 'TEST' })
    const emojiBody = extractBody(emojiText, emojiFile)
    test('emoji 四字节字符截断不产生替换字符', () => {
      assert.ok(emojiBody.startsWith('😀\n…[已截断'))
      assert.ok(emojiBody.includes('注入前 4 字节'))
      assert.ok(!emojiBody.includes('😀😀'))
      assert.ok(!emojiBody.includes('\uFFFD'))
    })

    const markerFile = join(tmp, 'marker-budget.md')
    writeFileSync(markerFile, 'abcdef', 'utf-8')
    const markerText = applyWith({ files: [markerFile], maxBytes: 3, order: 40, marker: 'TEST' })
    const markerBody = extractBody(markerText, markerFile)
    test('截断标记不占用 maxBytes 内容预算', () => {
      const markerAt = markerBody.indexOf('…[已截断')
      assert.ok(markerAt !== -1, '有截断标记')
      assert.equal(markerBody.slice(0, markerAt).trimEnd(), 'abc')
      assert.ok(markerBody.includes('注入前 3 字节'))
      assert.ok(Buffer.byteLength(markerBody, 'utf8') > 3)
    })

    // R3：totalMaxBytes=0 不限制；有限预算下超预算文件跳过且后续小文件仍注入
    const bigFile = join(tmp, 'big.md')
    const smallFile = join(tmp, 'small.md')
    const bigContent = 'BIG-CONTENT-'.repeat(20)
    const smallContent = 'SMALL-CONTENT'
    writeFileSync(bigFile, bigContent, 'utf-8')
    writeFileSync(smallFile, smallContent, 'utf-8')
    const bigBytes = Buffer.byteLength(`--- ${bigFile} ---\n${bigContent}`, 'utf8')
    const smallBytes = Buffer.byteLength(`--- ${smallFile} ---\n${smallContent}`, 'utf8')

    const unlimited = applyWith({ files: [bigFile, smallFile], maxBytes: 1000, order: 40, marker: 'TEST' })
    test('totalMaxBytes=0 不限制', () => {
      assert.ok(unlimited.includes('BIG-CONTENT'))
      assert.ok(unlimited.includes('SMALL-CONTENT'))
      assert.ok(!unlimited.includes('超出总预算'))
    })

    const limited = applyWith({ files: [bigFile, smallFile], maxBytes: 1000, totalMaxBytes: bigBytes - 1, order: 40, marker: 'TEST' })
    test('超预算文件被跳过且后续小文件仍注入', () => {
      assert.ok(!limited.includes('BIG-CONTENT'))
      assert.ok(limited.includes('SMALL-CONTENT'))
      assert.ok(limited.includes(`[未注入: ${bigFile}，超出总预算]`))
    })

    // R3：预算计量含 --- path --- 头行
    const hdrFile = join(tmp, 'hdr.md')
    const hdrContent = 'H'.repeat(20)
    writeFileSync(hdrFile, hdrContent, 'utf-8')
    const headerBytes = Buffer.byteLength(`--- ${hdrFile} ---\n`, 'utf8')
    const hdrContentBytes = Buffer.byteLength(hdrContent, 'utf8')
    const hdrText = applyWith({
      files: [hdrFile], maxBytes: 1000,
      totalMaxBytes: headerBytes + hdrContentBytes - 1, order: 40, marker: 'TEST',
    })
    test('预算计量含 --- path --- 头行', () => {
      assert.ok(!hdrText.includes(hdrContent))
      assert.ok(hdrText.includes(`[未注入: ${hdrFile}，超出总预算]`))
    })

    const firstFile = join(tmp, 'first.md')
    const secondFile = join(tmp, 'second.md')
    const firstContent = 'BUDGET-FIRST'
    const secondContent = 'BUDGET-SECOND'
    writeFileSync(firstFile, firstContent, 'utf-8')
    writeFileSync(secondFile, secondContent, 'utf-8')
    const firstFullBytes = Buffer.byteLength(`--- ${firstFile} ---\n${firstContent}`, 'utf8')
    const exactBudgetText = applyWith({
      files: [firstFile, secondFile], maxBytes: 1000,
      totalMaxBytes: firstFullBytes, order: 40, marker: 'TEST',
    })
    test('totalMaxBytes 恰好等于首个文件字节数时首文件注入', () => {
      assert.ok(exactBudgetText.includes(firstContent))
      assert.ok(!exactBudgetText.includes(secondContent))
      assert.ok(exactBudgetText.includes(`[未注入: ${secondFile}，超出总预算]`))
      assert.ok(!exactBudgetText.includes('MEMORY-SNAPSHOT-ERROR'))
    })

    const allOverText = applyWith({
      files: [firstFile, secondFile], maxBytes: 1000,
      totalMaxBytes: 1, order: 40, marker: 'TEST',
    })
    test('全部文件超预算时返回 MEMORY-SNAPSHOT-ERROR', () => {
      assert.ok(allOverText.includes('MEMORY-SNAPSHOT-ERROR: 无文件注入（全部超出总预算）'))
      assert.ok(allOverText.includes(`[未注入: ${firstFile}，超出总预算]`))
      assert.ok(allOverText.includes(`[未注入: ${secondFile}，超出总预算]`))
      assert.ok(!allOverText.includes(firstContent))
      assert.ok(!allOverText.includes(secondContent))
    })

    // files: [] 空数组 → 无文件可注入（v0.1.2 语义：不再是「无法读取任何记忆文件」）
    const emptyListText = applyWith({ files: [], maxBytes: 1000, order: 40, marker: 'TEST' })
    test('files 为空数组时返回 MEMORY-SNAPSHOT-ERROR: 无记忆文件', () => {
      assert.ok(emptyListText.includes('MEMORY-SNAPSHOT-ERROR: 无记忆文件'))
      assert.ok(!emptyListText.includes('无法读取任何记忆文件'))
      assert.ok(!emptyListText.includes('…[已截断'))
    })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// ---------- e2e: dist 产物形状 ----------
async function e2eDistShape() {
  test('dist/index.js 存在', () => assert.ok(existsSync(join(ROOT, 'dist', 'index.js'))))
  const mod = await loadPlugin()
  test('dist 导出 name', () => assert.equal(mod.name, 'dsh-memory-snapshot'))
  test('dist 导出 inject', () => assert.deepEqual(mod.inject, ['systemPrompt']))
  test('dist 导出 Config(~standard)', () => assert.ok(mod.Config && mod.Config['~standard']))
  test('dist 导出 apply', () => assert.equal(typeof mod.apply, 'function'))
}

// ---------- e2e: 真实 dsh ----------
function e2eRealDsh() {
  console.log('  （dsh 需要网络 + 已安装，跑真实会话）')
  // Windows: dsh 是 fnm shim（.cmd），spawnSync 需 shell:true 才能解析
  const opts = { encoding: 'utf-8', timeout: 60000, shell: true }
  const dump = spawnSync('dsh --profile headless --dump-config', opts)
  test('dsh --dump-config 含 memory-snapshot', () => {
    assert.equal(dump.status, 0)
    assert.ok(dump.stdout.includes('memory-snapshot'))
  })
  const ask = spawnSync('dsh --profile headless "根据记忆快照，回答：记忆来自什么文件？只回答路径"',
    { ...opts, timeout: 120000 })
  test('实机会话答出记忆路径', () => {
    assert.equal(ask.status, 0)
    assert.ok(ask.stdout.includes('MEMORY.md') || ask.stdout.includes('riven-hermes'))
  })
}

// ---------- main ----------
const which = process.argv[2] ?? 'unit'
console.log(`\ndsh-memory-snapshot 测试（${which}）\n`)

if (which === 'unit' || which === 'all') {
  console.log('—— unit: Config schema ——')
  await unitConfig()
  console.log('—— unit: apply provider ——')
  await unitApply()
  console.log('—— unit: 截断 / 总预算 ——')
  await unitTruncation()
}
if (which === 'e2e' || which === 'all') {
  console.log('—— e2e: dist 形状 ——')
  await e2eDistShape()
  console.log('—— e2e: 真实 dsh ——')
  e2eRealDsh()
}

console.log(`\n结果: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
