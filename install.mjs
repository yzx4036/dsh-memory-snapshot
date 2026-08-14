#!/usr/bin/env node
// dsh-memory-snapshot installer — zero-dependency, cross-platform.
//
// Auto-locates DSH_HOME, copies index.js into $DSH_HOME/plugins/dsh-memory-snapshot/,
// and merges a cordis patch entry into $DSH_HOME/cordis.patch.yml (all profiles)
// or $DSH_HOME/profiles/<name>/cordis.patch.yml (single profile).
//
// Usage:
//   node install.mjs                  # home-level (all profiles)
//   node install.mjs --profile headless
//   node install.mjs --yes            # skip confirmation
//   node install.mjs --verify         # also run `dsh --dump-config` sanity check
//   node install.mjs --files A.md,B.md   # initial memory files for config
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PLUGIN_NAME = 'dsh-memory-snapshot'
const ENTRY_ID = 'memory-snapshot'

// ---- arg parsing (no deps) ----
const args = process.argv.slice(2)
const opt = {
  profile: null,
  yes: false,
  verify: false,
  files: [],
}
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--profile') { opt.profile = args[++i] ?? null }
  else if (a === '--yes') { opt.yes = true }
  else if (a === '--verify') { opt.verify = true }
  else if (a === '--files') { opt.files = String(args[++i] ?? '').split(',').map(s => s.trim()).filter(Boolean) }
  else { console.error(`unknown arg: ${a}`); process.exit(2) }
}

// ---- locate DSH_HOME ----
function findDshHome() {
  const candidates = []
  if (process.env.DSH_HOME) candidates.push(process.env.DSH_HOME)
  candidates.push(join(homedir(), '.dsh'))
  for (const c of candidates) {
    if (existsSync(c)) return resolve(c)
  }
  return resolve(candidates[candidates.length - 1])
}
const dshHome = findDshHome()
const pluginDir = join(dshHome, 'plugins', PLUGIN_NAME)
const pluginTarget = join(pluginDir, 'index.js')

// ---- patch target ----
const patchTarget = opt.profile
  ? join(dshHome, 'profiles', opt.profile, 'cordis.patch.yml')
  : join(dshHome, 'cordis.patch.yml')

const marker = `${ENTRY_ID} (${PLUGIN_NAME})`
const yesAll = opt.yes

function ask(question) {
  if (yesAll) return true
  return new Promise((resolvePromise) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(`${question} [Y/n] `, (ans) => {
      rl.close()
      resolvePromise(/^y|^Y|^$/.test(ans))
    })
  })
}

// ---- build patch entry text ----
function buildEntry() {
  const fileUrl = pathToFileURL(pluginTarget).href // file:///C:/... always forward-slash
  const files = opt.files.length
    ? opt.files.map(f => `          - '${f.replace(/'/g, "\\'")}'`).join('\n')
    : `          - '~/MEMORY.md'`
  return [
    `# ${PLUGIN_NAME} — added by install.mjs`,
    '- insert:',
    `    - id: ${ENTRY_ID}`,
    `      name: '${fileUrl}'`,
    '      config:',
    '        files:',
    files,
    '        maxBytes: 3000',
    '        order: 50',
    "        marker: 'MEMORY-SNAPSHOT'",
  ].join('\n')
}

// ---- merge into existing patch (never clobber user content) ----
function mergePatch(patchPath, entry) {
  const exists = existsSync(patchPath)
  if (!exists) {
    writeFileSync(patchPath, entry + '\n', 'utf-8')
    return 'created'
  }
  const current = readFileSync(patchPath, 'utf-8')
  if (current.includes(ENTRY_ID) && current.includes(PLUGIN_NAME)) {
    return 'already'
  }
  const trimmed = current.trim()
  if (trimmed === '' || trimmed === '[]') {
    writeFileSync(patchPath, entry + '\n', 'utf-8')
    return 'replaced-empty'
  }
  // Append as another top-level array element (YAML allows multiple `- insert:` entries).
  const sep = current.endsWith('\n') ? '' : '\n'
  writeFileSync(patchPath, current + sep + entry + '\n', 'utf-8')
  return 'appended'
}

// ---- main ----
async function main() {
  console.log(`DSH_HOME      : ${dshHome}`)
  console.log(`plugin target : ${pluginTarget}`)
  console.log(`patch target  : ${patchTarget}${opt.profile ? ` (profile: ${opt.profile})` : ' (all profiles)'}`)

  if (!yesAll) {
    const ok = await ask('Continue?')
    if (!ok) { console.log('aborted'); process.exit(1) }
  }

  mkdirSync(pluginDir, { recursive: true })
  copyFileSync(join(SCRIPT_DIR, 'index.js'), pluginTarget)
  // write a minimal package.json so Node treats index.js as ESM (avoids MODULE_TYPELESS_PACKAGE_JSON warning)
  const pkgPath = join(pluginDir, 'package.json')
  const pkgContent = JSON.stringify({
    name: PLUGIN_NAME,
    version: '0.1.0',
    private: true,
    type: 'module',
    main: 'index.js',
  }, null, 2)
  writeFileSync(pkgPath, pkgContent + '\n', 'utf-8')
  console.log(`copied index.js + package.json -> ${pluginDir}/`)

  const result = mergePatch(patchTarget, buildEntry())
  const resultMsg = {
    created: 'patch file created',
    'replaced-empty': 'patch file was empty, now contains memory-snapshot',
    appended: 'memory-snapshot entry appended to existing patch (user content preserved)',
    already: 'memory-snapshot already installed — nothing changed',
  }[result]
  console.log(`patch        : ${resultMsg}`)

  if (result === 'appended') {
    console.log('NOTE: existing patch content was preserved; verify order of entries is valid YAML.')
  }

  console.log('\nNext: configure memory files & verify')
  console.log('  1. Edit config in the patch file above (files / maxBytes / order / marker)')
  console.log('  2. Run:  dsh --profile headless --dump-config | grep memory-snapshot')
  console.log('  3. Run:  dsh --profile headless "check your memory snapshot and answer: what files did it read?"')

  if (opt.verify) {
    const profileArg = opt.profile ? ['--profile', opt.profile] : ['--profile', 'headless']
    console.log(`\n--verify: dsh ${profileArg.join(' ')} --dump-config ...`)
    const r = spawnSync('dsh', [...profileArg, '--dump-config'], { encoding: 'utf-8', timeout: 60_000 })
    if (r.status === 0 && r.stdout.includes(ENTRY_ID)) {
      console.log('VERIFY OK: memory-snapshot appears in dump-config')
    } else {
      console.error('VERIFY FAILED: entry not found in dump-config — check dsh install / profile name')
      console.error((r.stderr || r.stdout || '').slice(0, 500))
      process.exit(1)
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })