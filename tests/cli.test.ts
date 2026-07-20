import { renderUsage } from 'citty'
import { describe, expect, it } from 'vite-plus/test'
import { mainCommand } from '../src/cli.js'

describe('CLI contract', () => {
  it('advertises the phase-one command surface', async () => {
    const usage = await renderUsage(mainCommand)

    for (const command of ['backup', 'restore', 'init', 'setup', 'doctor', 'config']) {
      expect(usage).toContain(command)
    }
  })
})
