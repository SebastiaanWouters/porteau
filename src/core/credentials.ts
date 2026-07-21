import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serializeDefaultsSection, type ResolvedTable } from './filters.js'

export interface MySqlCredentials {
  readonly host: string
  readonly port: number
  readonly user: string
  readonly password: string
  readonly tls?: 'disabled' | 'preferred' | 'required' | 'verify-ca' | 'verify-identity'
}

export interface TemporaryDefaultsFile {
  readonly path: string
  cleanup(): Promise<void>
}

export function escapeDefaultsValue(value: string): string {
  if (value.includes('\0')) throw new Error('Defaults values cannot contain NUL bytes')
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t').replaceAll('\b', '\\b')}"`
}

export async function createCredentialsDefaultsFile(
  credentials: MySqlCredentials,
  tables: readonly ResolvedTable[] = [],
): Promise<TemporaryDefaultsFile> {
  const directory = await mkdtemp(join(tmpdir(), 'porteau-credentials-'))
  const path = join(directory, 'defaults.cnf')
  const sections = tables.flatMap((table) =>
    table.scope === 'ALL'
      ? []
      : ['', serializeDefaultsSection(table), `object_to_export=${table.scope}`],
  )
  const contents = [
    '[client]',
    `host=${escapeDefaultsValue(credentials.host)}`,
    `port=${credentials.port}`,
    `user=${escapeDefaultsValue(credentials.user)}`,
    `password=${escapeDefaultsValue(credentials.password)}`,
    ...(credentials.tls ? [`ssl-mode=${credentials.tls.replace('-', '_').toUpperCase()}`] : []),
    ...sections,
    '',
  ].join('\n')
  try {
    await writeFile(path, contents, { mode: 0o600, flag: 'wx' })
    await chmod(path, 0o600)
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  return { path, cleanup: async () => rm(directory, { recursive: true, force: true }) }
}
