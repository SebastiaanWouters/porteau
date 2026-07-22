#!/usr/bin/env node
/**
 * Bump package.json version and regenerate install.sh.
 *
 * Usage:
 *   vp run bump 0.1.0-alpha.4
 *   node scripts/bump-version.mjs 0.1.0-alpha.4
 *
 * Does not commit or tag. Prints the follow-up commands.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const packagePath = join(root, 'package.json')
const versionArg = process.argv[2]

const VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/u

function fail(message) {
  console.error(`bump-version: ${message}`)
  process.exit(1)
}

if (!versionArg) fail('usage: vp run bump <semver>')
if (!VERSION_RE.test(versionArg)) fail(`invalid semver: ${versionArg}`)

const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
const previous = pkg.version
if (previous === versionArg) fail(`already at ${versionArg}`)

pkg.version = versionArg
writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`)

const generate = spawnSync('vp', ['run', 'generate:install'], {
  cwd: root,
  stdio: 'inherit',
  shell: false,
})
if (generate.status !== 0) fail('generate:install failed')

const tag = `v${versionArg}`
console.log(`
bumped ${previous} → ${versionArg}
updated: package.json, install.sh

next:
  git add package.json install.sh
  git commit -m "chore: release ${versionArg}"
  git push
  # wait for Node 22.18.0 and Node 24 green on that commit, then:
  git tag -a ${tag} -m "Release ${tag}"
  git push origin ${tag}
  # never force-move ${tag} after npm has published that version
`)
