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

# Trusted publishing (OIDC) only — clear any token setup-node / secrets may inject.
unset NPM_TOKEN NODE_AUTH_TOKEN
export NPM_TOKEN='' NODE_AUTH_TOKEN=''

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

registry_state() {
  VERSION="$version" INTEGRITY="$integrity" node --input-type=module <<'NODE'
const response = await fetch('https://registry.npmjs.org/porteau', {
  headers: { accept: 'application/vnd.npm.install-v1+json' },
})
if (response.status === 404) process.exit(10)
if (!response.ok) throw new Error(`Registry returned HTTP ${response.status}`)
const metadata = await response.json()
const release = metadata.versions?.[process.env.VERSION]
if (!release) process.exit(10)
if (
  release.name !== 'porteau' ||
  release.version !== process.env.VERSION ||
  release.bin?.porteau !== 'dist/cli.mjs' ||
  release.license !== 'Apache-2.0' ||
  release.repository?.url !== 'git+https://github.com/sebastiaanwouters/porteau.git' ||
  release.dist?.integrity !== process.env.INTEGRITY
)
  process.exit(20)
NODE
}

set +e
registry_state
state=$?
set -e
case "$state" in
  0) echo "porteau@$version is already published as the validated artifact." ;;
  10)
    npm publish "$tarball" --ignore-scripts --access public --tag next --provenance
    ;;
  20)
    echo "porteau@$version exists with different metadata or integrity." >&2
    exit 1
    ;;
  *)
    echo 'Unable to establish package state from the npm registry.' >&2
    exit 1
    ;;
esac

for attempt in {1..12}; do
  set +e
  registry_state
  state=$?
  set -e
  [[ "$state" == 0 ]] && break
  [[ "$state" == 20 ]] && {
    echo 'Published package integrity mismatch.' >&2
    exit 1
  }
  ((attempt == 12)) && {
    echo 'Published package did not become available.' >&2
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
