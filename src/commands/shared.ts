import type { PorteauConfig } from '../core/config.js'
import { asDatabaseId, asServerId, type Selection } from '../core/runtime-config.js'
import type { PromptAdapter } from '../presentation/prompts.js'

export class UsageError extends Error {}

export function normalizeRequired(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new UsageError(`${label} must not be blank`)
  return normalized
}

export function normalizeList(value: string | boolean, label: string): string[] {
  if (typeof value !== 'string') throw new UsageError(`${label} requires a value`)
  const values = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  if (!values.length) throw new UsageError(`${label} requires at least one value`)
  return values
}

export function abortError(message?: string): Error {
  return Object.assign(new Error(message ?? ''), { name: 'AbortError' })
}

export async function promptOrAbort(
  ask: (signal: AbortSignal) => Promise<string | undefined>,
  signal: AbortSignal,
  normalize: (value: string) => string = (value) => value,
): Promise<string> {
  const answer = await ask(signal)
  signal.throwIfAborted()
  if (answer === undefined) throw abortError()
  return normalize(answer)
}

export interface CatalogSelectionInput {
  readonly config: PorteauConfig
  readonly serverFlag?: string
  readonly databaseFlag?: string
  readonly interactive: boolean
  readonly prompts: Pick<PromptAdapter, 'text'>
  readonly signal: AbortSignal
  /** Restore accepts one catalog key; backup may accept a comma-separated list. */
  readonly databaseArity: 'one' | 'many'
}

/**
 * Build Selection from flags and optional interactive prompts.
 * serverKey is always set (flag, prompt, or defaults.server) for credential overlay.
 */
export async function resolveCatalogSelection(
  input: CatalogSelectionInput,
): Promise<{ selection: Selection; serverKey: string }> {
  const serverNames = Object.keys(input.config.servers)
  const databaseNames = Object.keys(input.config.databases)

  let selectedServer: string | undefined
  if (input.serverFlag !== undefined) {
    selectedServer = normalizeRequired(input.serverFlag, 'Server catalog key')
  } else if (input.interactive && serverNames.length > 1) {
    const known = [...serverNames].sort().join(', ')
    selectedServer = await promptOrAbort(
      (abortSignal) => input.prompts.text(`Server catalog key (${known})`, abortSignal),
      input.signal,
      (value) => normalizeRequired(value, 'Server catalog key'),
    )
  }

  let databaseTokens: string[] | undefined
  if (input.databaseFlag !== undefined) {
    databaseTokens = normalizeList(input.databaseFlag, '--database')
  } else if (input.interactive && databaseNames.length > 1) {
    const known = [...databaseNames].sort().join(', ')
    const label =
      input.databaseArity === 'one'
        ? `Database catalog key (${known})`
        : `Database catalog key(s), comma-separated (${known})`
    const answer = await promptOrAbort(
      (abortSignal) => input.prompts.text(label, abortSignal),
      input.signal,
      (value) => normalizeRequired(value, 'Database catalog key'),
    )
    databaseTokens = normalizeList(answer, '--database')
  }

  if (
    databaseTokens !== undefined &&
    input.databaseArity === 'one' &&
    databaseTokens.length !== 1
  ) {
    throw new Error('Restore accepts exactly one --database catalog key')
  }

  const serverKey = selectedServer ?? input.config.defaults.server
  const selection: Selection = {
    ...(selectedServer !== undefined ? { server: asServerId(selectedServer) } : {}),
    ...(databaseTokens !== undefined
      ? { databases: databaseTokens.map((token) => asDatabaseId(token)) }
      : {}),
  }
  return { selection, serverKey }
}
