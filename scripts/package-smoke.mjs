import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const temporary = mkdtempSync(join(tmpdir(), 'porteau-package-smoke-'))
const retainedTarball = process.argv[2] ? resolve(process.argv[2]) : undefined

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}${result.stderr}`)
  }
  return result.stdout
}

try {
  const sourceMetadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const rangedDependencies = Object.entries(sourceMetadata.dependencies ?? {})
    .filter(([, version]) => !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(String(version)))
    .map(([name, version]) => `${name}@${String(version)}`)
  if (rangedDependencies.length > 0)
    throw new Error(
      `Runtime dependencies must use exact versions: ${rangedDependencies.join(', ')}`,
    )

  const packDirectory = join(temporary, 'tarball')
  mkdirSync(packDirectory)
  const output = run('pnpm', ['pack', '--pack-destination', packDirectory], { cwd: root })
  const tarball = output.trim().split('\n').at(-1)
  if (!tarball?.endsWith('.tgz')) throw new Error(`Unable to locate packed tarball in:\n${output}`)

  const files = run('tar', ['-tzf', tarball]).trim().split('\n').filter(Boolean)
  const required = [
    'package/LICENSE',
    'package/README.md',
    'package/package.json',
    'package/dist/cli.d.mts',
    'package/dist/cli.mjs',
    'package/dist/cli.mjs.map',
  ]
  const unexpected = files.filter((file) => !required.includes(file))
  if (unexpected.length > 0) throw new Error(`Unexpected packaged files: ${unexpected.join(', ')}`)
  const missing = required.filter((file) => !files.includes(file))
  if (missing.length > 0) throw new Error(`Missing packaged files: ${missing.join(', ')}`)

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
  if (
    installedMetadata.name !== sourceMetadata.name ||
    installedMetadata.version !== sourceMetadata.version ||
    installedMetadata.license !== 'Apache-2.0'
  )
    throw new Error('Installed package metadata does not match the release source')
  if (installedMetadata.bin?.porteau !== 'dist/cli.mjs')
    throw new Error('Installed package does not expose the expected porteau bin')

  const prefix = join(temporary, 'global-prefix')
  run(
    'npm',
    [
      'install',
      '--global',
      '--prefix',
      prefix,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      tarball,
    ],
    { cwd: project },
  )
  const globalCli = join(prefix, 'bin', 'porteau')
  if (run(globalCli, ['--version'], { cwd: project }).trim() !== installedMetadata.version)
    throw new Error('User-prefix installation returned the wrong Porteau version')
  if (retainedTarball) {
    mkdirSync(dirname(retainedTarball), { recursive: true })
    copyFileSync(tarball, retainedTarball)
  }
  console.log(`Package smoke passed (${files.length} files; packaged dist/cli.mjs invoked).`)
  if (retainedTarball) console.log(`Validated tarball retained at ${retainedTarball}.`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
