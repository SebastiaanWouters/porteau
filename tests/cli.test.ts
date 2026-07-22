import { describe, expect, it } from 'vite-plus/test'
import { executeCli } from '../src/cli.js'

describe('CLI contract', () => {
  it('advertises the complete command surface', async () => {
    const output: string[] = []
    expect(await executeCli({ args: ['--help'], stdout: (line) => output.push(line) })).toBe(0)
    const usage = output.join('\n')
    for (const command of ['backup', 'restore', 'init', 'doctor', 'config']) {
      expect(usage).toContain(command)
    }
  })

  it('renders help for the requested subcommand', async () => {
    const output: string[] = []
    expect(
      await executeCli({ args: ['backup', '--help'], stdout: (line) => output.push(line) }),
    ).toBe(0)
    expect(output.join('\n')).toContain('porteau backup')
    expect(output.join('\n')).toContain('--output')
  })

  it('advertises the read-only doctor check', async () => {
    const doctorOutput: string[] = []
    expect(
      await executeCli({
        args: ['doctor', '--help'],
        stdout: (line) => doctorOutput.push(line),
      }),
    ).toBe(0)
    expect(doctorOutput.join('\n')).toContain('--config')
  })

  it('documents guarded restore inputs and approval', async () => {
    const output: string[] = []
    expect(
      await executeCli({ args: ['restore', '--help'], stdout: (line) => output.push(line) }),
    ).toBe(0)
    const help = output.join('\n')
    for (const option of [
      '--artifact',
      '--source-database',
      '--destination-database',
      '--destination-policy',
      '--overwrite-policy',
      '--binlog-policy',
      '--yes',
    ])
      expect(help).toContain(option)
  })

  it('returns 130 when SIGINT interrupts help rendering', async () => {
    expect(
      await executeCli({
        args: ['--help'],
        stdout: () => process.emit('SIGINT'),
      }),
    ).toBe(130)
  })

  it('renders invalid configuration without exposing environment secrets', async () => {
    const secret = 'distinctive-porteau-password-7f8a'
    const previousPassword = process.env.PORTEAU_PASSWORD
    const previousPort = process.env.PORTEAU_PORT
    process.env.PORTEAU_PASSWORD = secret
    process.env.PORTEAU_PORT = 'invalid'
    const output: string[] = []
    try {
      expect(
        await executeCli({
          args: ['backup'],
          stdout: (line) => output.push(line),
          stderr: (line) => output.push(line),
        }),
      ).toBe(1)
    } finally {
      if (previousPassword === undefined) delete process.env.PORTEAU_PASSWORD
      else process.env.PORTEAU_PASSWORD = previousPassword
      if (previousPort === undefined) delete process.env.PORTEAU_PORT
      else process.env.PORTEAU_PORT = previousPort
    }
    expect(output.join('\n')).toMatch(/^error: /u)
    expect(output.join('\n')).not.toContain(secret)
  })
})
