import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vite-plus/test'
import { executeCli } from '../src/cli.js'
import { loadConfig } from '../src/core/config.js'
import { config, diagnostics, noPrompts, roots } from './cli-fixtures.js'

describe('init, config, and doctor flows', () => {
  it('creates a protected valid config without a password and refuses overwrite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'porteau-init-'))
    roots.push(root)
    const path = join(root, 'porteau.yaml')
    const args = [
      'init',
      '-o',
      path,
      '--host',
      ' db ',
      '--user',
      ' backup ',
      '--database',
      'app, audit',
    ]
    const ambientLoad = vi.fn(async () => {
      throw new Error('ambient config must not be loaded')
    })
    expect(
      await executeCli({
        args,
        cwd: root,
        stdout: vi.fn(),
        stderr: vi.fn(),
        services: { loadConfig: ambientLoad },
      }),
    ).toBe(0)
    expect(ambientLoad).not.toHaveBeenCalled()
    const contents = await readFile(path, 'utf8')
    expect(contents).not.toMatch(/password:/u)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await loadConfig({ configFile: path, env: {} })).toMatchObject({
      defaults: { server: 'local', database: 'app' },
      servers: { local: { host: 'db', user: 'backup' } },
      databases: { app: { name: 'app' }, audit: { name: 'audit' } },
      artifacts: { directory: './backups' },
    })

    await writeFile(path, 'original')
    expect(await executeCli({ args, cwd: root, stdout: vi.fn(), stderr: vi.fn() })).toBe(1)
    expect(await readFile(path, 'utf8')).toBe('original')
    expect(await readdir(root)).toEqual(['porteau.yaml'])
  })

  it('does not create init output after prompt cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'porteau-init-cancel-'))
    roots.push(root)
    const path = join(root, 'cancelled.yaml')
    expect(
      await executeCli({
        args: ['init', '--output', path],
        cwd: root,
        stdout: vi.fn(),
        stderr: vi.fn(),
        env: {},
        stdinTTY: true,
        stdoutTTY: true,
        prompts: noPrompts,
      }),
    ).toBe(130)
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(root)).toEqual([])
  })

  it('omits config passwords in human and JSON output', async () => {
    const secret = 'config-secret-sentinel'
    for (const args of [['config'], ['config', '--json']]) {
      const output: string[] = []
      expect(
        await executeCli({
          args,
          stdout: (line) => output.push(line),
          stderr: (line) => output.push(line),
          services: {
            loadConfig: async () => config({ user: 'backup', password: secret }),
          },
        }),
      ).toBe(0)
      expect(output.join('\n')).not.toContain(secret)
      expect(output.join('\n')).toContain('passwordConfigured')
    }
  })

  it('renders one doctor failure and forwards cwd and environment', async () => {
    const output: string[] = []
    const cwd = '/injected/workspace'
    const env = { PATH: '/injected/bin' }
    let diagnosticOptions: unknown
    const collect = vi.fn(async (options: unknown) => {
      diagnosticOptions = options
      return diagnostics({ ok: false, toolPair: { status: 'error' } })
    })
    expect(
      await executeCli({
        args: ['doctor', '--json'],
        cwd,
        env,
        stdout: (line) => output.push(line),
        stderr: vi.fn(),
        services: { collectDiagnostics: collect },
      }),
    ).toBe(1)
    expect(diagnosticOptions).toMatchObject({ cwd, env })
    expect(
      output.map((line) => JSON.parse(line)).filter((record) => record.type === 'error'),
    ).toHaveLength(1)
    expect(output.map((line) => JSON.parse(line))[0]).toMatchObject({
      type: 'event',
      event: { type: 'diagnostics', data: { ok: false } },
    })
  })
})
