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
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, basename } from 'node:path'
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
  test('Config 新字段默认值（dirDepth=1 / skipMissing=false / freshness=true / stripFrontMatter=true）', () => {
    const r = Config['~standard'].validate({ files: ['a.md'] })
    assert.equal(r.value.dirDepth, 1)
    assert.equal(r.value.skipMissing, false)
    assert.equal(r.value.freshness, true)
    assert.equal(r.value.stripFrontMatter, true)
  })
  test('Config dirDepth 非法（0 / -1 / 1.5 / 非数）→ issues', () => {
    for (const bad of [0, -1, 1.5, 'x']) {
      assert.ok('issues' in Config['~standard'].validate({ dirDepth: bad }), `dirDepth=${bad}`)
    }
  })
  test('Config skipMissing/freshness/stripFrontMatter 非布尔 → issues', () => {
    assert.ok('issues' in Config['~standard'].validate({ skipMissing: 'yes' }))
    assert.ok('issues' in Config['~standard'].validate({ freshness: 1 }))
    assert.ok('issues' in Config['~standard'].validate({ stripFrontMatter: null }))
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
    test('section 标记 interpolate: false（dsh 0.2.x 需按字面量注入）', () =>
      assert.equal(sections[0].interpolate, false))

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
  // Header formats: `--- <raw> ---` (freshness off) or
  // `--- <raw> (最后修改: <time>) ---` (freshness on).
  let bodyStart
  const fresh = text.indexOf(`--- ${raw} (最后修改: `)
  if (fresh !== -1) {
    const close = text.indexOf(') ---\n', fresh)
    assert.ok(close !== -1, `header 收尾存在: ${raw}`)
    bodyStart = close + 6 // ') ---\n'.length
  } else {
    const header = `--- ${raw} ---\n`
    const start = text.indexOf(header)
    assert.ok(start !== -1, `header 存在: ${raw}`)
    bodyStart = start + header.length
  }
  const end = text.indexOf('\n---\n记忆快照结束', bodyStart)
  assert.ok(end !== -1, 'body 收尾分隔存在')
  return text.slice(bodyStart, end)
}

async function unitTruncation() {
  const mod = await loadPlugin()
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-mem-trunc-'))
  // 截断/预算断言与 header 格式解耦：显式关闭 freshness / stripFrontMatter，
  // 使注入字节数可精确预期（这两项行为由 unitSnapshotFeatures 专测）。
  const applyWith = (config) => {
    const sections = []
    mod.apply({ systemPrompt: { section: (s) => sections.push(s) } },
      { freshness: false, stripFrontMatter: false, ...config })
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

// ---------- unit: 目录 / skipMissing / freshness / front-matter ----------
async function unitSnapshotFeatures() {
  const mod = await loadPlugin()
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-mem-feat-'))
  const applyWith = (config) => {
    const sections = []
    mod.apply({ systemPrompt: { section: (s) => sections.push(s) } }, config)
    return sections[0].text()
  }
  const base = { maxBytes: 1000, order: 40, marker: 'TEST', freshness: false, stripFrontMatter: false }
  try {
    // ---- F1：目录支持 ----
    const dir = join(tmp, 'notes')
    mkdirSync(join(dir, 'sub'), { recursive: true })
    mkdirSync(join(dir, '.hidden'), { recursive: true })
    writeFileSync(join(dir, 'a.md'), 'ALPHA', 'utf-8')
    writeFileSync(join(dir, 'b.md'), 'BETA', 'utf-8')
    writeFileSync(join(dir, 'UPPER.MD'), 'UPPER', 'utf-8')
    writeFileSync(join(dir, 'skip.txt'), 'TXT-SHOULD-NOT-APPEAR', 'utf-8')
    writeFileSync(join(dir, 'sub', 'c.md'), 'GAMMA', 'utf-8')
    writeFileSync(join(dir, '.hidden', 'h.md'), 'HIDDEN', 'utf-8')

    const d1 = applyWith({ ...base, files: [dir] })
    test('目录收集：直属 *.md 注入（后缀大小写不敏感）', () => {
      assert.ok(d1.includes('ALPHA') && d1.includes('BETA') && d1.includes('UPPER'))
    })
    test('目录收集：跳过非 md 文件与 dot 目录', () => {
      assert.ok(!d1.includes('TXT-SHOULD-NOT-APPEAR'))
      assert.ok(!d1.includes('HIDDEN'))
    })
    test('目录收集：dirDepth=1 不递归子目录', () => {
      assert.ok(!d1.includes('GAMMA'))
    })
    test('目录收集：字典序（UPPER.MD 在 a.md 之前）', () => {
      const iUpper = d1.indexOf(`--- ${dir}/UPPER.MD ---`)
      const iA = d1.indexOf(`--- ${dir}/a.md ---`)
      const iB = d1.indexOf(`--- ${dir}/b.md ---`)
      assert.ok(iUpper !== -1 && iA !== -1 && iB !== -1, '三个 header 都出现')
      assert.ok(iUpper < iA && iA < iB)
    })
    const d2 = applyWith({ ...base, files: [dir], dirDepth: 2 })
    test('目录收集：dirDepth=2 含一层子目录', () => {
      assert.ok(d2.includes('GAMMA'))
      assert.ok(!d2.includes('HIDDEN'))
    })

    const emptyDir = join(tmp, 'empty-dir')
    mkdirSync(emptyDir)
    const emptyDirText = applyWith({ ...base, files: [emptyDir] })
    test('空目录：「目录中无 .md 文件」注记', () => {
      assert.ok(emptyDirText.includes('目录中无 .md 文件'))
    })

    // ---- F2：skipMissing ----
    const missingFile = join(tmp, 'missing.md')
    const okFile = join(tmp, 'present.md')
    writeFileSync(okFile, 'PRESENT-CONTENT', 'utf-8')
    const loud = applyWith({ ...base, files: [missingFile, okFile] })
    test('skipMissing=false（默认）：缺失项在注记中列出', () => {
      assert.ok(loud.includes('PRESENT-CONTENT'))
      assert.ok(loud.includes('部分文件读取失败'))
      assert.ok(loud.includes(missingFile))
    })
    const quiet = applyWith({ ...base, files: [missingFile, okFile], skipMissing: true })
    test('skipMissing=true：缺失项静默、其余照常注入', () => {
      assert.ok(quiet.includes('PRESENT-CONTENT'))
      assert.ok(!quiet.includes('部分文件读取失败'))
      assert.ok(!quiet.includes(missingFile))
    })
    const allGone = applyWith({ ...base, files: [missingFile], skipMissing: true })
    test('skipMissing=true 且全部缺失：最小提示（不列路径）', () => {
      assert.ok(allGone.includes('MEMORY-SNAPSHOT-ERROR'))
      assert.ok(allGone.includes('已跳过 1 个'))
      assert.ok(!allGone.includes(missingFile))
    })

    // ---- F3：freshness ----
    const freshFile = join(tmp, 'fresh.md')
    writeFileSync(freshFile, 'FRESH-CONTENT', 'utf-8')
    const freshDefault = applyWith({ files: [freshFile], maxBytes: 1000, order: 40, marker: 'TEST' })
    test('freshness 默认开启：快照生成时间 + 文件 mtime', () => {
      assert.ok(/快照生成时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2} [+-]\d{2}:\d{2}/.test(freshDefault))
      assert.ok(freshDefault.includes(`--- ${freshFile} (最后修改: `))
    })
    const noFresh = applyWith({ ...base, files: [freshFile] })
    test('freshness=false：无时间信息', () => {
      assert.ok(!noFresh.includes('快照生成时间'))
      assert.ok(!noFresh.includes('最后修改'))
      assert.ok(noFresh.includes(`--- ${freshFile} ---`))
    })

    // ---- F4：front-matter 剥离 ----
    const fmFile = join(tmp, 'fm.md')
    writeFileSync(fmFile, '---\ntitle: 标题\ntags: [a, b]\n---\n正文内容 FM-BODY\n', 'utf-8')
    const fmStripped = applyWith({ files: [fmFile], maxBytes: 1000, order: 40, marker: 'TEST', freshness: false })
    test('front-matter 默认剥离（保留正文）', () => {
      assert.ok(fmStripped.includes('FM-BODY'))
      assert.ok(!fmStripped.includes('title:'))
    })
    const fmKept = applyWith({ ...base, files: [fmFile], stripFrontMatter: false })
    test('stripFrontMatter=false 保留原文', () => {
      assert.ok(fmKept.includes('title:'))
    })
    const fmDots = join(tmp, 'fm-dots.md')
    writeFileSync(fmDots, '---\nkey: v\n...\nDOTS-BODY\n', 'utf-8')
    const fmDotsText = applyWith({ files: [fmDots], maxBytes: 1000, order: 40, marker: 'TEST', freshness: false })
    test('front-matter 以 ... 收尾同样剥离', () => {
      assert.ok(fmDotsText.includes('DOTS-BODY'))
      assert.ok(!fmDotsText.includes('key: v'))
    })
    const fmOpen = join(tmp, 'fm-open.md')
    writeFileSync(fmOpen, '---\nnever closed\nOPEN-BODY\n', 'utf-8')
    const fmOpenText = applyWith({ files: [fmOpen], maxBytes: 1000, order: 40, marker: 'TEST', freshness: false })
    test('未闭合 front-matter 不剥离（保守）', () => {
      assert.ok(fmOpenText.includes('never closed') && fmOpenText.includes('OPEN-BODY'))
    })
    const fmBig = join(tmp, 'fm-big.md')
    writeFileSync(fmBig, '---\n' + 'x'.repeat(200) + '\n---\nTAIL-OK\n', 'utf-8')
    const fmBigText = applyWith({ files: [fmBig], maxBytes: 20, order: 40, marker: 'TEST', freshness: false })
    test('剥离先于截断（省下 front-matter 的预算给正文）', () => {
      assert.ok(fmBigText.includes('TAIL-OK'))
      assert.ok(!fmBigText.includes('xxxxxxxxxx'))
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

// ---------- e2e: install.mjs（隔离 DSH_HOME 演练）----------
function e2eInstaller() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mem-inst-'))
  const installer = join(ROOT, 'install.mjs')
  const run = (args) => spawnSync(
    process.execPath, [installer, '--yes', ...args],
    { encoding: 'utf-8', env: { ...process.env, DSH_HOME: home }, timeout: 60000 }
  )
  const patchText = () => readFileSync(join(home, 'cordis.patch.yml'), 'utf-8')
  const pluginFile = join(home, 'plugins', 'dsh-memory-snapshot', 'index.js')
  try {
    const r1 = run([])
    test('install.mjs：全新安装创建 patch 条目与插件文件', () => {
      assert.equal(r1.status, 0, r1.stderr)
      assert.ok(patchText().includes('id: memory-snapshot'))
      assert.ok(existsSync(pluginFile))
    })
    const r2 = run(['--update'])
    test('install.mjs --update：刷新文件、patch 配置不动', () => {
      assert.equal(r2.status, 0, r2.stderr)
      assert.ok(r2.stdout.includes('plugin files refreshed'))
      assert.ok(patchText().includes('id: memory-snapshot'))
    })
    const r3 = run(['--uninstall'])
    test('install.mjs --uninstall：移除条目与文件', () => {
      assert.equal(r3.status, 0, r3.stderr)
      assert.ok(!patchText().includes('id: memory-snapshot'))
      assert.ok(!existsSync(pluginFile))
    })
    test('install.mjs：--uninstall 与 --update 互斥（exit 2）', () => {
      const r = run(['--uninstall', '--update'])
      assert.equal(r.status, 2)
      assert.ok(r.stderr.includes('mutually exclusive'))
    })
    // 跨层预检：另一 profile 以 bundle 形态引用 → 再装 home 应被拦截
    const p2 = join(home, 'profiles', 'demo2')
    mkdirSync(p2, { recursive: true })
    writeFileSync(join(p2, 'package.json'),
      JSON.stringify({ name: 'dsh-profile-demo2', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-memory-snapshot'] } } }),
      'utf-8')
    const r4 = run([])
    test('install.mjs：跨层预检拦截（bundle 形态同样检出，exit 2）', () => {
      assert.equal(r4.status, 2, `stdout=${r4.stdout} stderr=${r4.stderr}`)
      assert.ok(r4.stderr.includes('duplicate loader entry id'))
      assert.ok(r4.stderr.includes('profile:demo2'))
    })
    const r5 = run(['--force'])
    test('install.mjs --force：跳过预检完成安装', () => {
      assert.equal(r5.status, 0, r5.stderr)
      assert.ok(patchText().includes('id: memory-snapshot'))
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

// ---------- e2e: 真实 dsh ----------

// 期望关键词来自「实际安装的 patch 配置」，不是写死的默认文件名：
// 用户把 files 指到任意文档（如知识库里的某个 md）都该算通过，
// 写死 MEMORY.md / riven-hermes 会在非默认配置上假红。
// 可用 DSH_MEM_TEST_EXPECT=a.md,b.md 显式覆盖。
function expectedMemoryTokens() {
  const forced = process.env.DSH_MEM_TEST_EXPECT
  if (forced) return forced.split(',').map(s => s.trim()).filter(Boolean)

  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const patches = [
    join(home, 'profiles', 'headless', 'cordis.patch.yml'),
    join(home, 'cordis.patch.yml'),
  ]
  const tokens = []
  for (const p of patches) {
    if (!existsSync(p)) continue
    const text = readFileSync(p, 'utf-8')
    // 只认 memory-snapshot 条目下的 files 列表
    const block = text.match(/id:\s*memory-snapshot[\s\S]*?files:\s*\n((?:[ \t]*-[ \t]*['"]?[^'"\n]+['"]?[ \t]*\n?)+)/)
    if (!block) continue
    for (const line of block[1].split('\n')) {
      const m = line.match(/^[ \t]*-[ \t]*['"]?([^'"\n]+?)['"]?[ \t]*$/)
      if (m) tokens.push(basename(m[1].trim()))
    }
  }
  // 兜底：至少要给出一个 markdown 路径
  return tokens.length ? tokens : ['.md']
}

// 凭据：dsh 的解析链是 继承环境 → $DSH_HOME/.credentials.yaml → 调用目录 .env → $DSH_HOME/.env。
// 这里只覆盖最常用的三处（显式环境变量 / 调用目录 .env / $DSH_HOME/.env），
// 找不到 key 时把实机会话用例标 SKIP —— 没配凭据是环境问题，不该报成插件失败。
function loadCredentials() {
  if (process.env.DEEPSEEK_API_KEY) return {}
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const files = [
    process.env.DSH_MEM_TEST_ENV_FILE,
    join(process.cwd(), '.env'),
    join(home, '.env'),
  ].filter(Boolean)
  const extra = {}
  for (const f of files) {
    if (!existsSync(f)) continue
    for (const line of readFileSync(f, 'utf-8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]*API_KEY)\s*=\s*(.+?)\s*$/)
      if (m) extra[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
    }
  }
  return extra
}

function e2eRealDsh() {
  console.log('  （dsh 需要网络 + 已安装，跑真实会话）')
  // Windows: dsh 是 fnm shim（.cmd），spawnSync 需 shell:true 才能解析
  const opts = { encoding: 'utf-8', timeout: 60000, shell: true }
  const dump = spawnSync('dsh --profile headless --dump-config', opts)
  test('dsh --dump-config 含 memory-snapshot', () => {
    assert.equal(dump.status, 0)
    assert.ok(dump.stdout.includes('memory-snapshot'))
  })

  const creds = loadCredentials()
  if (!process.env.DEEPSEEK_API_KEY && !Object.keys(creds).length) {
    console.log('  [SKIP] 实机会话答出记忆路径（未找到 DEEPSEEK_API_KEY：export 它，或写入 $DSH_HOME/.env 后重跑）')
    return
  }

  const ask = spawnSync('dsh --profile headless "根据记忆快照，回答：记忆来自什么文件？只回答路径"',
    { ...opts, timeout: 120000, env: { ...process.env, ...creds } })
  test('实机会话答出记忆路径', () => {
    assert.equal(ask.status, 0, `dsh 退出码非 0；stderr=${(ask.stderr || '').slice(0, 300)}`)
    const expected = expectedMemoryTokens()
    assert.ok(expected.some(t => ask.stdout.includes(t)),
      `答案未命中配置中的文件名 ${JSON.stringify(expected)}；stdout=${ask.stdout.slice(0, 300)}`)
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
  console.log('—— unit: 目录 / skipMissing / freshness / front-matter ——')
  await unitSnapshotFeatures()
}
if (which === 'e2e' || which === 'all') {
  console.log('—— e2e: dist 形状 ——')
  await e2eDistShape()
  console.log('—— e2e: install.mjs ——')
  e2eInstaller()
  console.log('—— e2e: 真实 dsh ——')
  e2eRealDsh()
}

console.log(`\n结果: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
