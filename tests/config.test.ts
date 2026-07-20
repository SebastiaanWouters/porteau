import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { loadConfig } from '../src/core/config.js'

const temporaryDirectories: string[] = []

async function createWorkspace(files: Record<string, string> = {}): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'porteau-config-'))
  temporaryDirectories.push(cwd)
  await Promise.all(
    Object.entries(files).map(([name, contents]) => writeFile(join(cwd, name), contents)),
  )
  return cwd
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

describe('configuration contract', () => {
  it('loads defaults when no configuration exists', async () => {
    const config = await loadConfig({ cwd: await createWorkspace(), env: {} })

    expect(config.connection.host).toBe('localhost')
    expect(config.backup.threads).toBe(4)
  })

  it('applies YAML over defaults', async () => {
    const cwd = await createWorkspace({
      'porteau.config.yaml': 'backup:\n  threads: 2\n',
    })

    expect((await loadConfig({ cwd, env: {} })).backup.threads).toBe(2)
  })

  it('applies environment over YAML', async () => {
    const cwd = await createWorkspace({
      'porteau.config.yaml': 'connection:\n  host: from-file\n',
    })

    const config = await loadConfig({ cwd, env: { PORTEAU_HOST: 'from-env' } })

    expect(config.connection.host).toBe('from-env')
  })

  it('applies flags over environment', async () => {
    const cwd = await createWorkspace()

    const config = await loadConfig({
      cwd,
      env: { PORTEAU_HOST: 'from-env' },
      flags: { connection: { host: 'from-flag' } },
    })

    expect(config.connection.host).toBe('from-flag')
  })

  it('replaces arrays and honors explicit null overrides', async () => {
    const cwd = await createWorkspace({
      'porteau.config.yaml': [
        'exclude:',
        '  schema: ["db.file_only"]',
        'backup:',
        '  throttle:',
        '    threshold: 10',
      ].join('\n'),
    })

    const config = await loadConfig({
      cwd,
      env: {},
      flags: { exclude: { schema: [] }, backup: { throttle: { threshold: null } } },
    })

    expect(config.exclude.schema).toEqual([])
    expect(config.backup.throttle.threshold).toBeNull()
  })

  it.each(['invalid', ''])('rejects an invalid environment port %j', async (port) => {
    await expect(
      loadConfig({ cwd: await createWorkspace(), env: { PORTEAU_PORT: port } }),
    ).rejects.toThrow()
  })

  it('requires an explicitly selected config file to exist', async () => {
    await expect(
      loadConfig({ cwd: await createWorkspace(), configFile: 'missing.yaml', env: {} }),
    ).rejects.toThrow(/cannot be resolved/)
  })

  it('accepts only YAML configuration paths', async () => {
    await expect(loadConfig({ configFile: 'porteau.config.ts', env: {} })).rejects.toThrow(
      /must use the .yaml or .yml extension/,
    )
  })

  it('ignores implicit executable and RC configuration sources', async () => {
    const cwd = await createWorkspace({
      'porteau.config.ts': 'export default { backup: { threads: 99 } }',
      '.porteaurc': 'backup:\n  threads: 98\n',
    })

    expect((await loadConfig({ cwd, env: {} })).backup.threads).toBe(4)
  })

  it('rejects configuration inheritance', async () => {
    const cwd = await createWorkspace({
      'porteau.config.yaml': 'extends: https://example.com/untrusted-config\n',
    })

    await expect(loadConfig({ cwd, env: {} })).rejects.toThrow()
  })

  it.each([
    { profile: 'production', consistency: { mode: 'safe-no-lock' } },
    { profile: 'replica', consistency: { requireInnoDB: false } },
    { profile: 'production', consistency: { protectDdl: false } },
  ])('rejects weakened consistency outside expert mode', async (backup) => {
    await expect(
      loadConfig({ cwd: await createWorkspace(), env: {}, flags: { backup } }),
    ).rejects.toThrow(/require automatic locking/)
  })

  it('allows explicitly weakened consistency in expert mode', async () => {
    const config = await loadConfig({
      cwd: await createWorkspace(),
      env: {},
      flags: {
        backup: {
          profile: 'expert',
          consistency: { mode: 'safe-no-lock', requireInnoDB: false, protectDdl: false },
        },
      },
    })

    expect(config.backup.profile).toBe('expert')
  })
})
