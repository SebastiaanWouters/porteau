import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vite-plus/test'

const fixturePath = fileURLToPath(new URL('./fixtures/subprocess.mjs', import.meta.url))

function runFixture(exitCode: number) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [fixturePath, String(exitCode)])
    let stdout = ''
    let stderr = ''

    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}

describe('subprocess fixture convention', () => {
  it('keeps stdout, stderr, and exit status independently observable', async () => {
    await expect(runFixture(23)).resolves.toEqual({
      code: 23,
      stdout: 'fixture stdout\n',
      stderr: 'fixture stderr\n',
    })
  })
})
