#!/usr/bin/env bash
set -Eeuo pipefail

candidate_dir="${1:?Usage: release-publish-github.sh <candidate-dir>}"
tag="${GITHUB_REF_NAME:?GITHUB_REF_NAME is required}"
install_script="$candidate_dir/install.sh"
tarball="$candidate_dir/porteau.tgz"

[[ -f "$install_script" ]] || {
  echo "Missing installer: $install_script" >&2
  exit 2
}
[[ -f "$tarball" ]] || {
  echo "Missing package tarball: $tarball" >&2
  exit 2
}

download_dir="${RUNNER_TEMP:-$(mktemp -d)}/release-download"
mkdir -p "$download_dir"

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
    gh api "repos/$GITHUB_REPOSITORY/releases/tags/$tag" \
      --jq "[.assets[] | select(.name == \"$name\")][0].id // empty"
  )"
  if [[ -z "$asset_id" ]]; then
    [[ "$draft" == true ]] || {
      echo "Public prerelease is missing $name." >&2
      exit 1
    }
    gh release upload "$tag" "$path"
  fi
}

ensure_asset "$install_script"
ensure_asset "$tarball"

gh release download "$tag" --pattern 'install.sh' --pattern 'porteau.tgz' --dir "$download_dir" --clobber
cmp "$install_script" "$download_dir/install.sh"
cmp "$tarball" "$download_dir/porteau.tgz"
[[ "$draft" == true ]] && gh release edit "$tag" --draft=false --prerelease
