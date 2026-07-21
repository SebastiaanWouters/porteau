import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { serializeDefaultsSection, type ResolvedTable } from './filters.js'

export type ArtifactMetadataExtractor = (metadata: string) => readonly string[]

export interface RestoreArtifactVerification {
  readonly rootPath: string
  readonly files: readonly string[]
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

export async function validateArtifact(
  rootPath: string,
  extractPaths: ArtifactMetadataExtractor,
): Promise<{ readonly paths: readonly string[] }> {
  const root = await realpath(rootPath)
  const metadataPath = resolve(root, 'metadata')
  const metadataStats = await lstat(metadataPath)
  if (!metadataStats.isFile() || metadataStats.isSymbolicLink())
    throw new Error('Artifact metadata must be a regular file')
  const metadataRealPath = await realpath(metadataPath)
  if (!isWithin(root, metadataRealPath)) throw new Error('Artifact metadata escapes its root')
  const metadata = await readFile(metadataRealPath, 'utf8')
  try {
    await lstat(resolve(root, 'metadata.partial'))
    throw new Error('Artifact is incomplete: metadata.partial exists')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const paths = [...extractPaths(metadata)]
  for (const path of paths) {
    if (path === '' || isAbsolute(path)) throw new Error(`Unsafe artifact path: ${path}`)
    const candidate = resolve(root, path)
    if (!isWithin(root, candidate)) throw new Error(`Artifact path escapes its root: ${path}`)
    const actual = await realpath(candidate)
    if (!isWithin(root, actual)) throw new Error(`Artifact symlink escapes its root: ${path}`)
    const stats = await lstat(actual)
    if (!stats.isFile()) throw new Error(`Artifact path is not a file: ${path}`)
  }
  return { paths }
}

function sectionBody(metadata: string, heading: string): string | undefined {
  const start = metadata.indexOf(`${heading}\n`)
  if (start === -1) return undefined
  const bodyStart = start + heading.length + 1
  const end = metadata.indexOf('\n[', bodyStart)
  return metadata.slice(bodyStart, end === -1 ? undefined : end)
}

function assertArtifactDoesNotControlBinlog(metadata: string): void {
  let loaderVariables = false
  for (const line of metadata.split(/\r?\n/u)) {
    const trimmed = line.trim()
    const heading =
      trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : undefined
    if (heading !== undefined) {
      loaderVariables = /^myloader_session_variables(?:_.+)?$/iu.test(heading)
      continue
    }
    if (loaderVariables && /^\s*SQL_LOG_BIN\s*=/iu.test(line))
      throw new Error('Artifact metadata cannot override the explicit restore binlog policy')
  }
}

function artifactFilePresent(files: readonly string[], name: string): boolean {
  return files.some((file) => [name, `${name}.gz`, `${name}.zst`].includes(file))
}

function artifactHasData(files: readonly string[], stem: string): boolean {
  return files.some((file) => {
    const uncompressed = file.replace(/\.(?:gz|zst)$/u, '')
    const withoutFormat = uncompressed.replace(/\.(?:sql|dat)$/u, '')
    if (withoutFormat === uncompressed || !withoutFormat.startsWith(`${stem}.`)) return false
    return withoutFormat
      .slice(stem.length + 1)
      .split('.')
      .every((part) => /^\d+$/u.test(part))
  })
}

export async function verifyMydumperArtifact(
  rootPath: string,
  tables: readonly ResolvedTable[],
  options: {
    readonly triggers?: boolean
    readonly signal?: AbortSignal
    readonly expectedFiles?: number
  } = {},
): Promise<void> {
  if (options.signal?.aborted) throw new Error('Artifact verification cancelled')
  const root = await realpath(rootPath)
  const entries = await readdir(root, { withFileTypes: true })
  if (entries.some((entry) => !entry.isFile()))
    throw new Error('Artifact top-level entries must all be regular files')
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
  if (options.expectedFiles !== undefined && files.length !== options.expectedFiles)
    throw new Error(
      `Artifact file count disagrees with native completion: expected ${options.expectedFiles}, found ${files.length}`,
    )
  await validateArtifact(root, () => files.filter((file) => file !== 'metadata'))
  const metadata = await readFile(resolve(root, 'metadata'), 'utf8')

  for (const database of new Set(tables.map((table) => table.database))) {
    if (options.signal?.aborted) throw new Error('Artifact verification cancelled')
    const schema = `${database}-schema-create.sql`
    if (!files.some((file) => [schema, `${schema}.gz`, `${schema}.zst`].includes(file)))
      throw new Error(`Artifact is missing database schema for ${database}`)
  }

  for (const table of tables) {
    if (options.signal?.aborted) throw new Error('Artifact verification cancelled')
    const heading = serializeDefaultsSection(table)
    const body = sectionBody(metadata, heading)
    if (body === undefined) throw new Error(`Artifact metadata omits ${table.serialized}`)
    const stem = `${table.database}.${table.table}`
    if (table.scope !== 'DATA') {
      if (!artifactFilePresent(files, `${stem}-schema.sql`))
        throw new Error(`Artifact is missing schema for ${table.serialized}`)
      if (table.kind === 'view' && !artifactFilePresent(files, `${stem}-schema-view.sql`))
        throw new Error(`Artifact is missing view definition for ${table.serialized}`)
      if (
        options.triggers &&
        table.hasTriggers &&
        !artifactFilePresent(files, `${stem}-schema-triggers.sql`)
      )
        throw new Error(`Artifact is missing triggers for ${table.serialized}`)
    }
    const rows = /^rows\s*=\s*(\d+)\s*$/mu.exec(body)?.[1]
    if (table.kind !== 'view' && table.scope !== 'SCHEMA' && rows === undefined)
      throw new Error(`Artifact metadata omits row count for ${table.serialized}`)
    if (
      table.scope !== 'SCHEMA' &&
      rows !== undefined &&
      rows !== '0' &&
      !artifactHasData(files, stem)
    )
      throw new Error(`Artifact is missing data for ${table.serialized}`)
  }
}

export async function verifyRestoreArtifact(
  rootPath: string,
  sourceDatabase: string,
  signal?: AbortSignal,
): Promise<RestoreArtifactVerification> {
  signal?.throwIfAborted()
  if (!/^[A-Za-z0-9_-]+$/u.test(sourceDatabase) || sourceDatabase.startsWith('mydumper_'))
    throw new Error(`Unsupported source database name for a verifiable artifact: ${sourceDatabase}`)
  const root = await realpath(rootPath)
  const entries = await readdir(root, { withFileTypes: true })
  if (entries.some((entry) => !entry.isFile()))
    throw new Error('Artifact top-level entries must all be regular files')
  const files = entries.map((entry) => entry.name)
  const unsafeControlFile = files.find(
    (file) =>
      file === 'metadata.header' ||
      file.startsWith('metadata.partial') ||
      file.startsWith('mydumper_'),
  )
  if (unsafeControlFile)
    throw new Error(`Artifact contains an unsupported loader control file: ${unsafeControlFile}`)
  await validateArtifact(root, () => files.filter((file) => file !== 'metadata'))
  signal?.throwIfAborted()
  const metadata = await readFile(resolve(root, 'metadata'), 'utf8')
  assertArtifactDoesNotControlBinlog(metadata)
  const databaseSchema = `${sourceDatabase}-schema-create.sql`
  if (
    !files.some((file) =>
      [databaseSchema, `${databaseSchema}.gz`, `${databaseSchema}.zst`].includes(file),
    )
  )
    throw new Error(`Artifact is missing database schema for ${sourceDatabase}`)
  const sourceTables = metadata
    .split(/\r?\n/u)
    .map((line) => /^\[`([^`]+)`\.`([^`]+)`\]$/u.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match?.[1] === sourceDatabase)
  if (sourceTables.length === 0)
    throw new Error(`Artifact contains no restorable objects for ${sourceDatabase}`)
  const verifiedHeadings = new Set<string>()
  for (const match of sourceTables) {
    const table = match[2]!
    if (!/^[A-Za-z0-9_-]+$/u.test(table) || table.startsWith('mydumper_'))
      throw new Error(`Unsupported table name for a verifiable artifact: ${table}`)
    const heading = match[0]
    if (verifiedHeadings.has(heading))
      throw new Error(`Artifact metadata contains a duplicate object section: ${heading}`)
    verifiedHeadings.add(heading)
    const body = sectionBody(metadata, heading)
    if (body === undefined) throw new Error(`Artifact metadata is incomplete for ${heading}`)
    const stem = `${sourceDatabase}.${table}`
    const rows = /^rows\s*=\s*(\d+)\s*$/mu.exec(body)?.[1]
    const hasSchema = artifactFilePresent(files, `${stem}-schema.sql`)
    const hasViewSchema = artifactFilePresent(files, `${stem}-schema-view.sql`)
    const hasData = artifactHasData(files, stem)
    if (rows !== undefined && rows !== '0' && !hasData)
      throw new Error(`Artifact is missing data for ${heading}`)
    if (rows === undefined && !hasSchema && !hasViewSchema)
      throw new Error(`Artifact contains no schema or row metadata for ${heading}`)
  }
  return { rootPath: root, files }
}
