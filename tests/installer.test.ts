import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vite-plus/test'
import packageJson from '../package.json' with { type: 'json' }
import { renderInstallScript } from '../scripts/generate-install-script.js'

const releasedVersion = packageJson.version

type ReleasedInstallerFault =
  | 'doctor'
  | 'launcher'
  | 'package-bin'
  | 'package-name'
  | 'package-symlink'
  | 'package-version'
  | 'version'

async function runReleasedInstaller(
  options: {
    fault?: ReleasedInstallerFault
    publishedVersion?: string
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'porteau-release-installer-test-'))
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  const npmLog = join(root, 'npm-args')
  const sudoLog = join(root, 'sudo-called')
  const osRelease = join(root, 'os-release')
  await mkdir(home)
  await mkdir(bin)
  await writeFile(osRelease, 'ID=ubuntu\nVERSION_ID=24.04\nVERSION_CODENAME=noble\n')
  await symlink(process.execPath, join(bin, 'node'))

  const executable = async (name: string, body: string) => {
    const path = join(bin, name)
    await writeFile(path, `#!/usr/bin/env bash\n${body}`)
    await chmod(path, 0o755)
  }
  await executable(
    'dpkg',
    '[[ "$1" == --print-architecture ]] && { echo amd64; exit; }; [[ "$1" == --compare-versions ]]',
  )
  for (const tool of ['mydumper', 'myloader'])
    await executable(
      tool,
      `[[ "$1" == --help ]] && echo --machine-log-json || echo "${tool} v1.0.3-1, built against MySQL 8.0.0 with SSL support"`,
    )
  await executable('sudo', `printf called >${JSON.stringify(sudoLog)}; exit 99`)
  await executable(
    'npm',
    `if [[ "$1" == --version ]]; then echo 11.0.0; exit; fi
if [[ "$1" == view ]]; then printf '%s\\n' "\${PUBLISHED_VERSION-"${releasedVersion}"}"; exit; fi
printf '%s\\n' "$@" >"$NPM_LOG"
package="$HOME/.local/lib/node_modules/porteau"
mkdir -p "$package/dist" "$HOME/.local/bin"
name=porteau version=${releasedVersion} binpath=dist/cli.mjs
[[ "\${FAULT-}" == package-name ]] && name=other
[[ "\${FAULT-}" == package-version ]] && version=9.9.9
[[ "\${FAULT-}" == package-bin ]] && binpath=dist/other.mjs
printf '{"name":"%s","version":"%s","bin":{"porteau":"%s"}}\\n' "$name" "$version" "$binpath" >"$package/package.json"
if [[ "\${FAULT-}" == package-symlink ]]; then mv "$package/package.json" "$package/real.json"; ln -s real.json "$package/package.json"; fi
cat >"$package/dist/cli.mjs" <<'EOF'
#!/usr/bin/env bash
[[ "$1" == --version ]] && { [[ "\${FAULT-}" == version ]] && echo 9.9.9 || echo ${releasedVersion}; exit; }
[[ "$1" == doctor ]] && [[ "\${FAULT-}" != doctor ]]
EOF
chmod +x "$package/dist/cli.mjs"
if [[ "\${FAULT-}" == launcher ]]; then printf '#!/bin/sh\\nexit 0\\n' >"$package/outside"; chmod +x "$package/outside"; ln -s "$package/outside" "$HOME/.local/bin/porteau"; else ln -s "$package/dist/cli.mjs" "$HOME/.local/bin/porteau"; fi`,
  )

  const script = renderInstallScript(releasedVersion).replace(
    '. /etc/os-release',
    `. ${JSON.stringify(osRelease)}`,
  )
  const result = spawnSync('bash', ['-s', '--', '--yes'], {
    input: script,
    encoding: 'utf8',
    env: {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      FAULT: options.fault ?? '',
      PUBLISHED_VERSION: options.publishedVersion ?? `"${releasedVersion}"`,
      NPM_LOG: npmLog,
    },
  })
  return {
    result,
    npmArguments: await readFile(npmLog, 'utf8').catch(() => ''),
    sudoCalled: await readFile(sudoLog, 'utf8').catch(() => ''),
    remove: () => rm(root, { recursive: true, force: true }),
  }
}

describe('standalone generated installer', () => {
  it('matches the committed artifact byte-for-byte', async () => {
    expect(await readFile('install.sh', 'utf8')).toBe(renderInstallScript())
  })

  it('is standalone and contains fail-closed bootstrap controls', () => {
    const script = renderInstallScript()
    expect(script).toContain('set -Eeuo pipefail')
    expect(script).toContain('nodistro main')
    expect(script).toContain('6F71F525282841EEDAF851B42F59B5F99B1BE0B4')
    expect(script).toContain('sudo env DEBIAN_FRONTEND=noninteractive apt-get install --yes')
    expect(script).not.toContain('setup_24.x')
    expect(script).not.toMatch(/\beval\b/u)
  })

  it('installs an exact release into a user-owned prefix without lifecycle scripts or sudo', () => {
    const script = renderInstallScript('1.2.3')
    expect(script).toContain("PORTEAU_VERSION='1.2.3'")
    expect(script).toContain("PORTEAU_REGISTRY='https://registry.npmjs.org'")
    expect(script).toContain('npm install --global --prefix "$PORTEAU_PREFIX" --ignore-scripts')
    expect(script).toContain('--userconfig "$TMP/npmrc" --cache "$TMP/npm-cache"')
    expect(script).toContain('"porteau@$PORTEAU_VERSION"')
    expect(script).toContain('"$PORTEAU_BIN" doctor --no-interactive')
    expect(script).not.toContain('porteau@latest')
    expect(script).not.toMatch(/sudo\s+npm/u)
  })

  it('keeps the 0.0.0 installer explicitly source-only and rejects unsafe versions', () => {
    expect(renderInstallScript('0.0.0')).toContain('Porteau remains source-only at version 0.0.0.')
    expect(() => renderInstallScript('1.0.0; touch /tmp/unsafe')).toThrow(
      'Package version is unsafe',
    )
  })

  it('does not execute a truncated curl-pipe payload and forwards complete pipe arguments', () => {
    const script = renderInstallScript('1.2.3')
    expect(script.trimEnd().endsWith('{ main "$@"; }')).toBe(true)

    const footer = '{ main "$@"; }'
    const footerStart = script.lastIndexOf(footer)
    for (let length = 0; length < footer.length; length++) {
      const truncated = spawnSync('bash', ['-s', '--', '--yes'], {
        input: script.slice(0, footerStart) + footer.slice(0, length),
        encoding: 'utf8',
      })
      expect(truncated.stdout, `footer prefix ${length}`).toBe('')
      expect(truncated.stderr, `footer prefix ${length}`).not.toContain('Porteau installation plan')
    }

    const complete = spawnSync('bash', ['-s', '--', '--help'], {
      input: script,
      encoding: 'utf8',
    })
    expect(complete.status).toBe(0)
    expect(complete.stdout).toContain('Usage: ./install.sh [--check] [--yes]')
  })

  it.each([
    ['wrong package name', 'package-name'],
    ['wrong package version', 'package-version'],
    ['wrong package bin mapping', 'package-bin'],
    ['symlinked package.json', 'package-symlink'],
    ['launcher outside dist/cli.mjs', 'launcher'],
    ['CLI version mismatch', 'version'],
    ['doctor failure', 'doctor'],
  ] as const)('fails closed for %s', async (_description, fault) => {
    const run = await runReleasedInstaller({ fault })
    try {
      expect(run.result.status).not.toBe(0)
    } finally {
      await run.remove()
    }
  })

  it.each([
    ['malformed npm view output', '{not-json'],
    ['wrong npm view version', '"0.0.0-wrong"'],
  ])('fails closed for %s', async (_description, publishedVersion) => {
    const run = await runReleasedInstaller({ publishedVersion })
    try {
      expect(run.result.status).not.toBe(0)
      expect(run.npmArguments).toBe('')
    } finally {
      await run.remove()
    }
  })

  it('executes npm install with the exact released-mode safety arguments', async () => {
    const run = await runReleasedInstaller()
    try {
      expect(run.result.status, run.result.stderr).toBe(0)
      const args = run.npmArguments.trimEnd().split('\n')
      expect(args).toEqual([
        'install',
        '--global',
        '--prefix',
        expect.stringMatching(/\/home\/\.local$/u),
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--registry',
        'https://registry.npmjs.org',
        '--userconfig',
        expect.stringMatching(/\/npmrc$/u),
        '--cache',
        expect.stringMatching(/\/npm-cache$/u),
        `porteau@${releasedVersion}`,
      ])
      expect(run.sudoCalled).toBe('')
    } finally {
      await run.remove()
    }
  })
})
