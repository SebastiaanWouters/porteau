import { stripVTControlCharacters } from 'node:util'

export class Redactor {
  readonly #secrets = new Set<string>()

  constructor(secret?: string) {
    this.register(secret)
  }

  register(secret?: string): void {
    if (secret) this.#secrets.add(secret)
  }

  clean(value: unknown): string {
    let text = stripVTControlCharacters(value instanceof Error ? value.message : String(value))
    for (const secret of [...this.#secrets].sort((left, right) => right.length - left.length))
      text = text.replaceAll(secret, '[redacted]')
    return text
      .replace(/((?:password|passwd|pwd)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, '$1[redacted]')
      .replace(/[\r\n]+/gu, ' ')
  }

  cleanLines(value: unknown): string[] {
    return stripVTControlCharacters(String(value))
      .split(/\r?\n/u)
      .map((line) => this.clean(line))
  }

  cleanValue(value: unknown, seen = new WeakSet<object>(), key?: string): unknown {
    if (
      key &&
      /(?:password|passwd|pwd|secret|token|authorization|credential|api[-_]?key)/iu.test(key)
    )
      return '[redacted]'
    if (typeof value === 'string') return this.clean(value)
    if (typeof value === 'bigint') return value.toString()
    if (value instanceof Error) return this.clean(value)
    if (value instanceof Date) {
      try {
        return value.toISOString()
      } catch {
        return '[unavailable]'
      }
    }
    if (value && typeof value === 'object') {
      if (seen.has(value)) return '[circular]'
      seen.add(value)
      if (Array.isArray(value)) {
        const cleaned: unknown[] = []
        for (let index = 0; index < value.length; index += 1) {
          try {
            cleaned.push(this.cleanValue(value[index], seen))
          } catch {
            cleaned.push('[unavailable]')
          }
        }
        seen.delete(value)
        return cleaned
      }
      const cleaned: Record<string, unknown> = {}
      let properties: string[]
      try {
        properties = Object.keys(value)
      } catch {
        seen.delete(value)
        return '[unavailable]'
      }
      for (const property of properties) {
        try {
          cleaned[property] = this.cleanValue(
            (value as Record<string, unknown>)[property],
            seen,
            property,
          )
        } catch {
          cleaned[property] = '[unavailable]'
        }
      }
      seen.delete(value)
      return cleaned
    }
    if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol')
      return null
    return value
  }
}
