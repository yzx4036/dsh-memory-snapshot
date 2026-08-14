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
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ❌ ${name}\n     ${e.message}`)
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
}
if (which === 'e2e' || which === 'all') {
  console.log('—— e2e: dist 形状 ——')
  await e2eDistShape()
  console.log('—— e2e: 真实 dsh ——')
  e2eRealDsh()
}

console.log(`\n结果: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)