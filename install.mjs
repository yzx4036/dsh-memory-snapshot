#!/usr/bin/env node
// dsh-memory-snapshot installer — zero-dependency, cross-platform.
//
// Auto-locates DSH_HOME, copies index.js into $DSH_HOME/plugins/dsh-memory-snapshot/,
// and merges a cordis patch entry into $DSH_HOME/cordis.patch.yml (all profiles)
// or $DSH_HOME/profiles/<name>/cordis.patch.yml (single profile).
//
// Install model: local file copy referencing the plugin via a file:/// URL in
// the cordis patch. This is the zero-dependency path (no registry, no `dsh
// plugin add`). The dsh.bundle path (repo-root cordis.patch.yml, `dsh plugin
// add`) is equally supported — pick one; installing both at once hits
// `duplicate loader entry id`.
//
// Usage:
//   node install.mjs                  # home-level (all profiles)
//   node install.mjs --profile headless
//   node install.mjs --yes            # skip confirmation
//   node install.mjs --verify         # also run `dsh --dump-config` sanity check
//   node install.mjs --files A.md,B.md   # initial memory files for config
//   node install.mjs --update         # refresh plugin files, keep patch config
//   node install.mjs --uninstall      # remove plugin files + patch entry
//   node install.mjs --force          # skip the cross-layer duplicate-id precheck
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'

// NOTE: this plugin is authored in TypeScript (src/index.ts); the installer
// deploys the tsc build output (dist/index.js) so users never need a toolchain.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PLUGIN_NAME = 'dsh-memory-snapshot'
const ENTRY_ID = 'memory-snapshot'
const SOURCE_FILE = join(SCRIPT_DIR, 'dist', 'index.js')
const DEPLOY_NAME = 'index.js'

// ---- arg parsing (no deps) ----
const args = process.argv.slice(2)
const opt = {
  profile: null,
  yes: false,
  verify: false,
  files: [],
  uninstall: false,
  update: false,
  force: false,
}
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--profile') { opt.profile = args[++i] ?? null }
  else if (a === '--yes') { opt.yes = true }
  else if (a === '--verify') { opt.verify = true }
  else if (a === '--files') { opt.files = String(args[++i] ?? '').split(',').map(s => s.trim()).filter(Boolean) }
  else if (a === '--uninstall') { opt.uninstall = true }
  else if (a === '--update') { opt.update = true }
  else if (a === '--force') { opt.force = true }
  else { console.error(`unknown arg: ${a}`); process.exit(2) }
}
if (opt.uninstall && opt.update) {
  console.error('ERROR: --uninstall and --update are mutually exclusive')
  process.exit(2)
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
const pluginTarget = join(pluginDir, DEPLOY_NAME)

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

// ---- cross-layer duplicate-id precheck ----
// The same loader entry id installed at two layers makes `dsh` boot fail with
// `duplicate loader entry id`. Before writing, scan every *other* layer that
// could hold a memory-snapshot entry.
function scanLayerPatches() {
  const candidates = []
  const homePatch = join(dshHome, 'cordis.patch.yml')
  if (patchTarget !== homePatch) candidates.push({ layer: 'home', path: homePatch })
  const profilesDir = join(dshHome, 'profiles')
  if (existsSync(profilesDir)) {
    for (const name of readdirProfiles(profilesDir)) {
      if (opt.profile === name) continue
      candidates.push({ layer: `profile:${name}`, path: join(profilesDir, name, 'cordis.patch.yml') })
      candidates.push({ layer: `profile:${name} (bundle)`, path: join(profilesDir, name, 'package.json') })
    }
  }
  const hits = []
  for (const c of candidates) {
    if (!existsSync(c.path)) continue
    let text
    try { text = readFileSync(c.path, 'utf-8') } catch { continue }
    // Patch files carry `id: memory-snapshot`; a profile's package.json carries
    // the bundle/dependency name (bundle installs never touch the patch text).
    // Either form means the entry exists at that layer.
    if (c.path.endsWith('package.json')) {
      if (text.includes(PLUGIN_NAME)) hits.push(c)
    } else if (text.includes(`id: ${ENTRY_ID}`) && text.includes(PLUGIN_NAME)) {
      hits.push(c)
    }
  }
  return hits
}
function readdirProfiles(dir) {
  try { return readdirSync(dir) } catch { return [] }
}

function precheckOrExit() {
  if (opt.force) return
  const conflicting = scanLayerPatches()
  if (!conflicting.length) return
  console.error('\nERROR: memory-snapshot is already installed at another layer:')
  for (const c of conflicting) console.error(`  - ${c.layer}  (${c.path})`)
  console.error('\nThe same loader id at two layers makes `dsh` boot fail with `duplicate loader entry id`.')
  console.error('Pick one:')
  console.error('  1) remove the other copy first — `dsh plugin --profile <name> remove dsh-memory-snapshot`')
  console.error('     (bundle install) or `node install.mjs [--profile <name>] --uninstall` (file-copy install)')
  console.error('  2) re-run with --force to skip this precheck')
  process.exit(2)
}

// ---- locate OUR entry block inside a patch file ----
// Primary form: a marker comment line ("# dsh-memory-snapshot — added by
// install.mjs") followed by the `- insert:` block. Fallback: any top-level
// block mentioning both the entry id and the plugin name (hand-written or
// older installs).
function findEntryBlock(lines) {
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trimStart()
    if (t.startsWith('#') && t.includes(PLUGIN_NAME)) {
      let j = i + 1
      let sawEntry = false
      while (j < lines.length) {
        const l = lines[j]
        if (l.startsWith('- ')) {
          if (sawEntry) break
          sawEntry = true
          j++
          continue
        }
        if (/^[ \t]/.test(l) || l.trim() === '') { j++; continue }
        break
      }
      return { start: i, end: j - 1 }
    }
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('- ')) {
      let j = i + 1
      while (j < lines.length && /^[ \t]/.test(lines[j])) j++
      const block = lines.slice(i, j).join('\n')
      if (block.includes(`id: ${ENTRY_ID}`) && block.includes(PLUGIN_NAME)) return { start: i, end: j - 1 }
    }
  }
  return null
}

function removeEntryFromPatch() {
  if (!existsSync(patchTarget)) return 'no-file'
  const text = readFileSync(patchTarget, 'utf-8')
  const lines = text.split('\n')
  const block = findEntryBlock(lines)
  if (!block) return 'not-found'
  lines.splice(block.start, block.end - block.start + 1)
  writeFileSync(patchTarget, lines.join('\n'), 'utf-8')
  return 'removed'
}

// ---- merge into existing patch (never clobber user content) ----
// "Effectively empty" means: whitespace, YAML comments, and/or the empty flow
// array `[]` (dsh writes that placeholder in a fresh profile patch). Treating
// only `''`/`'[]'` as empty missed the commented `[]` header dsh generates,
// which then produced invalid YAML (`[]` followed by `- insert:`).
function stripComments(text) {
  return text.split('\n').map(line => line.trimStart()).filter(line => !line.startsWith('#')).join('\n')
}
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
  const body = stripComments(current).trim()
  if (body === '' || body === '[]') {
    writeFileSync(patchPath, entry + '\n', 'utf-8')
    return 'replaced-empty'
  }
  // Append as another top-level array element (YAML allows multiple `- insert:` entries).
  const sep = current.endsWith('\n') ? '' : '\n'
  writeFileSync(patchPath, current + sep + entry + '\n', 'utf-8')
  return 'appended'
}

// ---- deploy plugin files (index.js + a minimal ESM package.json) ----
function deployFiles() {
  mkdirSync(pluginDir, { recursive: true })
  copyFileSync(SOURCE_FILE, pluginTarget)
  // write a minimal package.json so Node treats index.js as ESM (avoids MODULE_TYPELESS_PACKAGE_JSON warning)
  // version 从发布物 package.json 现读——写死会在升级后显示旧版本，误导排查
  const pkgPath = join(pluginDir, 'package.json')
  const ownPkg = JSON.parse(readFileSync(join(SCRIPT_DIR, 'package.json'), 'utf-8'))
  const pkgContent = JSON.stringify({
    name: PLUGIN_NAME,
    version: ownPkg.version,
    private: true,
    type: 'module',
    main: 'index.js',
  }, null, 2)
  writeFileSync(pkgPath, pkgContent + '\n', 'utf-8')
  return ownPkg.version
}

// ---- main ----
async function main() {
  console.log(`DSH_HOME      : ${dshHome}`)
  console.log(`plugin target : ${pluginTarget}`)
  console.log(`patch target  : ${patchTarget}${opt.profile ? ` (profile: ${opt.profile})` : ' (all profiles)'}`)
  if (opt.uninstall) console.log('mode          : uninstall')
  if (opt.update) console.log('mode          : update (refresh plugin files, keep patch config)')

  if (!yesAll) {
    const ok = await ask('Continue?')
    if (!ok) { console.log('aborted'); process.exit(1) }
  }

  if (opt.uninstall) {
    let filesRemoved = false
    if (existsSync(pluginTarget)) { rmSync(pluginTarget, { force: true }); filesRemoved = true }
    const pkgPath = join(pluginDir, 'package.json')
    if (existsSync(pkgPath)) { rmSync(pkgPath, { force: true }); filesRemoved = true }
    try { rmdirSync(pluginDir) } catch { /* non-empty or missing: leave the directory */ }
    const result = removeEntryFromPatch()
    const msg = {
      removed: 'memory-snapshot entry removed',
      'not-found': 'no memory-snapshot entry found (patch already clean)',
      'no-file': 'patch file does not exist (nothing to remove)',
    }[result]
    console.log(`plugin files : ${filesRemoved ? 'removed' : 'not present'}`)
    console.log(`patch        : ${msg}`)
    const others = scanLayerPatches()
    if (others.length) {
      console.log('note         : memory-snapshot is also present at:')
      for (const c of others) console.log(`  - ${c.layer}  (${c.path})`)
      console.log('               (left untouched — remove separately if unwanted)')
    }
    console.log('\nDone.')
    return
  }

  if (!existsSync(SOURCE_FILE)) {
    console.error(`ERROR: build output missing: ${SOURCE_FILE}`)
    console.error('Run `npm run build` (or `tsc -p tsconfig.json`) first.')
    process.exit(1)
  }

  if (opt.update) {
    if (!existsSync(pluginTarget)) {
      console.error('ERROR: nothing installed to update — run `node install.mjs` first')
      process.exit(2)
    }
    const version = deployFiles()
    console.log(`updated      : plugin files refreshed (v${version}) — patch config untouched`)
    const hasEntry = existsSync(patchTarget) && readFileSync(patchTarget, 'utf-8').includes(`id: ${ENTRY_ID}`)
    if (!hasEntry) console.log('note         : memory-snapshot entry not found in the patch — run `node install.mjs` to add it')
  } else {
    precheckOrExit()
    const version = deployFiles()
    console.log(`copied index.js + package.json (v${version}) -> ${pluginDir}/`)

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
  }

  if (opt.verify) {
    // 1. syntax-check the installed plugin before booting dsh.
    const check = spawnSync(process.execPath, ['--check', pluginTarget], { encoding: 'utf-8' })
    if (check.status !== 0) {
      console.error('VERIFY FAILED: copied plugin fails `node --check`')
      console.error(check.stderr || check.stdout || '')
      process.exit(1)
    }
    // 2. boot dsh and confirm the entry appears in the composed config.
    // A shell is required on Windows: `dsh` resolves through a PATH shim
    // (fnm/nvm/npm) that only a shell can execute; a raw spawnSync fails to
    // launch it (status null). Built as a single command string — the args are
    // fixed flags (no user input), so this carries no injection risk.
    const profileArg = opt.profile ? ['--profile', opt.profile] : ['--profile', 'headless']
    const dshCmd = ['dsh', ...profileArg, '--dump-config'].join(' ')
    console.log(`\n--verify: ${dshCmd} ...`)
    const r = spawnSync(dshCmd, { encoding: 'utf-8', timeout: 60_000, shell: true })
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