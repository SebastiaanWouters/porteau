import * as v from 'valibot'
import { describe, expect, it } from 'vite-plus/test'
import { compatibilityManifest, compatibilityManifestSchema } from '../src/setup/manifest.js'

describe('compatibility manifest', () => {
  it('pins matching tools and machine-log versions', () => {
    expect(compatibilityManifest.engine.tools.mydumper.version).toBe(
      compatibilityManifest.engine.tools.myloader.version,
    )
    expect(compatibilityManifest.engine.machineLog).toEqual({
      schemaVersions: ['1'],
      eventVersions: ['1'],
    })
  })

  it('contains one unique asset for each supported target', () => {
    const targets = compatibilityManifest.assets.map(
      ({ codename, architecture }) => `${codename}/${architecture}`,
    )

    expect(new Set(targets).size).toBe(targets.length)
    expect(targets).toEqual(['jammy/amd64', 'noble/amd64', 'noble/arm64'])
    for (const asset of compatibilityManifest.assets) {
      expect(asset.url).toBe(`${compatibilityManifest.engine.downloadBaseUrl}${asset.filename}`)
    }
  })

  it.each([
    ['mismatched tag', { engine: { ...compatibilityManifest.engine, tag: 'v9.9.9-1' } }],
    [
      'invalid Ubuntu tuple',
      {
        assets: compatibilityManifest.assets.map((asset, index) =>
          index === 0 ? { ...asset, ubuntu: '24.04' } : asset,
        ),
      },
    ],
    [
      'duplicate schema versions',
      {
        engine: {
          ...compatibilityManifest.engine,
          machineLog: { ...compatibilityManifest.engine.machineLog, schemaVersions: ['1', '1'] },
        },
      },
    ],
  ])('rejects %s', (_name, override) => {
    const candidate = { ...compatibilityManifest, ...override }
    expect(v.safeParse(compatibilityManifestSchema, candidate).success).toBe(false)
  })
})
