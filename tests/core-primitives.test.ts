import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { validateArtifact, verifyMydumperArtifact } from '../src/core/artifact.js'
import { createCredentialsDefaultsFile, escapeDefaultsValue } from '../src/core/credentials.js'
import {
  assertArtifactSafeIdentifiers,
  expandTablePatterns,
  exactTableRegex,
  resolveObjectScopes,
  serializeDefaultsSection,
} from '../src/core/filters.js'
import { parseToolVersion, resolveTool } from '../src/core/tools.js'

const temporaryDirectories: string[] = []
async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe('native tool resolution', () => {
  it('uses environment, config, then PATH and never falls through an invalid explicit path', async () => {
    const directory = await temporaryDirectory('porteau-tools-')
    for (const name of ['env-tool', 'config-tool', 'mydumper']) {
      await writeFile(join(directory, name), '')
      await chmod(join(directory, name), 0o700)
    }
    expect(
      await resolveTool('mydumper', {
        env: { PORTEAU_MYDUMPER: join(directory, 'env-tool'), PATH: directory },
        configPath: join(directory, 'config-tool'),
      }),
    ).toBe(join(directory, 'env-tool'))
    expect(
      await resolveTool('mydumper', {
        env: { PATH: directory },
        configPath: join(directory, 'config-tool'),
      }),
    ).toBe(join(directory, 'config-tool'))
    expect(await resolveTool('mydumper', { env: { PATH: directory } })).toBe(
      join(directory, 'mydumper'),
    )
    await expect(
      resolveTool('mydumper', {
        env: { PORTEAU_MYDUMPER: join(directory, 'missing'), PATH: directory },
      }),
    ).rejects.toThrow(/not executable/)
  })

  it('parses only the exact native version line', () => {
    expect(
      parseToolVersion(
        'myloader',
        'myloader v1.0.3-1, built against MySQL 8.0.46 with SSL support\n',
      ),
    ).toBe('1.0.3-1')
    expect(() => parseToolVersion('myloader', 'prefix myloader v1.0.3-1\n')).toThrow()
    expect(() => parseToolVersion('myloader', 'mydumper v1.0.3-1\n')).toThrow()
  })
})

describe('credentials defaults file', () => {
  it('protects, escapes, and idempotently cleans up credentials', async () => {
    const file = await createCredentialsDefaultsFile({
      host: 'local"host',
      port: 3306,
      user: 'u\\ser',
      password: 'line\nsecret',
      tls: 'verify-identity',
    })
    expect((await lstat(file.path)).mode & 0o777).toBe(0o600)
    const contents = await readFile(file.path, 'utf8')
    expect(contents).toContain('host="local\\"host"')
    expect(contents).toContain('password="line\\nsecret"')
    expect(contents).toContain('ssl-mode=VERIFY_IDENTITY')
    await file.cleanup()
    await file.cleanup()
    await expect(lstat(file.path)).rejects.toThrow()
    expect(() => escapeDefaultsValue('bad\0value')).toThrow(/NUL/)
  })

  it('maps preferred TLS to native REQUIRED', async () => {
    const file = await createCredentialsDefaultsFile({
      host: 'localhost',
      port: 3306,
      user: 'u',
      password: 'p',
      tls: 'preferred',
    })
    expect(await readFile(file.path, 'utf8')).toContain('ssl-mode=REQUIRED')
    await file.cleanup()
  })
})

describe('table filters', () => {
  const catalog = [
    { database: 'app', table: 'users' },
    { database: 'app', table: 'cache_1' },
    { database: 'app+', table: 'literal.table' },
  ]

  it('supports only star/question glob syntax and rejects unmatched patterns', () => {
    expect(expandTablePatterns(['app.cache_?'], catalog)).toEqual([catalog[1]])
    expect(expandTablePatterns(['app+.literal.table'], catalog)).toEqual([catalog[2]])
    expect(() => expandTablePatterns(['app.missing*'], catalog)).toThrow(/matched nothing/)
    expect(expandTablePatterns(['app.missing*'], catalog, { allowUnmatched: true })).toEqual([])
    expect(serializeDefaultsSection(catalog[0]!)).toBe('[`app`.`users`]')
    expect(() => serializeDefaultsSection({ database: 'app', table: 'bad`name' })).toThrow(
      /backticks/,
    )
    expect(exactTableRegex([catalog[2]!])).toBe('^(?:app\\+\\.literal\\.table)$')
    expect(() => assertArtifactSafeIdentifiers([catalog[2]!])).toThrow(/Unsupported/)
    expect(() => assertArtifactSafeIdentifiers([catalog[0]!])).not.toThrow()
  })

  it('maps independent exclusions and omits tables excluded from both', () => {
    expect(
      resolveObjectScopes(catalog, {
        schema: ['app.cache_*', 'app+.literal.table'],
        data: ['app.users', 'app+.literal.table'],
      }),
    ).toEqual([
      { ...catalog[0], serialized: '`app`.`users`', scope: 'SCHEMA' },
      { ...catalog[1], serialized: '`app`.`cache_1`', scope: 'DATA' },
    ])
  })

  it('rejects DATA-only views and dollar signs in artifact identifiers', () => {
    const view = { database: 'app', table: 'summary', kind: 'view' as const }
    expect(() => resolveObjectScopes([view], { schema: ['app.summary'], data: [] })).toThrow(
      /Views cannot use DATA-only/,
    )
    expect(() => assertArtifactSafeIdentifiers([{ database: 'app', table: 'price$' }])).toThrow()
  })

  it('writes concrete non-ALL object scopes to the protected defaults file', async () => {
    const file = await createCredentialsDefaultsFile(
      { host: 'localhost', port: 3306, user: 'backup', password: 'secret' },
      [
        { database: 'app', table: 'schema_only', serialized: '', scope: 'SCHEMA' },
        { database: 'app', table: 'everything', serialized: '', scope: 'ALL' },
      ],
    )
    expect(await readFile(file.path, 'utf8')).toContain(
      '[`app`.`schema_only`]\nobject_to_export=SCHEMA',
    )
    expect(await readFile(file.path, 'utf8')).not.toContain('everything')
    await file.cleanup()
  })
})

describe('artifact validation', () => {
  it('requires complete metadata and every extracted file', async () => {
    const root = await temporaryDirectory('porteau-artifact-')
    await mkdir(join(root, 'data'))
    await writeFile(join(root, 'metadata'), 'data/chunk.sql')
    await writeFile(join(root, 'data/chunk.sql'), 'rows')
    await expect(validateArtifact(root, (metadata) => [metadata])).resolves.toEqual({
      paths: ['data/chunk.sql'],
    })
    await writeFile(join(root, 'metadata.partial'), '')
    await expect(validateArtifact(root, () => [])).rejects.toThrow(/incomplete/)
  })

  it('rejects traversal and symlinks escaping the artifact root', async () => {
    const root = await temporaryDirectory('porteau-artifact-')
    const outside = await temporaryDirectory('porteau-outside-')
    await writeFile(join(root, 'metadata'), '')
    await writeFile(join(outside, 'secret'), '')
    await symlink(join(outside, 'secret'), join(root, 'link'))
    await expect(validateArtifact(root, () => ['../outside'])).rejects.toThrow(/escapes/)
    await expect(validateArtifact(root, () => ['link'])).rejects.toThrow(/symlink escapes/)
    await expect(validateArtifact(root, () => ['missing'])).rejects.toThrow()
  })

  it('does not mistake trigger files for a base schema and honors disabled triggers', async () => {
    const root = await temporaryDirectory('porteau-artifact-')
    await writeFile(join(root, 'metadata'), '[`app`.`users`]\nrows = 0\n')
    await writeFile(join(root, 'app-schema-create.sql'), '')
    await writeFile(join(root, 'app.users-schema-triggers.sql'), '')
    const table = {
      database: 'app',
      table: 'users',
      serialized: '`app`.`users`',
      scope: 'ALL',
      kind: 'base-table',
      hasTriggers: true,
    } as const
    await expect(verifyMydumperArtifact(root, [table], { triggers: true })).rejects.toThrow(
      /missing schema/,
    )
    await writeFile(join(root, 'app.users-schema.sql'), '')
    await rm(join(root, 'app.users-schema-triggers.sql'))
    await expect(
      verifyMydumperArtifact(root, [table], { triggers: false }),
    ).resolves.toBeUndefined()
    await expect(
      verifyMydumperArtifact(root, [table], { triggers: false, expectedFiles: 99 }),
    ).rejects.toThrow(/file count disagrees/)
  })
})
