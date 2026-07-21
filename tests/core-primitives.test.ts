import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import {
  validateArtifact,
  verifyMydumperArtifact,
  verifyRestoreArtifact,
} from '../src/core/artifact.js'
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

  it('resolves only complete, schema-only, and omitted tables', () => {
    expect(
      resolveObjectScopes(catalog, {
        tables: ['app.cache_*'],
        data: ['app.users', 'app.cache_*'],
      }),
    ).toEqual([
      { ...catalog[0], serialized: '`app`.`users`', scope: 'SCHEMA' },
      { ...catalog[2], serialized: '`app+`.`literal.table`', scope: 'ALL' },
    ])
  })

  it('can omit views and rejects dollar signs in artifact identifiers', () => {
    const view = { database: 'app', table: 'summary', kind: 'view' as const }
    expect(resolveObjectScopes([view], { tables: ['app.summary'], data: [] })).toEqual([])
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

  it('requires schema for every retained scope and honors disabled triggers', async () => {
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
    await expect(
      verifyMydumperArtifact(root, [{ ...table, scope: 'SCHEMA' }], { triggers: false }),
    ).rejects.toThrow(/missing schema/)
    await writeFile(join(root, 'app.users-schema.sql'), '')
    await rm(join(root, 'app.users-schema-triggers.sql'))
    await expect(
      verifyMydumperArtifact(root, [table], { triggers: false }),
    ).resolves.toBeUndefined()
    await expect(
      verifyMydumperArtifact(root, [table], { triggers: false, expectedFiles: 99 }),
    ).rejects.toThrow(/file count disagrees/)
  })

  it('requires schema for every restore object and rejects artifact-controlled binlogging', async () => {
    const root = await temporaryDirectory('porteau-restore-artifact-')
    await writeFile(join(root, 'metadata'), '[`app`.`empty_data_only`]\nrows = 0\n')
    await writeFile(join(root, 'app-schema-create.sql'), '')
    await expect(verifyRestoreArtifact(root, 'app')).rejects.toThrow(/missing schema/u)
    await writeFile(join(root, 'metadata'), '[`app`.`empty_data_only`]\nrows = 1\n')
    await writeFile(
      join(root, 'app.empty_data_only.00000.sql'),
      'INSERT INTO empty_data_only VALUES (1);',
    )
    await expect(verifyRestoreArtifact(root, 'app')).rejects.toThrow(/missing schema/u)
    await writeFile(join(root, 'app.empty_data_only-schema.sql'), '')
    await expect(verifyRestoreArtifact(root, 'app')).resolves.toMatchObject({
      rootPath: root,
      files: expect.arrayContaining(['metadata', 'app-schema-create.sql']),
    })

    await writeFile(
      join(root, 'metadata'),
      '[myloader_session_variables]\nSQL_LOG_BIN = 1\n[`app`.`users`]\nrows = 0\n',
    )
    await expect(verifyRestoreArtifact(root, 'app')).rejects.toThrow(/binlog policy/u)
    await writeFile(join(root, 'metadata'), '[`other`.`users`]\nrows = 0\n')
    await expect(verifyRestoreArtifact(root, 'app')).rejects.toThrow(/no restorable objects/u)
  })

  it('requires the qualified schema-file pair only for metadata-declared views', async () => {
    const base = await temporaryDirectory('porteau-restore-base-view-file-')
    await writeFile(join(base, 'metadata'), '[`app`.`users`]\nrows = 0\n')
    await writeFile(join(base, 'app-schema-create.sql'), '')
    await writeFile(join(base, 'app.users-schema-view.sql'), 'CREATE VIEW users AS SELECT 1;')
    await expect(verifyRestoreArtifact(base, 'app')).rejects.toThrow(/missing schema/u)
    await writeFile(join(base, 'app.users-schema.sql'), 'CREATE TABLE users (id INT);')
    await expect(verifyRestoreArtifact(base, 'app')).rejects.toThrow(/non-view object/u)

    const view = await temporaryDirectory('porteau-restore-view-')
    await writeFile(join(view, 'metadata'), '[`app`.`summary`]\nis_view = 1\n')
    await writeFile(join(view, 'app-schema-create.sql'), '')
    await writeFile(join(view, 'app.summary-schema.sql'), 'CREATE TABLE summary (value INT);')
    await expect(verifyRestoreArtifact(view, 'app')).rejects.toThrow(/missing view definition/u)
    await rm(join(view, 'app.summary-schema.sql'))
    await writeFile(join(view, 'app.summary-schema-view.sql'), 'CREATE VIEW summary AS SELECT 1;')
    await expect(verifyRestoreArtifact(view, 'app')).rejects.toThrow(/missing schema/u)
    await writeFile(join(view, 'app.summary-schema.sql'), 'CREATE TABLE summary (value INT);')
    await expect(verifyRestoreArtifact(view, 'app')).resolves.toMatchObject({ rootPath: view })
  })

  it('rejects loader control files and missing nonempty data chunks', async () => {
    for (const controlFile of [
      'metadata.header',
      'metadata.partial.0',
      'mydumper_other.users.00000.sql',
    ]) {
      const root = await temporaryDirectory('porteau-restore-control-')
      await writeFile(join(root, 'metadata'), '[`app`.`users`]\nrows = 0\n')
      await writeFile(join(root, 'app-schema-create.sql'), '')
      await writeFile(join(root, controlFile), '')
      await expect(verifyRestoreArtifact(root, 'app')).rejects.toThrow(/control file/u)
    }

    const incomplete = await temporaryDirectory('porteau-restore-incomplete-')
    await writeFile(join(incomplete, 'metadata'), '[`app`.`users`]\nrows = 1\n')
    await writeFile(join(incomplete, 'app-schema-create.sql'), '')
    await writeFile(join(incomplete, 'app.users-schema.sql'), '')
    await expect(verifyRestoreArtifact(incomplete, 'app')).rejects.toThrow(/missing data/u)

    const duplicate = await temporaryDirectory('porteau-restore-duplicate-')
    await writeFile(
      join(duplicate, 'metadata'),
      '[`app`.`users`]\nrows = 0\n[`app`.`users`]\nrows = 1\n',
    )
    await writeFile(join(duplicate, 'app-schema-create.sql'), '')
    await writeFile(join(duplicate, 'app.users-schema.sql'), '')
    await expect(verifyRestoreArtifact(duplicate, 'app')).rejects.toThrow(/duplicate object/u)
  })
})
