#!/usr/bin/env bash
set -Eeuo pipefail

install_script="${1:?Usage: release-publish-github.sh <install.sh>}"
tag="${GITHUB_REF_NAME:?GITHUB_REF_NAME is required}"
[[ -f "$install_script" ]] || {
  echo "Missing installer: $install_script" >&2
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
  gh release create "$tag" "$install_script" \
    --verify-tag --draft --prerelease --generate-notes --title "$tag"
  draft=true
fi

asset_id="$(
  gh api "repos/$GITHUB_REPOSITORY/releases/tags/$tag" \
    --jq '[.assets[] | select(.name == "install.sh")][0].id // empty'
)"
if [[ -z "$asset_id" ]]; then
  [[ "$draft" == true ]] || {
    echo 'Public prerelease is missing install.sh.' >&2
    exit 1
  }
  gh release upload "$tag" "$install_script"
fi

gh release download "$tag" --pattern install.sh --dir "$download_dir" --clobber
cmp "$install_script" "$download_dir/install.sh"
[[ "$draft" == true ]] && gh release edit "$tag" --draft=false --prerelease
