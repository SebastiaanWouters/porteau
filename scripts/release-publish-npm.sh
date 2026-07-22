#!/usr/bin/env bash
set -Eeuo pipefail

tarball="$(realpath "${1:?Usage: release-publish-npm.sh <porteau.tgz>}")"
version="${GITHUB_REF_NAME#v}"
[[ -n "$version" ]] || {
  echo 'GITHUB_REF_NAME is required' >&2
  exit 2
}
[[ "$GITHUB_REF_TYPE" == tag ]] || {
  echo 'npm publish is only allowed from a tag ref' >&2
  exit 2
}
[[ -f "$tarball" ]] || {
  echo "Missing package tarball: $tarball" >&2
  exit 2
}

npm_version="$(npm --version)"
node -e 'const [v,min]=process.argv.slice(1).map(x=>x.split(".").map(Number)); process.exit(v[0]>min[0] || (v[0]===min[0] && (v[1]>min[1] || (v[1]===min[1] && v[2]>=min[2]))) ? 0 : 1)' \
  "$npm_version" 11.5.1

integrity="$(
  node --input-type=module -e '
    import { createHash } from "node:crypto"
    import { readFileSync } from "node:fs"
    console.log("sha512-" + createHash("sha512").update(readFileSync(process.argv[1])).digest("base64"))
  ' "$tarball"
)"

# Use the full registry document — the abbreviated install-v1 view omits license/repository.
registry_state() {
  VERSION="$version" INTEGRITY="$integrity" REQUIRE_INTEGRITY="${1:-1}" node --input-type=module <<'NODE'
const response = await fetch('https://registry.npmjs.org/porteau')
if (response.status === 404) process.exit(10)
if (!response.ok) throw new Error(`Registry returned HTTP ${response.status}`)
const metadata = await response.json()
const release = metadata.versions?.[process.env.VERSION]
if (!release) process.exit(10)
const metadataOk =
  release.name === 'porteau' &&
  release.version === process.env.VERSION &&
  release.bin?.porteau === 'dist/cli.mjs' &&
  release.license === 'Apache-2.0' &&
  release.repository?.url === 'git+https://github.com/SebastiaanWouters/porteau.git'
if (!metadataOk) process.exit(20)
if (process.env.REQUIRE_INTEGRITY === '1' && release.dist?.integrity !== process.env.INTEGRITY)
  process.exit(20)
NODE
}

set +e
registry_state 1
state=$?
set -e
case "$state" in
  0) echo "porteau@$version is already published as the validated artifact." ;;
  10)
    npm publish "$tarball" --ignore-scripts --access public --tag next --provenance
    ;;
  20)
    # Version exists (possibly from a prior attempt). Accept matching package metadata even
    # when this run's freshly packed tarball differs by gzip timestamps.
    set +e
    registry_state 0
    existing=$?
    set -e
    if [[ "$existing" == 0 ]]; then
      echo "porteau@$version is already on the registry with valid metadata; continuing."
    else
      echo "porteau@$version exists with unexpected metadata or is not readable yet." >&2
      exit 1
    fi
    ;;
  *)
    echo 'Unable to establish package state from the npm registry.' >&2
    exit 1
    ;;
esac

for attempt in {1..12}; do
  set +e
  registry_state 0
  state=$?
  set -e
  [[ "$state" == 0 ]] && break
  ((attempt == 12)) && {
    echo 'Published package did not become available with valid metadata.' >&2
    exit 1
  }
  sleep 5
done

VERSION="$version" node --input-type=module <<'NODE'
const response = await fetch('https://registry.npmjs.org/porteau')
if (!response.ok) throw new Error(`Registry returned HTTP ${response.status}`)
const metadata = await response.json()
if (metadata['dist-tags']?.next !== process.env.VERSION)
  throw new Error('The next dist-tag does not reference this release')
if (metadata['dist-tags']?.latest === process.env.VERSION)
  throw new Error('The alpha release unexpectedly changed latest')
NODE

echo "Validated porteau@$version on npm (next=$(npm view porteau dist-tags.next))"
