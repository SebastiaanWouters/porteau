import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vite-plus/test'

const readmePath = fileURLToPath(new URL('../README.md', import.meta.url))
const channelUrl = 'https://github.com/sebastiaanwouters/porteau/releases/download/alpha/install.sh'

describe('install docs', () => {
  it('documents the floating alpha channel and no versioned primary pins', async () => {
    const readme = await readFile(readmePath, 'utf8')
    const start = readme.search(/^## Installation\s*$/mu)
    expect(start).toBeGreaterThanOrEqual(0)
    const after = readme.slice(start).split('\n').slice(1).join('\n')
    const next = after.search(/^## /mu)
    const section = next === -1 ? after : after.slice(0, next)

    expect(section).toContain(channelUrl)
    expect(section).not.toMatch(/\/releases\/download\/v\d/u)
    expect(section).not.toMatch(/porteau@\d/u)
  })
})
