# Building the image

The build produces one file: a MIPS64 big-endian ELF that holds the kernel and the whole
OpenWrt root filesystem (as a compressed initramfs). The stock U-Boot loads it as it is, so
installing an image just means copying this file to the router's boot partition
([installing.md](installing.md)).

## Overview

```
src/uek7          Oracle UEK7 (5.15) + patches/uek7     ─┐
src/openwrt       OpenWrt 25.12 + feeds                 ─┤
openwrt/          this repository's overlay             ─┤  openwrt/setup.sh  (links overlay, writes .config)
modules/ipfwd     the offload engine                    ─┤
ui/               the web UI                            ─┘  tools/build-openwrt.sh → images/*.bin

configs/er4.fragment  ER-4 kernel options  ── tools/kernel-config.sh → openwrt/target/linux/er4/config-5.15
                                              (committed; only rerun after editing the fragment)
```

`src/`, `build/`, `toolchains/` and `images/` are created by the scripts and ignored by
git. The exact upstream versions (the OpenWrt tag, the UEK7 branch and tag) are in
[`versions`](../versions); the commands below read them from there.

What it takes: about 80 GB of disk (the UEK clone, the OpenWrt tree and its build), and a few hours for the first build, most of it cloning the kernel and building
OpenWrt's own toolchain. The scripts run `make -j$(nproc)`; at roughly 1-2 GB of RAM per job
that wants 16 GB on a typical desktop, so give a smaller machine a smaller `-j` (for example
`tools/build-openwrt.sh -j4`).

## 1. A build container

Build inside a container, not on your host. Everything the build needs is listed in
[`tools/container/Containerfile`](../tools/container/Containerfile) (Debian trixie: compilers,
kernel build tools and Node.js for the UI). Run it with rootless podman, as your own user:

```sh
podman build -t er4-build -f tools/container/Containerfile tools/container
podman run --rm -it --userns=keep-id -v "$PWD:$PWD:Z" -w "$PWD" er4-build bash
```

The first build takes a while, mostly for OpenWrt's own toolchain. Later builds are much faster.
All the commands below run inside this container, from the repository root.

## 2. Source trees

All under `src/` in the repository root.

### Kernel: Oracle UEK7

UEK7 Update 3 (5.15) from [oracle/linux-uek](https://github.com/oracle/linux-uek), branch
`$UEK7_BRANCH`, with this repository's patches on a local branch named `er4`. The patches apply to
tag `$UEK7_TAG`.

```sh
. ./versions
git clone --single-branch --branch "$UEK7_BRANCH" https://github.com/oracle/linux-uek.git src/uek7
git -C src/uek7 checkout -b er4 "$UEK7_TAG"
git -C src/uek7 -c user.name=er4 -c user.email=er4@localhost am "$PWD"/patches/uek7/*.patch
```

`git am` needs a committer identity, and the container has none; the `-c` options give it one
(any name will do, or set your own with `git config`). The repository is large, even with
`--single-branch`; expect the clone to take some time.

| Patch | What it does |
|---|---|
| 0001 | The offload hooks in the network core (`sk_buff` fields, receive/transmit hooks in `dev.c`), ported from Ubiquiti's 4.9 kernel |
| 0002 | The remaining Ethernet driver interfaces the offload module uses |
| 0003 | Marks for flows the offload engine must not cache (per-packet firewall expressions, bridges, tc actions, macvlan) |
| 0004 | Fix a double IRQ descriptor allocation in UEK's Octeon interrupt setup (boot panic on CN7130) |
| 0005 | Invalidate offloaded flows on every nftables commit and iptables table replace |
| 0006 | Bound the fast path's transmit queue, so one flow into a slower port can't starve the others |
| 0007 | Build fix for GCC 14 |
| 0008 | Name the ports after the front panel (as the stock kernel does) |
| 0009 | AES (ECB/CBC/CTR) and GHASH drivers for the Octeon crypto unit |
| 0010 | `/proc/net` files keep `lseek` (a 5.15-stable regression that broke odhcpd's IPv6 router advertisements) |

`patches/ipfwd/` is the series that turns Ubiquiti's unmodified `cavium-ipfwd-offload` source (EdgeOS GPL archive
v3.0.0-rc.9) into [`modules/ipfwd`](../modules/ipfwd/README.md) exactly. The module in the
repository already has all of it, so there's nothing to apply for a build. See
[patches/README.md](../patches/README.md) for the details of each series.

### Kernel configuration

[`configs/er4.fragment`](../configs/er4.fragment) is the ER-4's kernel configuration on top of
UEK7's `cavium_octeon_defconfig`, with a comment explaining each option. The merged result is
committed as [`openwrt/target/linux/er4/config-5.15`](../openwrt/target/linux/er4/config-5.15),
and that is what the image build uses, so a normal build needs no step here. After editing the
fragment, regenerate it:

```sh
tools/kernel-config.sh     # writes config-5.15 and shows whether it changed; commit it
```

The script downloads a Bootlin cross toolchain (`mips64-n32`, glibc, stable 2021.11-1) into
`toolchains/` the first time and checks its SHA-256. It is only used to generate the config,
which records the compiler version: with the same toolchain, an unchanged fragment gives a
byte-identical file. OpenWrt then builds the kernel with its own toolchain.

### OpenWrt

```sh
. ./versions
git clone --branch "$OPENWRT_TAG" https://github.com/openwrt/openwrt.git src/openwrt
cd src/openwrt && ./scripts/feeds update -a && ./scripts/feeds install -a && cd -
```

## 3. Configure: `openwrt/setup.sh`

```sh
openwrt/setup.sh
```

It:

- links the overlay ([`openwrt/`](../openwrt/README.md): the `er4` target, the offload kmod, the
  `er4-ui` package and the patches for upstream packages) into `src/openwrt`;
- creates `src/uek7-openwrt`, a git worktree of `src/uek7` at branch `er4`. OpenWrt builds the
  kernel in place there (`CONFIG_EXTERNAL_KERNEL_TREE`), with its own GCC 14/musl toolchain and
  the committed `config-5.15`. OpenWrt's own kernel option defaults are deliberately not applied
  on top, so the tested config stays authoritative;
- writes `src/openwrt/.config` from [`openwrt/diffconfig`](../openwrt/diffconfig): the ER-4
  device and kernel, the offload kmod and the web UI, plus WireGuard, strongSwan (IKEv2) and
  6in4. Tailscale isn't built: the router downloads Tailscale's own build when it's set up
  ([web-ui.md](web-ui.md#tailscale)).

Commit kernel changes on branch `er4` in `src/uek7`. `setup.sh` checks the worktree out at that
branch each time and refuses to run if it has local changes. It also stops if `src/openwrt`
isn't at `$OPENWRT_TAG` or branch `er4` isn't based on `$UEK7_TAG`, so the trees can't drift
from [`versions`](../versions) unnoticed.

The UI needs its npm dependencies once: `(cd ui && npm ci)`.

## 4. Build: `tools/build-openwrt.sh`

```sh
tools/build-openwrt.sh                  # make -j$(nproc) in src/openwrt
tools/build-openwrt.sh -j1 V=s          # any make arguments; use this to see a failure in detail
tools/build-openwrt.sh --copy-only      # just copy the last build's image again
```

It type-checks and builds `ui/` first, and makes OpenWrt re-package it
(OpenWrt would otherwise reuse a stale copy of the UI). The build log is
`build/openwrt-build.log`.

### Output

```
images/er4-openwrt-<YYYYMMDD-HHMM>-<repo commit>-k<kernel commit>.bin
images/er4-openwrt-<YYYYMMDD-HHMM>-<repo commit>-k<kernel commit>.bin.sha256
```

The `.bin` file is what you install. It ends with a short trailer after the ELF data, holding
the board name (`ubnt,edgerouter-4`) and a build ID (repository commit, kernel commit, build
time). U-Boot ignores the trailer. The firmware page uses it to check an image before it
installs it, and to tell builds apart. A `-dirty` suffix on a commit means the tree had
uncommitted changes.

OpenWrt's own `sysupgrade` tarballs end up in `src/openwrt/bin/targets/er4/generic/` too.
They aren't used, because this target installs the image file instead.

The image is 25-30 MB (`ls -l images/`). Its initramfs is zstd-compressed, so that two images fit on the boot
partition next to the stock kernels.

## What's in the image

Each image is the whole system. It runs from RAM, and only `/etc` is kept on the eMMC
([installing.md](installing.md#what-is-kept-where)). There's no package manager (`apk`): a
package installed at runtime would be gone after the next reboot, and kernel modules from
upstream OpenWrt don't match this kernel anyway. Anything you want on the router goes into the image: add it to
`openwrt/diffconfig` and rebuild.

Kernel modules for this target come from this build only. OpenWrt 25.12's official package
feeds are built for its 6.12 kernel, so their userland packages (same architecture,
`mips64_octeonplus`) would work, but their kmods would not.

## Releases

```sh
tools/release.sh             # build/release/<YYYY-MM-DD>/: the image, its sources, SHA256SUMS, notes
tools/release.sh --publish   # also tag the build's commit with the date and create the GitHub release
```

Releases are named by date. The script takes the newest image in `images/`, which must come from
a clean, committed tree, and packages the complete corresponding source with it: this
repository at the image's commit, the kernel tree it was built from, and OpenWrt with its
feeds and every source archive the build downloaded. Run it on the host, where `gh` is logged
in; `--publish` needs the GitHub remote as `origin`.
