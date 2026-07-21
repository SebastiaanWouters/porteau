import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { parseToolVersion } from '../core/tools.js'
import { compatibilityManifest, type CompatibilityManifest } from './manifest.js'
import {
  minimumNodeVersion,
  nodeSourceFingerprint,
  nodeSourceKeyring,
  nodeSourceKeyUrl,
  nodeSourceList,
  nodeSourceRepository,
  nodeTargetMajor,
} from './policy.js'
import type { DiagnosticsResult } from './diagnostics.js'

const execFileAsync = promisify(execFile)
export type InstallApproval = { readonly kind: 'approved' }
export const approvedInstall: InstallApproval = Object.freeze({ kind: 'approved' })

export interface InstallPlan {
  readonly supported: boolean
  readonly node: boolean
  readonly nativeTools: boolean
  readonly asset?: CompatibilityManifest['assets'][number]
  readonly warnings: readonly string[]
  readonly blockers: readonly string[]
}

export function planUbuntuInstall(
  diagnostics: DiagnosticsResult,
  env: NodeJS.ProcessEnv = process.env,
): InstallPlan {
  const asset = diagnostics.system.supported
    ? compatibilityManifest.assets.find(
        (entry) =>
          entry.ubuntu === diagnostics.system.version &&
          entry.codename === diagnostics.system.codename &&
          entry.architecture === diagnostics.system.architecture,
      )
    : undefined
  const managed = ['NVM_DIR', 'ASDF_DIR', 'MISE_DATA_DIR', 'VOLTA_HOME'].filter((name) => env[name])
  const blockers = (['mydumper', 'myloader'] as const).flatMap((name) => {
    const tool = diagnostics.tools[name]
    return tool.status === 'error' &&
      tool.path &&
      ['config', 'environment'].includes(tool.source ?? '')
      ? [
          `The explicit ${name} ${tool.source} path remains authoritative and cannot be repaired by APT: ${tool.path}`,
        ]
      : []
  })
  return {
    supported: Boolean(asset),
    node: diagnostics.node.status !== 'ok',
    nativeTools: diagnostics.toolPair.status !== 'ok',
    ...(asset ? { asset } : {}),
    warnings: managed.length
      ? [
          `User-managed Node environment detected (${managed.join(', ')}); system Node will not replace its shims.`,
        ]
      : [],
    blockers,
  }
}

export function renderInstallPlan(plan: InstallPlan): string[] {
  const lines = ['Porteau setup plan (no changes have been made)']
  if (!plan.supported) return [...lines, 'Automatic installation is unavailable for this system.']
  if (plan.blockers.length > 0) return [...lines, ...plan.blockers]
  if (!plan.node && !plan.nativeTools) return [...lines, 'No changes required.']
  if (plan.node) {
    lines.push(
      `Node.js target: ${nodeTargetMajor} from the third-party NodeSource repository.`,
      `Signing key: ${nodeSourceKeyUrl}`,
      `Required fingerprint: ${nodeSourceFingerprint}`,
      `Repository: ${nodeSourceRepository}`,
      `sudo install -m 0644 <verified-keyring> ${nodeSourceKeyring}`,
      `sudo install -m 0644 <verified-source-list> ${nodeSourceList}`,
      'sudo apt-get update',
      `Validate with: apt-cache madison nodejs (require NodeSource node_${nodeTargetMajor}.x and major ${nodeTargetMajor})`,
      `sudo apt-get install --yes nodejs=<validated NodeSource ${nodeTargetMajor} candidate>`,
    )
  }
  if (plan.nativeTools && plan.asset) {
    lines.push(
      `Native package: mydumper/myloader ${compatibilityManifest.engine.version} from ${plan.asset.url}`,
      `Required size: ${plan.asset.size}; required SHA-256: ${plan.asset.sha256}`,
      `sudo apt-get install --yes ./${plan.asset.filename} (from the verified temporary directory)`,
    )
  }
  return [...lines, ...plan.warnings]
}

export interface InstallerDependencies {
  readonly download: (url: string, destination: string, signal?: AbortSignal) => Promise<void>
  readonly run: (
    command: string,
    args: readonly string[],
    options?: { readonly cwd?: string },
  ) => Promise<{ stdout: string; stderr?: string }>
  readonly makeTemporaryDirectory: () => Promise<string>
  readonly remove: (path: string) => Promise<void>
}

const defaultDependencies: InstallerDependencies = {
  async download(url, destination, signal) {
    let next = new URL(url)
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      if (next.protocol !== 'https:') throw new Error('Downloads require HTTPS')
      const response = await fetch(next, {
        redirect: 'manual',
        ...(signal ? { signal } : {}),
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location || redirects === 5) throw new Error('Download redirect was invalid')
        next = new URL(location, next)
        continue
      }
      if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}`)
      await writeFile(destination, new Uint8Array(await response.arrayBuffer()), { flag: 'wx' })
      return
    }
  },
  async run(command, args, options) {
    const result = await execFileAsync(command, [...args], {
      encoding: 'utf8',
      ...(options?.cwd ? { cwd: options.cwd } : {}),
    })
    return { stdout: result.stdout, stderr: result.stderr }
  },
  makeTemporaryDirectory: () => mkdtemp(join(tmpdir(), 'porteau-setup-')),
  remove: (path) => rm(path, { recursive: true, force: true }),
}

function nodeVersionSupported(output: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)\r?\n?$/u.exec(output)
  if (!match) return false
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number]
  const [minimumMajor, minimumMinor, minimumPatch] = minimumNodeVersion.split('.').map(Number) as [
    number,
    number,
    number,
  ]
  return (
    major > minimumMajor ||
    (major === minimumMajor &&
      (minor > minimumMinor || (minor === minimumMinor && patch >= minimumPatch)))
  )
}

function primaryFingerprints(colons: string): string[] {
  const fingerprints: string[] = []
  let primary = false
  for (const line of colons.split(/\r?\n/u)) {
    const fields = line.split(':')
    if (fields[0] === 'pub') primary = true
    else if (fields[0] === 'sub') primary = false
    else if (fields[0] === 'fpr' && primary) {
      if (fields[9]) fingerprints.push(fields[9])
      primary = false
    }
  }
  return fingerprints
}

async function verifyInstalledDependencies(dependencies: InstallerDependencies): Promise<void> {
  try {
    const node = await dependencies.run('node', ['--version'])
    const npm = await dependencies.run('npm', ['--version'])
    if (!nodeVersionSupported(node.stdout) || !/^\d+\.\d+\.\d+\r?\n?$/u.test(npm.stdout))
      throw new Error('invalid Node.js or npm version')
    for (const name of ['mydumper', 'myloader'] as const) {
      const inspected = await dependencies.run(name, ['--version'])
      const version = parseToolVersion(name, `${inspected.stdout}${inspected.stderr ?? ''}`)
      if (!compatibilityManifest.engine.tools[name].acceptedVersions.includes(version))
        throw new Error(`unsupported ${name} version`)
      const help = await dependencies.run(name, ['--help'])
      if (!`${help.stdout}${help.stderr ?? ''}`.includes('--machine-log-json'))
        throw new Error(`${name} lacks machine logging`)
    }
  } catch {
    throw new Error('Post-install dependency verification failed')
  }
}

export async function executeInstallPlan(
  plan: InstallPlan,
  approval: InstallApproval,
  dependencies: InstallerDependencies = defaultDependencies,
  signal?: AbortSignal,
): Promise<void> {
  if (approval !== approvedInstall)
    throw new Error('Explicit typed installation approval is required')
  if (!plan.supported) throw new Error('Automatic installation is unsupported on this system')
  if (plan.blockers.length > 0) throw new Error(plan.blockers.join('; '))
  if (!plan.node && !plan.nativeTools) return
  signal?.throwIfAborted()
  const directory = await dependencies.makeTemporaryDirectory()
  try {
    signal?.throwIfAborted()
    let packagePath: string | undefined
    if (plan.nativeTools && plan.asset) {
      packagePath = join(directory, plan.asset.filename)
      await dependencies.download(plan.asset.url, packagePath, signal)
      signal?.throwIfAborted()
      const [metadata, bytes] = await Promise.all([stat(packagePath), readFile(packagePath)])
      signal?.throwIfAborted()
      if (metadata.size !== plan.asset.size)
        throw new Error('Downloaded mydumper package size mismatch')
      if (createHash('sha256').update(bytes).digest('hex') !== plan.asset.sha256)
        throw new Error('Downloaded mydumper package checksum mismatch')
    }
    if (plan.node) {
      const key = join(directory, 'nodesource.asc')
      const keyring = join(directory, 'nodesource.gpg')
      await dependencies.download(nodeSourceKeyUrl, key, signal)
      signal?.throwIfAborted()
      const fingerprint = await dependencies.run('gpg', [
        '--batch',
        '--show-keys',
        '--with-colons',
        key,
      ])
      signal?.throwIfAborted()
      if (primaryFingerprints(fingerprint.stdout).join() !== nodeSourceFingerprint)
        throw new Error('NodeSource signing key fingerprint mismatch')
      await dependencies.run('gpg', ['--batch', '--dearmor', '--output', keyring, key])
      signal?.throwIfAborted()
      const keyringFingerprint = await dependencies.run('gpg', [
        '--batch',
        '--show-keys',
        '--with-colons',
        keyring,
      ])
      signal?.throwIfAborted()
      if (primaryFingerprints(keyringFingerprint.stdout).join() !== nodeSourceFingerprint)
        throw new Error('Generated NodeSource keyring fingerprint mismatch')
      signal?.throwIfAborted()
      await dependencies.run('sudo', ['install', '-m', '0644', keyring, nodeSourceKeyring])
      signal?.throwIfAborted()
      const source = join(directory, 'nodesource.list')
      await writeFile(source, `${nodeSourceRepository}\n`)
      signal?.throwIfAborted()
      await dependencies.run('sudo', ['install', '-m', '0644', source, nodeSourceList])
      signal?.throwIfAborted()
      await dependencies.run('sudo', ['apt-get', 'update'])
      signal?.throwIfAborted()
      const candidates = await dependencies.run('apt-cache', ['madison', 'nodejs'])
      signal?.throwIfAborted()
      const candidate = candidates.stdout
        .split(/\r?\n/u)
        .map((line) => line.split('|').map((field) => field.trim()))
        .find(
          ([name, version, source]) =>
            name === 'nodejs' &&
            version?.startsWith(`${nodeTargetMajor}.`) &&
            source?.startsWith(`https://deb.nodesource.com/node_${nodeTargetMajor}.x`),
        )?.[1]
      if (!candidate)
        throw new Error(`NodeSource did not provide a Node.js ${nodeTargetMajor} candidate`)
      signal?.throwIfAborted()
      await dependencies.run('sudo', ['apt-get', 'install', '--yes', `nodejs=${candidate}`])
      signal?.throwIfAborted()
    }
    if (packagePath) {
      signal?.throwIfAborted()
      await dependencies.run('sudo', ['apt-get', 'install', '--yes', `./${plan.asset!.filename}`], {
        cwd: directory,
      })
      signal?.throwIfAborted()
    }
    await verifyInstalledDependencies(dependencies)
  } finally {
    await dependencies.remove(directory)
  }
}
