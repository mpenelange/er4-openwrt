#!/bin/bash
# Build OpenWrt for the ER-4 (src/openwrt, see openwrt/README.md) and put the installable image
# in images/ at the repo root:
#   images/er4-openwrt-<date>-<repo commit>-k<uek7 commit>.bin      (+ .sha256)
# That's the initramfs kernel, the file the UI's firmware page takes.
# OpenWrt's sysupgrade .tar files are not copied: our install path can't use them.
#   tools/build-openwrt.sh [make args]     default: -j$(nproc); log in build/openwrt-build.log
#   tools/build-openwrt.sh --copy-only     just copy the last build
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=$ROOT/src/openwrt/bin/targets/er4/generic
IMG=$OUT/openwrt-er4-generic-ubnt_edgerouter-4-initramfs-kernel.bin
LOG=$ROOT/build/openwrt-build.log

if [[ ${1:-} != --copy-only ]]; then
    (( $# )) || set -- -j"$(nproc)"
    # er4-ui packages ui/dist as it finds it: build it from the current source first (it used to
    # be whatever the last test run left there)
    echo "building ui/"
    (cd "$ROOT/ui" && npx tsc --noEmit -p . && npx vite build --logLevel warn) || { echo "ui build failed"; exit 1; }
    # OpenWrt re-packages er4-ui only when its own files change, not ui/dist: force it
    make -C "$ROOT/src/openwrt" package/utils/er4-ui/clean >/dev/null 2>&1 || true
    mkdir -p "$(dirname "$LOG")"
    echo "building (log: $LOG)"
    if ! make -C "$ROOT/src/openwrt" "$@" > "$LOG" 2>&1; then
        tail -5 "$LOG"
        echo "build failed; for details re-run with: make -C src/openwrt -j1 V=s"
        exit 1
    fi
fi

[[ -f $IMG ]] || { echo "no image at $IMG"; exit 1; }
dirty() { [[ -n $(git -C "$1" status --porcelain --untracked-files=no) ]] && echo -dirty || true; }
rev=$(git -C "$ROOT" rev-parse --short=7 HEAD)$(dirty "$ROOT")
krev=$(git -C "$ROOT/src/uek7-openwrt" rev-parse --short=7 HEAD)$(dirty "$ROOT/src/uek7-openwrt")
name=er4-openwrt-$(date -r "$IMG" +%Y%m%d-%H%M)-$rev-k$krev.bin

mkdir -p "$ROOT/images"
cp "$IMG" "$ROOT/images/$name"
(cd "$ROOT/images" && sha256sum "$name" > "$name.sha256")
echo "images/$name"
cat "$ROOT/images/$name.sha256"
