import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const temporary = mkdtempSync(join(tmpdir(), 'porteau-package-smoke-'))

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}${result.stderr}`)
  }
  return result.stdout
}

try {
  const packDirectory = join(temporary, 'tarball')
  mkdirSync(packDirectory)
  const output = run('pnpm', ['pack', '--pack-destination', packDirectory], { cwd: root })
  const tarball = output.trim().split('\n').at(-1)
  if (!tarball?.endsWith('.tgz')) throw new Error(`Unable to locate packed tarball in:\n${output}`)

  const files = run('tar', ['-tzf', tarball]).trim().split('\n').filter(Boolean)
  const unexpected = files.filter(
    (file) =>
      !['package/package.json', 'package/README.md', 'package/INSTALL.md'].includes(file) &&
      !file.startsWith('package/dist/'),
  )
  if (unexpected.length > 0) throw new Error(`Unexpected packaged files: ${unexpected.join(', ')}`)
  if (!files.includes('package/dist/cli.mjs'))
    throw new Error('Tarball does not contain dist/cli.mjs')
  if (!files.includes('package/INSTALL.md')) throw new Error('Tarball does not contain INSTALL.md')

  const project = join(temporary, 'consumer')
  mkdirSync(project)
  writeFileSync(join(project, 'package.json'), '{"name":"porteau-smoke-consumer","private":true}')
  run('pnpm', ['add', '--ignore-scripts', tarball], { cwd: project })

  const cli = join(project, 'node_modules', '.bin', 'porteau')
  const help = run(cli, ['--help'], { cwd: project })
  if (!help.includes('Porteau') || !help.includes('backup'))
    throw new Error(`Packaged CLI returned unexpected help:\n${help}`)

  const installedMetadata = JSON.parse(
    readFileSync(join(project, 'node_modules', 'porteau', 'package.json'), 'utf8'),
  )
  if (installedMetadata.bin?.porteau !== './dist/cli.mjs')
    throw new Error('Installed package does not expose the expected porteau bin')
  console.log(`Package smoke passed (${files.length} files; packaged dist/cli.mjs invoked).`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
