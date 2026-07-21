import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { formatDiagnostics } from '../src/commands/doctor.js'
import { executeCli } from '../src/cli.js'
import { ToolResolutionError } from '../src/core/tools.js'
import { runDiagnostics, type DiagnosticsOptions } from '../src/setup/diagnostics.js'

const ubuntuRelease = `ID=ubuntu
PRETTY_NAME="Ubuntu 24.04.2 LTS"
VERSION_ID="24.04"
VERSION_CODENAME=noble
`

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

function toolDependencies(
  versions: Partial<Record<'mydumper' | 'myloader', string>> = {},
): Pick<DiagnosticsOptions, 'resolve' | 'inspect'> {
  return {
    async resolve(name) {
      return { path: `/tools/${name}`, source: 'path' }
    },
    async inspect(name, path) {
      return { name, path, version: versions[name] ?? '1.0.3-1' }
    },
  }
}

describe('read-only setup diagnostics', () => {
  it('recognizes a supported Ubuntu target and matching supported tools', async () => {
    const result = await runDiagnostics({
      platform: 'linux',
      architecture: 'x64',
      nodeVersion: 'v22.18.0',
      readTextFile: async () => ubuntuRelease,
      ...toolDependencies(),
    })

    expect(result).toMatchObject({
      ok: true,
      system: {
        status: 'ok',
        supported: true,
        codename: 'noble',
        architecture: 'amd64',
      },
      node: { status: 'ok', version: '22.18.0' },
      tools: {
        mydumper: { status: 'ok', source: 'path', version: '1.0.3-1' },
        myloader: { status: 'ok', source: 'path', version: '1.0.3-1' },
      },
      toolPair: { status: 'ok' },
    })
  })

  it('checks tools independently and returns actionable failures instead of throwing', async () => {
    const resolved: string[] = []
    const result = await runDiagnostics({
      platform: 'darwin',
      architecture: 'arm64',
      nodeVersion: '20.17.0',
      async resolve(name) {
        resolved.push(name)
        if (name === 'mydumper') {
          throw new ToolResolutionError(name, 'path', 'not-found')
        }
        return { path: '/tools/myloader', source: 'config' }
      },
      async inspect(name, path) {
        return { name, path, version: '1.0.2-1' }
      },
    })

    expect(resolved).toEqual(['mydumper', 'myloader'])
    expect(result.ok).toBe(false)
    expect(result.system).toMatchObject({ status: 'warning', supported: false })
    expect(result.node.correction).toContain('Node.js 22.18.0')
    expect(result.tools.mydumper).toMatchObject({ status: 'error', source: 'path' })
    expect(result.tools.mydumper.correction).toContain('configure its path explicitly')
    expect(result.tools.myloader).toMatchObject({
      status: 'error',
      path: '/tools/myloader',
      source: 'config',
      version: '1.0.2-1',
    })
    expect(result.tools.myloader.correction).toContain('1.0.3-1')
    expect(result.toolPair.correction).toContain('Resolve both')
  })

  it('formats stable plain output with a correction for every failed check', async () => {
    const result = await runDiagnostics({
      platform: 'linux',
      architecture: 'arm64',
      nodeVersion: '22.18.0',
      readTextFile: async () => 'ID=debian\nPRETTY_NAME="Debian 12"\nVERSION_ID="12"\n',
      ...toolDependencies({ myloader: '1.0.2-1' }),
    })
    const output = formatDiagnostics(result).join('\n')

    expect(output).toContain('Porteau diagnostics (read-only)')
    expect(output).toContain('[warn] System: Debian 12, arm64')
    expect(output).toContain('[ok] mydumper: 1.0.3-1 at /tools/mydumper (path)')
    expect(output).toContain('[error] myloader: 1.0.2-1 at /tools/myloader (path)')
    expect(output).toContain('System note: Automatic setup supports Ubuntu')
    expect(output).toContain('Diagnostics found blocking dependency issues.')
  })

  it('strips database passwords and never renders arbitrary inspection errors', async () => {
    const secret = 'diagnostic-password-sentinel-82c9'
    const inspectedEnvironments: NodeJS.ProcessEnv[] = []
    const result = await runDiagnostics({
      platform: 'linux',
      architecture: 'x64',
      nodeVersion: '22.18.0',
      env: { PATH: '/tools', PORTEAU_PASSWORD: secret },
      readTextFile: async () => ubuntuRelease,
      async resolve(name) {
        return { path: `/tools/${name}`, source: 'path' }
      },
      async inspect(name, path, environment) {
        inspectedEnvironments.push(environment ?? {})
        if (name === 'myloader') throw new Error(`hostile child echoed ${secret}`)
        return { name, path, version: '1.0.3-1' }
      },
    })

    expect(inspectedEnvironments).toHaveLength(2)
    expect(inspectedEnvironments.every((environment) => !('PORTEAU_PASSWORD' in environment))).toBe(
      true,
    )
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(formatDiagnostics(result).join('\n')).not.toContain(secret)
    expect(result.tools.myloader.correction).toBe(
      'Unable to inspect myloader version; reinstall it from the supported package.',
    )
  })

  it('implements stable Node version boundaries without accepting prereleases or suffixes', async () => {
    for (const [version, status] of [
      ['22.17.9', 'error'],
      ['22.18.0', 'ok'],
      ['24.0.0', 'ok'],
      ['22.18.0-rc.1', 'error'],
      ['22.18.0garbage', 'error'],
    ] as const) {
      const result = await runDiagnostics({
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: version,
        readTextFile: async () => ubuntuRelease,
        ...toolDependencies(),
      })
      expect(result.node.status, version).toBe(status)
    }
  })

  it('runs doctor and setup checks with config-relative paths and strict overrides', async () => {
    const root = await mkdtemp(join(tmpdir(), 'porteau-diagnostics-'))
    temporaryDirectories.push(root)
    const configDirectory = join(root, 'configuration')
    const binDirectory = join(configDirectory, 'bin')
    await mkdir(binDirectory, { recursive: true })
    const fixture = resolve(dirname(import.meta.filename), 'fixtures/subprocess.mjs')
    await symlink(fixture, join(binDirectory, 'mydumper'))
    await symlink(fixture, join(binDirectory, 'myloader'))
    const configFile = join(configDirectory, 'porteau.yaml')
    await writeFile(configFile, 'tools:\n  mydumper: ./bin/mydumper\n  myloader: ./bin/myloader\n')

    const output: string[] = []
    const errors: string[] = []
    const previousMydumper = process.env.PORTEAU_MYDUMPER
    const previousMyloader = process.env.PORTEAU_MYLOADER
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk))
      return true
    })
    delete process.env.PORTEAU_MYDUMPER
    delete process.env.PORTEAU_MYLOADER
    try {
      expect(
        await executeCli({
          args: ['doctor', '--config', configFile],
          stderr: (line) => errors.push(line),
        }),
      ).toBe(0)
      expect(
        await executeCli({
          args: ['setup', '--check', '--config', configFile],
          stderr: (line) => errors.push(line),
        }),
      ).toBe(0)
      expect(output.join('')).toContain(join(binDirectory, 'mydumper'))
      expect(output.join('').match(/Diagnostics passed\./gu)).toHaveLength(2)

      const invalidOverride = join(root, 'missing-mydumper')
      process.env.PORTEAU_MYDUMPER = invalidOverride
      expect(
        await executeCli({
          args: ['doctor', '--config', configFile],
          stderr: (line) => errors.push(line),
        }),
      ).toBe(1)
      expect(output.join('')).toContain(`${invalidOverride} (environment)`)
      expect(errors.at(-1)).toBe('error: Dependency diagnostics failed')
      delete process.env.PORTEAU_MYDUMPER

      expect(await executeCli({ args: ['setup'], stderr: (line) => errors.push(line) })).toBe(1)
      expect(errors.at(-1)).toContain('use porteau setup --check')

      await unlink(join(binDirectory, 'myloader'))
      await writeFile(
        join(binDirectory, 'myloader'),
        '#!/usr/bin/env node\nconsole.log("myloader v1.0.2-1, built against MySQL 8.0.46 with SSL support")\n',
      )
      await chmod(join(binDirectory, 'myloader'), 0o700)
      expect(
        await executeCli({
          args: ['setup', '--check', '--config', configFile],
          stderr: (line) => errors.push(line),
        }),
      ).toBe(1)
      expect(output.join('')).toContain('[error] myloader: 1.0.2-1')
    } finally {
      writeSpy.mockRestore()
      if (previousMydumper === undefined) delete process.env.PORTEAU_MYDUMPER
      else process.env.PORTEAU_MYDUMPER = previousMydumper
      if (previousMyloader === undefined) delete process.env.PORTEAU_MYLOADER
      else process.env.PORTEAU_MYLOADER = previousMyloader
    }
  })
})
