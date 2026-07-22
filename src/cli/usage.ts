import packageJson from '../../package.json' with { type: 'json' }
import { COMMANDS, type CommandName } from '../commands/registry.js'
import type { ArgDefinition, CommandModule } from '../commands/types.js'

export const GLOBAL_OPTIONS_FOOTER = `GLOBAL OPTIONS
  --json  JSONL output
  --quiet  Essential output only
  --verbose  Detailed output
  --no-interactive  Never prompt
  --yes  Approve restore mutation`

const noColor =
  process.env.NO_COLOR === '1' ||
  process.env.TERM === 'dumb' ||
  Boolean(process.env.TEST) ||
  Boolean(process.env.CI)

const paint =
  (open: number, close = 39) =>
  (text: string) =>
    noColor ? text : `\u001B[${open}m${text}\u001B[${close}m`

const bold = paint(1, 22)
const cyan = paint(36)
const gray = paint(90)
const underline = paint(4, 24)

function toArray(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value
  return value === undefined ? [] : [value]
}

function snakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/-/gu, '_')
    .toLowerCase()
}

function formatLineColumns(lines: string[][], linePrefix = ''): string {
  const maxLength: number[] = []
  for (const line of lines)
    for (const [index, element] of line.entries())
      maxLength[index] = Math.max(maxLength[index] || 0, element.length)
  return lines
    .map((line) =>
      line
        .map(
          (cell, index) =>
            linePrefix + cell[index === 0 ? 'padStart' : 'padEnd'](maxLength[index]!),
        )
        .join('  '),
    )
    .join('\n')
}

function renderValueHint(name: string, definition: ArgDefinition): string {
  if (definition.type === 'boolean') return ''
  return `=<${snakeCase(name)}>`
}

function renderCommandUsage(command: CommandModule, rootName = 'porteau'): string {
  const commandName = `${rootName} ${command.meta.name}`
  const argLines: string[][] = []
  for (const [name, definition] of Object.entries(command.args)) {
    const aliases = toArray(definition.alias)
    const argStr =
      [...aliases.map((alias) => `-${alias}`), `--${name}`].join(', ') +
      renderValueHint(name, definition)
    argLines.push([cyan(argStr), definition.description ?? ''])
  }
  const usageLines = [
    gray(`${command.meta.description} (${commandName})`),
    '',
    `${underline(bold('USAGE'))} ${cyan(`${commandName}${argLines.length ? ' [OPTIONS]' : ''} `)}`,
    '',
  ]
  if (argLines.length > 0) {
    usageLines.push(underline(bold('OPTIONS')), '')
    usageLines.push(formatLineColumns(argLines, '  '))
    usageLines.push('')
  }
  return usageLines.join('\n')
}

function renderRootUsage(): string {
  const commandName = 'porteau'
  const commandNames: string[] = []
  const commandsLines: string[][] = []
  for (const [name, command] of Object.entries(COMMANDS)) {
    commandsLines.push([cyan(name), command.meta.description])
    commandNames.push(name)
  }
  return [
    gray(`${packageJson.description} (${commandName} v${packageJson.version})`),
    '',
    `${underline(bold('USAGE'))} ${cyan(`${commandName} ${commandNames.join('|')}`)}`,
    '',
    underline(bold('COMMANDS')),
    '',
    formatLineColumns(commandsLines, '  '),
    '',
    `Use ${cyan(`${commandName} <command> --help`)} for more information about a command.`,
  ].join('\n')
}

export function renderUsage(name?: CommandName): string {
  const body = name ? renderCommandUsage(COMMANDS[name]) : renderRootUsage()
  return `${body}\n${GLOBAL_OPTIONS_FOOTER}`
}
