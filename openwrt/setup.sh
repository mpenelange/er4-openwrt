#!/bin/bash
# Prepare src/openwrt (OpenWrt + feeds, at the tag in ./versions) to build the ER-4 image:
#   - link this overlay (target/linux/er4, the offload kmod, generic/kernel-5.15) into the tree
#   - a git worktree of src/uek7 at branch er4 for OpenWrt to build in place (src/uek7-openwrt;
#     tools/kernel-config.sh uses O=build/uek7 and needs src/uek7 itself to stay clean)
#   - .config from ./diffconfig
# Then: cd src/openwrt && make -j$(nproc), or tools/build-openwrt.sh (see README.md).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OW=$ROOT/src/openwrt
OV=$ROOT/openwrt
WT=$ROOT/src/uek7-openwrt
. "$ROOT/versions"

[[ -d $OW/.git ]] || { echo "no OpenWrt tree at $OW (docs/building.md)"; exit 1; }
[[ $(git -C "$OW" rev-parse HEAD) == $(git -C "$OW" rev-parse -q --verify "$OPENWRT_TAG^{commit}" || echo none) ]] ||
    { echo "src/openwrt is not at $OPENWRT_TAG (./versions)"; exit 1; }
git -C "$ROOT/src/uek7" merge-base --is-ancestor "$UEK7_TAG" er4 2>/dev/null ||
    { echo "branch er4 in src/uek7 is not based on $UEK7_TAG (./versions)"; exit 1; }

if [[ ! -d $WT ]]; then
    git -C "$ROOT/src/uek7" worktree add --detach "$WT" er4
else
    # follow branch er4; the tree is OpenWrt's build dir, so keep it clean of local edits
    [[ -z $(git -C "$WT" status --porcelain --untracked-files=no) ]] || { echo "$WT has local changes"; exit 1; }
    git -C "$WT" checkout -q --detach er4
fi
echo "kernel: $(git -C "$WT" log --oneline -1)"

ln -sfn "$OV/target/linux/er4" "$OW/target/linux/er4"
ln -sfn "$OV/target/linux/generic/kernel-5.15" "$OW/target/linux/generic/kernel-5.15"
ln -sfn "$OV/package/kernel/cavium-ip-offload" "$OW/package/kernel/cavium-ip-offload"
ln -sfn "$OV/package/utils/er4-ui" "$OW/package/utils/er4-ui"
# Patches for upstream packages: 6.x kernel header assumptions (our toolchain uses 5.15's), a
# ujail signal race, and login hardening for rpcd (no login without a password) and uhttpd
# (failed-login throttle). Each patch is linked on its own, so a patches/ directory OpenWrt
# itself has for that package keeps working next to ours.
for p in $(cd "$OV" && find package -mindepth 3 -maxdepth 4 -type d -name patches | sed "s#^#$OV/#"); do
    pkg=${p#$OV/}; pkg=${pkg%/patches}
    [[ $pkg == kernel/cavium-ip-offload || $pkg == utils/er4-ui ]] && continue
    [[ -d $OW/$pkg ]] || { echo "OpenWrt has no package/$pkg"; exit 1; }
    [[ -L $OW/$pkg/patches ]] && rm "$OW/$pkg/patches"    # older setup.sh linked the directory
    mkdir -p "$OW/$pkg/patches"
    find "$OW/$pkg/patches" -xtype l -delete    # links to patches we have since dropped
    for f in "$p"/*.patch; do
        ln -sfn "$f" "$OW/$pkg/patches/"
        [[ -e $OW/$pkg/patches/$(basename "$f") ]] || { echo "failed to link $f"; exit 1; }
    done
done

sed "s#@ROOT@#$ROOT#g" "$OV/diffconfig" > "$OW/.config"
make -C "$OW" defconfig >/dev/null
rm -f "$OW/.er4-variant"    # left by older versions, which had a LuCI variant
grep -E '^CONFIG_(TARGET_er4|EXTERNAL_KERNEL_TREE|TARGET_ROOTFS_INITRAMFS|PACKAGE_kmod-cavium|PACKAGE_luci-base|PACKAGE_er4-ui)=' "$OW/.config"
