import { describe, expect, it, vi } from 'vite-plus/test'
import { executeCli } from '../src/cli.js'
import { config } from './cli-fixtures.js'

describe('global CLI contract', () => {
  it('accepts global options before and after commands and renders JSON conflicts as JSON', async () => {
    for (const args of [
      ['--json', 'config'],
      ['config', '--json'],
    ]) {
      const stdout: string[] = []
      expect(
        await executeCli({
          args,
          stdout: (line) => stdout.push(line),
          stderr: vi.fn(),
          services: { loadConfig: async () => config() },
        }),
      ).toBe(0)
      expect(JSON.parse(stdout.at(-1)!).type).toBe('result')
    }

    const stdout: string[] = []
    const stderr: string[] = []
    expect(
      await executeCli({
        args: ['--json', '--quiet', 'config'],
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      }),
    ).toBe(2)
    expect(JSON.parse(stdout[0]!).error.code).toBe('INVALID_USAGE')
    expect(stderr).toEqual([])
  })

  it('supports advertised aliases and rejects unknown options before loading config', async () => {
    let loadOptions: unknown
    const load = vi.fn(async (options: unknown) => {
      loadOptions = options
      return config()
    })
    expect(
      await executeCli({
        args: ['config', '-c', 'custom.yaml'],
        stdout: vi.fn(),
        services: { loadConfig: load },
      }),
    ).toBe(0)
    expect(loadOptions).toMatchObject({
      configFile: expect.stringContaining('custom.yaml'),
    })

    load.mockClear()
    expect(
      await executeCli({
        args: ['config', '--unknown'],
        stdout: vi.fn(),
        stderr: vi.fn(),
        services: { loadConfig: load },
      }),
    ).toBe(2)
    expect(load).not.toHaveBeenCalled()
  })

  it('parses attached values, option-looking values, and the option terminator consistently', async () => {
    const load = vi.fn(async (_options: unknown) => config())
    for (const args of [
      ['config', '--config=custom.yaml'],
      ['config', '--config', '--json'],
      ['--json', 'config', '--config=custom.yaml'],
    ]) {
      expect(
        await executeCli({
          args,
          stdout: vi.fn(),
          stderr: vi.fn(),
          services: { loadConfig: load },
        }),
      ).toBe(0)
    }
    expect(load.mock.calls[0]?.[0]).toMatchObject({
      configFile: expect.stringContaining('custom.yaml'),
    })
    expect(load.mock.calls[1]?.[0]).toMatchObject({ configFile: expect.stringContaining('--json') })

    load.mockClear()
    for (const args of [
      ['--help', 'backup', 'unexpected'],
      ['--version', 'backup'],
    ]) {
      expect(await executeCli({ args, stdout: vi.fn(), stderr: vi.fn() })).toBe(2)
    }
    for (const args of [
      ['config', '--config', '--json', '--unknown'],
      ['config', '--', '--json'],
    ]) {
      const stdout: string[] = []
      const stderr: string[] = []
      expect(
        await executeCli({
          args,
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
        }),
      ).toBe(2)
      expect(stdout).toEqual([])
      expect(stderr[0]).toMatch(/^error:/u)
    }
    expect(load).not.toHaveBeenCalled()
  })

  it('documents global options in root and subcommand help', async () => {
    for (const args of [['--help'], ['backup', '--help']]) {
      const output: string[] = []
      expect(await executeCli({ args, stdout: (line) => output.push(line) })).toBe(0)
      expect(output.join('\n')).toContain('--no-interactive')
      expect(output.join('\n')).toContain('--json')
    }
  })
})
