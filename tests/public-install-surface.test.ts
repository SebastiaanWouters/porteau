import { describe, expect, it } from 'vite-plus/test'
import {
  DOCUMENTATION_REPOSITORY,
  NPM_ALPHA_DIST_TAG,
  PUBLIC_INSTALL_CHANNEL,
  assertReadmeDocumentsPublicInstallUrl,
  publicInstallUrl,
  readmePrimaryInstallMarker,
  versionedInstallUrl,
} from '../scripts/public-install-surface.js'

function installationFixture(primaryUrl: string, extra = ''): string {
  return `# Porteau

## Installation

\`\`\`sh
curl --proto '=https' --tlsv1.2 -fsSL \\
  ${primaryUrl} | bash
\`\`\`

${extra}
Pin an older alpha: replace \`alpha\` with a release tag (\`vX.Y.Z-alpha.N\`), or
\`npm install --global --prefix "$HOME/.local" --ignore-scripts porteau@X.Y.Z-alpha.N\`.
On other platforms use \`porteau@next\`.

## Quick start
`
}

describe('public install surface', () => {
  it('builds the floating channel URL', () => {
    expect(publicInstallUrl('sebastiaanwouters/porteau')).toBe(
      'https://github.com/sebastiaanwouters/porteau/releases/download/alpha/install.sh',
    )
  })

  it('builds a versioned pin URL', () => {
    expect(versionedInstallUrl('sebastiaanwouters/porteau', 'v0.1.0-alpha.2')).toBe(
      'https://github.com/sebastiaanwouters/porteau/releases/download/v0.1.0-alpha.2/install.sh',
    )
  })

  it('rejects release tags that do not start with v', () => {
    expect(() => versionedInstallUrl('sebastiaanwouters/porteau', '0.1.0-alpha.2')).toThrow(
      /must start with v/u,
    )
  })

  it('rejects malformed repository paths', () => {
    expect(() => publicInstallUrl('porteau')).toThrow(/Invalid GitHub repository/u)
  })

  it('channel is not a semver tag and npm alpha dist-tag is next', () => {
    expect(PUBLIC_INSTALL_CHANNEL).not.toMatch(/^v\d/u)
    expect(NPM_ALPHA_DIST_TAG).toBe('next')
  })

  it('readme marker is the documentation channel URL', () => {
    expect(readmePrimaryInstallMarker()).toBe(publicInstallUrl(DOCUMENTATION_REPOSITORY))
  })

  it('accepts a channel primary URL with placeholders in Installation', () => {
    expect(() =>
      assertReadmeDocumentsPublicInstallUrl(installationFixture(readmePrimaryInstallMarker())),
    ).not.toThrow()
  })

  it('accepts a case-differing documentation repository in the primary URL', () => {
    const url = publicInstallUrl('SebastiaanWouters/Porteau')
    expect(() => assertReadmeDocumentsPublicInstallUrl(installationFixture(url))).not.toThrow()
  })

  it('fails when the primary URL is versioned', () => {
    const versioned = versionedInstallUrl(DOCUMENTATION_REPOSITORY, 'v0.1.0-alpha.2')
    expect(() => assertReadmeDocumentsPublicInstallUrl(installationFixture(versioned))).toThrow(
      /primary URL must be|versioned release download/u,
    )
  })

  it('fails when Installation embeds a versioned npm pin', () => {
    expect(() =>
      assertReadmeDocumentsPublicInstallUrl(
        installationFixture(readmePrimaryInstallMarker(), 'Also: `porteau@0.1.0-alpha.2`.\n'),
      ),
    ).toThrow(/versioned npm pin/u)
  })
})
