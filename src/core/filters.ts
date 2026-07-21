export interface TableIdentifier {
  readonly database: string
  readonly table: string
}

export type ObjectScope = 'ALL' | 'SCHEMA'
export interface ResolvedTable extends TableIdentifier {
  readonly scope: ObjectScope
  readonly serialized: string
  readonly kind?: 'base-table' | 'view'
  readonly hasTriggers?: boolean
}

function compileGlob(pattern: string): RegExp {
  let source = '^'
  for (const character of pattern) {
    if (character === '*') source += '.*'
    else if (character === '?') source += '.'
    else source += character.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
  }
  return new RegExp(`${source}$`, 'u')
}

function matches(pattern: string, table: TableIdentifier): boolean {
  const separator = pattern.indexOf('.')
  if (separator <= 0 || separator === pattern.length - 1) {
    throw new Error(`Table pattern must be qualified as database.table: ${pattern}`)
  }
  return (
    compileGlob(pattern.slice(0, separator)).test(table.database) &&
    compileGlob(pattern.slice(separator + 1)).test(table.table)
  )
}

export function quoteMysqlIdentifier(identifier: string): string {
  if (identifier.includes('\0')) throw new Error('MySQL identifiers cannot contain NUL bytes')
  return `\`${identifier.replaceAll('`', '``')}\``
}

export function serializeTable(table: TableIdentifier): string {
  return `${quoteMysqlIdentifier(table.database)}.${quoteMysqlIdentifier(table.table)}`
}

export function serializeDefaultsSection(table: TableIdentifier): string {
  if (table.database.includes('`') || table.table.includes('`')) {
    throw new Error('Mydumper table filters do not support identifiers containing backticks')
  }
  return `[\`${table.database}\`.\`${table.table}\`]`
}

export function exactTableRegex(tables: readonly TableIdentifier[]): string {
  if (tables.length === 0) throw new Error('At least one table must be selected')
  const escape = (value: string) => value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
  return `^(?:${tables.map(({ database, table }) => `${escape(database)}\\.${escape(table)}`).join('|')})$`
}

export function assertArtifactSafeIdentifiers(tables: readonly TableIdentifier[]): void {
  for (const { database, table } of tables) {
    for (const [kind, value] of [
      ['database', database],
      ['table', table],
    ] as const) {
      if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.startsWith('mydumper_'))
        throw new Error(`Unsupported ${kind} name for verifiable mydumper artifacts: ${value}`)
    }
  }
}

export function expandTablePatterns(
  patterns: readonly string[],
  catalog: readonly TableIdentifier[],
  options: { readonly allowUnmatched?: boolean } = {},
): TableIdentifier[] {
  const selected = new Map<string, TableIdentifier>()
  for (const pattern of patterns) {
    const found = catalog.filter((table) => matches(pattern, table))
    if (found.length === 0 && !options.allowUnmatched)
      throw new Error(`Table pattern matched nothing: ${pattern}`)
    for (const table of found) selected.set(`${table.database}\0${table.table}`, table)
  }
  return [...selected.values()]
}

export function resolveObjectScopes(
  catalog: readonly TableIdentifier[],
  exclude: { readonly tables: readonly string[]; readonly data: readonly string[] },
): ResolvedTable[] {
  const omitted = new Set(expandTablePatterns(exclude.tables, catalog).map(serializeTable))
  const noData = new Set(expandTablePatterns(exclude.data, catalog).map(serializeTable))
  return catalog.flatMap((table) => {
    const serialized = serializeTable(table)
    if (omitted.has(serialized)) return []
    return [{ ...table, serialized, scope: noData.has(serialized) ? 'SCHEMA' : 'ALL' }]
  })
}
