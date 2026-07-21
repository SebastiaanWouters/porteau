import * as v from 'valibot'
import { compareToolVersions } from '../core/tool-version.js'
import manifestData from './manifest.json' with { type: 'json' }

const versionSchema = v.pipe(v.string(), v.regex(/^\d+\.\d+\.\d+-\d+$/))
const digestSchema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/))
const machineVersionSchema = v.pipe(v.string(), v.regex(/^\d+$/))

const manifestStructureSchema = v.strictObject({
  engine: v.strictObject({
    tag: v.pipe(v.string(), v.regex(/^v\d+\.\d+\.\d+-\d+$/)),
    version: versionSchema,
    downloadBaseUrl: v.pipe(v.string(), v.url()),
    tools: v.strictObject({
      mydumper: v.strictObject({ version: versionSchema, minimumVersion: versionSchema }),
      myloader: v.strictObject({ version: versionSchema, minimumVersion: versionSchema }),
    }),
    machineLog: v.strictObject({
      schemaVersions: v.pipe(v.array(machineVersionSchema), v.minLength(1)),
      eventVersions: v.pipe(v.array(machineVersionSchema), v.minLength(1)),
    }),
  }),
  assets: v.pipe(
    v.array(
      v.strictObject({
        ubuntu: v.picklist(['22.04', '24.04']),
        codename: v.picklist(['jammy', 'noble']),
        architecture: v.picklist(['amd64', 'arm64']),
        filename: v.string(),
        url: v.pipe(v.string(), v.url()),
        size: v.pipe(v.number(), v.integer(), v.minValue(1)),
        sha256: digestSchema,
      }),
    ),
    v.minLength(1),
  ),
})

const supportedUbuntuTargets = new Set([
  '22.04/jammy/amd64',
  '24.04/noble/amd64',
  '24.04/noble/arm64',
])

function hasUniqueValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

export const compatibilityManifestSchema = v.pipe(
  manifestStructureSchema,
  v.check((manifest) => {
    const { engine, assets } = manifest
    const tools = Object.values(engine.tools)
    const assetTargets = assets.map(
      ({ ubuntu, codename, architecture }) => `${ubuntu}/${codename}/${architecture}`,
    )

    return (
      engine.tag === `v${engine.version}` &&
      engine.downloadBaseUrl ===
        `https://github.com/mydumper/mydumper/releases/download/${engine.tag}/` &&
      tools.every(
        ({ version, minimumVersion }) =>
          version === engine.version && (compareToolVersions(version, minimumVersion) ?? -1) >= 0,
      ) &&
      tools[0]!.minimumVersion === tools[1]!.minimumVersion &&
      hasUniqueValues(engine.machineLog.schemaVersions) &&
      hasUniqueValues(engine.machineLog.eventVersions) &&
      hasUniqueValues(assetTargets) &&
      hasUniqueValues(assets.map(({ filename }) => filename)) &&
      hasUniqueValues(assets.map(({ url }) => url)) &&
      assets.every(
        ({ ubuntu, codename, architecture, filename, url }) =>
          supportedUbuntuTargets.has(`${ubuntu}/${codename}/${architecture}`) &&
          filename === `mydumper_${engine.version}.${codename}_${architecture}.deb` &&
          url === `${engine.downloadBaseUrl}${filename}`,
      )
    )
  }, 'Compatibility manifest fields are inconsistent'),
)

export type CompatibilityManifest = v.InferOutput<typeof compatibilityManifestSchema>

export const compatibilityManifest: CompatibilityManifest = v.parse(
  compatibilityManifestSchema,
  manifestData,
)
