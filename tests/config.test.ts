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
        '  tables: ["db.file_only"]',
        'backup:',
        '  throttle:',
        '    threshold: 10',
      ].join('\n'),
    })

    const config = await loadConfig({
      cwd,
      env: {},
      flags: { exclude: { tables: [] }, backup: { throttle: { threshold: null } } },
    })

    expect(config.exclude.tables).toEqual([])
    expect(config.backup.throttle.threshold).toBeNull()
  })

  it('rejects the legacy data-only exclusion with migration guidance', async () => {
    const cwd = await createWorkspace({
      'porteau.config.yaml': 'exclude:\n  schema: ["db.data_only"]\n',
    })

    await expect(loadConfig({ cwd, env: {} })).rejects.toThrow(
      /exclude\.schema is unsupported.*exclude\.tables.*exclude\.data/u,
    )
  })

  it.each(['invalid', ''])('rejects an invalid environment port %j', async (port) => {
    await expect(
      loadConfig({ cwd: await createWorkspace(), env: { PORTEAU_PORT: port } }),
    ).rejects.toThrow(/Invalid value at connection\.port/)
  })

  it('does not retain invalid configuration values in validation errors', async () => {
    const secret = 'distinctive-invalid-password-8ba1'
    let failure: unknown
    try {
      await loadConfig({
        cwd: await createWorkspace(),
        env: {},
        flags: { connection: { password: { secret } } },
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain('connection.password')
    expect(JSON.stringify(failure)).not.toContain(secret)
    expect(String(failure)).not.toContain(secret)
  })

  it('redacts malformed YAML source and unknown strict-object keys', async () => {
    const secret = 'distinctive-config-source-secret-c291'
    const malformed = await createWorkspace({
      'porteau.config.yaml': `connection:\n  password: ${secret}\n  broken: *missing\n`,
    })
    await expect(loadConfig({ cwd: malformed, env: {} })).rejects.toThrow(
      /^Unable to load Porteau configuration$/,
    )

    let strictFailure: unknown
    try {
      await loadConfig({ cwd: await createWorkspace(), env: {}, flags: { [secret]: true } })
    } catch (error) {
      strictFailure = error
    }
    expect(String(strictFailure)).toContain('unknown key')
    expect(String(strictFailure)).not.toContain(secret)
  })

  it('requires an explicitly selected config file to exist', async () => {
    await expect(
      loadConfig({ cwd: await createWorkspace(), configFile: 'missing.yaml', env: {} }),
    ).rejects.toThrow(/Unable to load Porteau configuration/)
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
    { profile: 'production', consistency: { protectDdl: false } },
    {
      profile: 'production',
      consistency: { mode: 'no-lock', protectDdl: true },
    },
  ])('rejects unqualified consistency configurations', async (backup) => {
    await expect(
      loadConfig({ cwd: await createWorkspace(), env: {}, flags: { backup } }),
    ).rejects.toThrow(/unsafe or unqualified/)
  })

  it('allows qualified lockless InnoDB behavior in expert mode', async () => {
    const config = await loadConfig({
      cwd: await createWorkspace(),
      env: {},
      flags: {
        backup: {
          profile: 'expert',
          consistency: { mode: 'safe-no-lock', protectDdl: false },
        },
      },
    })

    expect(config.backup.profile).toBe('expert')
  })

  it('allows no-lock outside expert mode when DDL protection is disabled', async () => {
    const config = await loadConfig({
      cwd: await createWorkspace(),
      env: {},
      flags: {
        backup: {
          consistency: { mode: 'no-lock', protectDdl: false },
        },
      },
    })

    expect(config.backup.consistency.mode).toBe('no-lock')
    expect(config.backup.profile).toBe('production')
  })

  it.each([
    { backup: { consistency: { requireInnoDB: true } } },
    { backup: { throttle: { variable: 'Threads_running' } } },
    { objects: { routines: false } },
    { backup: { maxThreadsPerTable: 4 } },
    { restore: { verifyChecksums: 'warn' } },
  ])('rejects removed public keys as unknown %#', async (flags) => {
    await expect(loadConfig({ cwd: await createWorkspace(), env: {}, flags })).rejects.toThrow(
      /unknown key/,
    )
  })

  it.each(['verify-ca', 'verify-identity'])(
    'rejects %s until CA paths are configurable',
    async (tls) => {
      await expect(
        loadConfig({
          cwd: await createWorkspace(),
          env: {},
          flags: { connection: { tls } },
        }),
      ).rejects.toThrow(/CA-verified TLS/)
    },
  )
})
