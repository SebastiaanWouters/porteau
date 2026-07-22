#!/usr/bin/env bash
set -Eeuo pipefail

candidate_dir="${1:?Usage: release-publish-github.sh <candidate-dir>}"
tag="${GITHUB_REF_NAME:?GITHUB_REF_NAME is required}"
version="${tag#v}"
install_script="$candidate_dir/install.sh"
tarball="$candidate_dir/porteau.tgz"

[[ -f "$install_script" ]] || {
  echo "Missing installer: $install_script" >&2
  exit 2
}

# Prefer the exact registry tarball so the GitHub asset matches npm.
pack_dir="${RUNNER_TEMP:-$(mktemp -d)}/npm-pack"
mkdir -p "$pack_dir"
(
  cd "$pack_dir"
  npm pack "porteau@$version" >/dev/null
)
packed="$(find "$pack_dir" -maxdepth 1 -name 'porteau-*.tgz' -type f | head -n 1)"
[[ -n "$packed" && -f "$packed" ]] || {
  echo "Failed to download porteau@$version from the registry" >&2
  exit 2
}
cp "$packed" "$tarball"

download_dir="${RUNNER_TEMP:-$(mktemp -d)}/release-download"
mkdir -p "$download_dir"

# Draft releases are not returned by /releases/tags/{tag}; use `gh release view`.
if state="$(gh release view "$tag" --json isDraft,isPrerelease --jq '[.isDraft,.isPrerelease] | @tsv' 2>/dev/null)"; then
  read -r draft prerelease <<<"$state"
  [[ "$draft" == true || "$prerelease" == true ]] || {
    echo "$tag already exists as a full release." >&2
    exit 1
  }
else
  gh release create "$tag" "$install_script" "$tarball" \
    --verify-tag --draft --prerelease --generate-notes --title "$tag"
  draft=true
fi

ensure_asset() {
  local path="$1"
  local name
  name="$(basename "$path")"
  local asset_id
  asset_id="$(
    gh release view "$tag" --json assets \
      --jq "[.assets[] | select(.name == \"$name\")][0].id // empty"
  )"
  if [[ -z "$asset_id" ]]; then
    [[ "$draft" == true || "$prerelease" == true ]] || {
      echo "Public release is missing $name." >&2
      exit 1
    }
    gh release upload "$tag" "$path" --clobber
  fi
}

ensure_asset "$install_script"
ensure_asset "$tarball"

gh release download "$tag" --pattern 'install.sh' --pattern 'porteau.tgz' --dir "$download_dir" --clobber
cmp "$install_script" "$download_dir/install.sh"
cmp "$tarball" "$download_dir/porteau.tgz"
[[ "$draft" == true ]] && gh release edit "$tag" --draft=false --prerelease
