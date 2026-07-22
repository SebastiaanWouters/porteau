/** Floating GitHub release tag hosting the current alpha install.sh. */
export const PUBLIC_INSTALL_CHANNEL = 'alpha'

if (/^v\d/u.test(PUBLIC_INSTALL_CHANNEL))
  throw new Error(
    `PUBLIC_INSTALL_CHANNEL must not look like a semver tag (got ${PUBLIC_INSTALL_CHANNEL})`,
  )

export const NPM_ALPHA_DIST_TAG = 'next'

/** Lowercase owner/repo for documented install URLs. */
export const DOCUMENTATION_REPOSITORY = 'sebastiaanwouters/porteau'

export type GithubRepository = `${string}/${string}`

function isGithubRepository(value: string): value is GithubRepository {
  return /^[^/\s]+\/[^/\s]+$/u.test(value)
}

function requireGithubRepository(repository: string): GithubRepository {
  if (!isGithubRepository(repository))
    throw new Error(`Invalid GitHub repository (expected owner/repo): ${repository}`)
  return repository
}

function requireVersionedReleaseTag(releaseTag: string): string {
  if (!releaseTag.startsWith('v'))
    throw new Error(`Release tag must start with v (got ${releaseTag})`)
  return releaseTag
}

export function publicInstallUrl(repository: string): string {
  const repo = requireGithubRepository(repository)
  return `https://github.com/${repo}/releases/download/${PUBLIC_INSTALL_CHANNEL}/install.sh`
}

export function versionedInstallUrl(repository: string, releaseTag: string): string {
  const repo = requireGithubRepository(repository)
  const tag = requireVersionedReleaseTag(releaseTag)
  return `https://github.com/${repo}/releases/download/${tag}/install.sh`
}

export function readmePrimaryInstallMarker(): string {
  return publicInstallUrl(DOCUMENTATION_REPOSITORY)
}

function normalizeGithubInstallUrl(url: string): string {
  const parsed = URL.parse(url)
  if (parsed === null) return url.toLowerCase()
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.toLowerCase()
}

function installationSection(readme: string): string {
  const start = readme.search(/^## Installation\s*$/mu)
  if (start === -1) throw new Error('README missing ## Installation section')
  const afterHeading = readme.slice(start).split('\n').slice(1).join('\n')
  const nextHeading = afterHeading.search(/^## /mu)
  return nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading)
}

function firstFencedShInstallUrl(section: string): string {
  const fencePattern = /```sh\r?\n([\s\S]*?)```/gu
  for (const fence of section.matchAll(fencePattern)) {
    const body = fence[1]
    if (body === undefined) continue
    const urlMatch = /https:\/\/github\.com\/[^\s]+\/install\.sh/u.exec(body)
    if (urlMatch?.[0] !== undefined) return urlMatch[0]
  }
  throw new Error(
    'README Installation has no https://github.com/.../install.sh URL in a ```sh fence',
  )
}

export function assertReadmeDocumentsPublicInstallUrl(readme: string): void {
  const section = installationSection(readme)
  const primary = firstFencedShInstallUrl(section)
  const expected = readmePrimaryInstallMarker()
  if (normalizeGithubInstallUrl(primary) !== normalizeGithubInstallUrl(expected))
    throw new Error(`README Installation primary URL must be ${expected} (found ${primary})`)

  if (/\/releases\/download\/v\d/u.test(section))
    throw new Error('README Installation must not embed a versioned release download URL')

  if (/porteau@\d/u.test(section))
    throw new Error('README Installation must not embed a versioned npm pin (porteau@N…)')
}
