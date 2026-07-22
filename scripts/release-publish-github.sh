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

channel=alpha
channel_dir="$download_dir/channel"
mkdir -p "$channel_dir"

if ! gh release view "$channel" >/dev/null 2>&1; then
  gh release create "$channel" "$install_script" \
    --prerelease --title alpha --notes "Current alpha installer (floating channel)."
else
  channel_prerelease="$(gh release view "$channel" --json isPrerelease --jq .isPrerelease)"
  [[ "$channel_prerelease" == true ]] || {
    echo "$channel exists as a full release." >&2
    exit 1
  }
  gh release upload "$channel" "$install_script" --clobber
fi

gh release download "$channel" --pattern install.sh --dir "$channel_dir" --clobber
cmp "$install_script" "$channel_dir/install.sh"
