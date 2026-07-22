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
