# cavium-ip-offload (ipfwd)

Cavium's IP forwarding offload module for Octeon, as published in Ubiquiti's EdgeOS GPL
archive (`GPL.octeon.v3.0.0-rc.9.5753459.tar.bz2`, `ubnt-platform` 0.1.18, directory
`cavium-ipfwd-offload/`), ported to Linux 5.15 (Oracle UEK7) and 5.4 (UEK6). It is GPL-2.0, like
the original; the Cavium copyright headers are kept as they were. Where a header refers to "the
file COPYING in the main directory", that is the Linux kernel's, the same GPL v2 text as this
repository's [COPYING](../../COPYING). `export.c` and `export.h` had no header in the release
and still don't; they are GPL-2.0 like the rest of the module (`MODULE_LICENSE("GPL")`).

The module learns flows the kernel has already routed, NATed and accepted, and forwards later
packets of those flows straight from the Octeon Ethernet driver's receive path. It needs the
kernel hooks from [`patches/uek7`](../../patches/uek7) (0001–0003 and 0005). Its controls and
statistics are under `/proc/cavium/`.

## Changes from the GPL release

All of them are in [`patches/ipfwd`](../../patches/ipfwd). Applied in order to the
unmodified `cavium-ipfwd-offload/` directory, the series reproduces this directory exactly
(apart from this README). In short:

- builds on 5.4 and 5.15 (`ipfwd_compat.h`), without DPI (it needs Ubiquiti's
  `ubnt_nf_app.ko`, which isn't part of the GPL release);
- cached flows are invalidated on firewall commits, route, address, link and neighbour
  changes, and on demand through `/proc/cavium/invalidate`;
- conntrack's TCP window tracking stays valid for offloaded flows;
- a cache hit is accepted only from the port the flow was learned on;
- use-after-free and torn-read fixes between the fast path and flow learning, a keyed
  bucket hash, bounded `/proc` writes, serialized table control paths;
- `/proc/cavium/flows`: the live flows as text, for the web UI's connection list.

## Building

In the OpenWrt build it is the package `kmod-cavium-ip-offload`
([`openwrt/package/kernel/cavium-ip-offload`](../../openwrt/package/kernel/cavium-ip-offload)),
which copies the git-tracked files of this directory and builds them against the target
kernel. It also builds on its own against a configured kernel tree
(`make M=modules/ipfwd KERNEL_SRC_DIR=<kernel source> MODULE_TOPDIR=<this directory>`).
`make IPFWD_POISON=1` makes a test build that poisons freed flow buffers.
