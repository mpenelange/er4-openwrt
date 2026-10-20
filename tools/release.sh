#!/bin/bash
# Package the last build (tools/build-openwrt.sh) as a release named by date, with the complete
# corresponding source next to the image, as the GPL asks of anyone who hands out binaries:
#   tools/release.sh             write build/release/<YYYY-MM-DD>/ (image, sources, SHA256SUMS, notes)
#   tools/release.sh --publish   also tag the build's commit <YYYY-MM-DD> and create a GitHub
#                                release from that directory (gh, logged in, remote 'origin')
# The image must come from a clean, committed tree: its name and build ID carry the commit.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT/versions"
OW=$ROOT/src/openwrt
WT=$ROOT/src/uek7-openwrt

img=$(ls -t "$ROOT"/images/er4-openwrt-*.bin 2>/dev/null | head -1)
[[ -n $img ]] || { echo "no image in images/: run tools/build-openwrt.sh"; exit 1; }
name=$(basename "$img")
[[ $name != *-dirty* ]] || { echo "$name was built from uncommitted changes"; exit 1; }
# er4-openwrt-<date>-<time>-<commit>-k<kernel commit>.bin
rev=$(sed -E 's/.*-([0-9a-f]{7})-k[0-9a-f]{7}\.bin$/\1/' <<<"$name")
krev=$(sed -E 's/.*-k([0-9a-f]{7})\.bin$/\1/' <<<"$name")
commit=$(git -C "$ROOT" rev-parse "$rev^{commit}")
[[ $(git -C "$WT" rev-parse --short=7 HEAD) == "$krev" ]] || { echo "src/uek7-openwrt is not at the image's kernel commit $krev"; exit 1; }
(cd "$ROOT/images" && sha256sum -c --quiet "$name.sha256")

# Named by the UTC date (as the image names are); a second release on the same day gets -2, -3, ...
tag=$(date -u +%F); n=1
while git -C "$ROOT" rev-parse -q --verify "refs/tags/$tag" >/dev/null \
      && [[ $(git -C "$ROOT" rev-parse "$tag^{commit}") != "$commit" ]]; do
    n=$(( n + 1 )); tag=$(date -u +%F)-$n
done
R=$ROOT/build/release/$tag
rm -rf "$R"; mkdir -p "$R"
echo "release $tag: $name"

cp "$img" "$img.sha256" "$R/"
echo "source: this repository at $rev"
git -C "$ROOT" archive --prefix="er4-openwrt-$rev/" -o "$R/er4-openwrt-src-$rev.tar.gz" "$commit"
echo "source: kernel at $krev"
git -C "$WT" archive --prefix="linux-uek-er4-$krev/" "$krev" | xz -T0 -6 > "$R/linux-uek-er4-src-$krev.tar.xz"
echo "source: OpenWrt, feeds and downloaded package sources"
S=$(mktemp -d)
trap 'rm -rf "$S"' EXIT
owrev=$(git -C "$OW" describe --tags --always)
git -C "$OW" archive --prefix="openwrt/" -o "$S/openwrt.tar" HEAD
for f in "$OW"/feeds/*/; do
    [[ -d $f/.git ]] || continue
    git -C "$f" archive --prefix="openwrt/feeds/$(basename "$f")/" -o "$S/feed-$(basename "$f").tar" HEAD
    tar -Af "$S/openwrt.tar" "$S/feed-$(basename "$f").tar"
done
tar -rf "$S/openwrt.tar" -C "$OW" --transform 's#^#openwrt/#' dl
xz -T0 -6 < "$S/openwrt.tar" > "$R/openwrt-$owrev-src.tar.xz"

url=$(cd "$ROOT" && gh repo view --json url -q .url 2>/dev/null || echo .)
cat > "$R/NOTES.md" <<EOF
Build of $(date -u -r "$img" '+%Y-%m-%d %H:%M UTC') from commit $rev, kernel commit $krev
(Oracle UEK7 $UEK7_TAG + patches/uek7), OpenWrt $owrev.

Install: \`$name\`. Check it first with \`sha256sum -c $name.sha256\`, then follow
[docs/installing.md]($url/blob/$commit/docs/installing.md).
ER-4 only.

Source for everything in the image:

- \`er4-openwrt-src-$rev.tar.gz\`: this repository at the build's commit
- \`linux-uek-er4-src-$krev.tar.xz\`: the kernel tree the image was built from
- \`openwrt-$owrev-src.tar.xz\`: OpenWrt, its package feeds, and every source archive the build
  downloaded (\`dl/\`)
EOF
(cd "$R" && sha256sum -- *.bin *.tar.* > SHA256SUMS)
ls -l "$R"

[[ ${1:-} == --publish ]] || { echo "not published (tools/release.sh --publish)"; exit 0; }
git -C "$ROOT" tag -f "$tag" "$commit" >/dev/null
git -C "$ROOT" push -q origin "refs/tags/$tag"
cd "$ROOT" && gh release create "$tag" --verify-tag --title "$tag" --notes-file "$R/NOTES.md" \
    "$R/$name" "$R/$name.sha256" "$R"/*.tar.* "$R/SHA256SUMS"
