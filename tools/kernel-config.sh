#!/bin/bash
# Regenerate the ER-4 kernel config, openwrt/target/linux/er4/config-5.15, from UEK7's
# cavium_octeon_defconfig plus configs/er4.fragment. Only needed after editing the fragment (or
# moving to a newer UEK7): the generated file is committed, and the image build uses it as is.
#   tools/kernel-config.sh
# Needs src/uek7 at branch er4 (docs/building.md). The first run downloads the Bootlin cross
# toolchain the config was made with (mips64-n32, glibc, stable 2021.11-1) into toolchains/: the
# config records the compiler, so with another one the file comes out different.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TC=mips64-n32--glibc--stable-2021.11-1
TC_URL=https://toolchains.bootlin.com/downloads/releases/toolchains/mips64-n32/tarballs/$TC.tar.bz2
TC_SHA256=8d5c891bb2eecccf1f9c51095d266c899dae4dd7e75ef19ff6c66c8e4602919c
K=$ROOT/src/uek7
B=$ROOT/build/uek7
OUT=$ROOT/openwrt/target/linux/er4/config-5.15

[[ -d $K/.git ]] || { echo "no kernel tree at src/uek7 (see docs/building.md)"; exit 1; }

if [[ ! -x $ROOT/toolchains/$TC/bin/mips64-linux-gcc ]]; then
    mkdir -p "$ROOT/toolchains"
    T=$ROOT/toolchains/$TC.tar.bz2.part
    echo "fetching $TC (about 125 MB)"
    curl -fL --retry 3 -o "$T" "$TC_URL"
    echo "$TC_SHA256  $T" | sha256sum -c --quiet || { echo "checksum mismatch: $TC_URL"; rm -f "$T"; exit 1; }
    tar -xjf "$T" -C "$ROOT/toolchains"
    rm -f "$T"
    "$ROOT/toolchains/$TC/relocate-sdk.sh" >/dev/null
fi
export PATH=$ROOT/toolchains/$TC/bin:$PATH

# LOCALVERSION= (set but empty) stops setlocalversion from appending "+" for an untagged tree
M=(make -C "$K" O="$B" ARCH=mips CROSS_COMPILE=mips64-linux- LOCALVERSION=)
mkdir -p "$B"
"${M[@]}" -s cavium_octeon_defconfig
"$K/scripts/kconfig/merge_config.sh" -m -O "$B" "$B/.config" "$ROOT/configs/er4.fragment" >/dev/null
"${M[@]}" -s olddefconfig
# OpenWrt sets the initramfs options itself
grep -v -E '^CONFIG_INITRAMFS_(SOURCE|ROOT_UID|ROOT_GID)=' "$B/.config" > "$OUT"
if git -C "$ROOT" diff --quiet -- "$OUT"; then
    echo "config-5.15: unchanged"
else
    git -C "$ROOT" diff --stat -- "$OUT"
    echo "config-5.15 changed: review it (git diff), commit it, then openwrt/setup.sh"
fi
