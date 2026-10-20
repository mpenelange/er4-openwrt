# OpenWrt for the Ubiquiti EdgeRouter 4, with hardware flow offload

This is a port of OpenWrt 25.12 to the Ubiquiti EdgeRouter 4 (ER-4: Cavium Octeon III
CN7130, four cores, 1 GiB RAM, three RJ45 ports and an SFP cage). Upstream OpenWrt already runs
on the ER-4, but without the flow offload engine that lets the stock firmware route at gigabit
speeds without using up the CPU. This port keeps that engine. It builds OpenWrt from source on
Oracle's UEK7 kernel (Linux 5.15), which carries Cavium's Octeon SDK drivers, and ports the
Cavium IP forwarding offload module from Ubiquiti's GPL source release onto it. The result is a
maintained OpenWrt userland that routes and NATs IPv4 and IPv6 at about line rate with the CPU
mostly idle. It started as a way to give a spare router a modern kernel and userland without
losing what made it fast.

## Highlights

- **Hardware flow offload, IPv4 and IPv6.** After the first packets of a connection, it is
  forwarded from the Ethernet driver's receive path and skips the kernel network stack. A single
  TCP stream routes at about 940 Mbit/s with the router at roughly 16% CPU; over IPv6 the same
  stream needs 55% without offload. 64-byte packets forward at the full rate the test rig can
  send. See
  [docs/performance.md](docs/performance.md).
- **The firewall stays in charge.** Flows are learned only after netfilter has accepted
  them. Rule, route, address and link changes invalidate the cache, and rules that need to
  see every packet (rate limits, quotas, logging) keep their flows on the CPU. See
  [docs/offload.md](docs/offload.md).
- **IPsec on the Octeon crypto unit.** New kernel drivers for AES (ECB/CBC/CTR) and GHASH, so
  ESP with AES-GCM runs on the hardware instructions. WireGuard and strongSwan IKEv2 are in the
  image. Tailscale is Tailscale's own build: the router downloads it when you set it up, and it
  keeps itself up to date.
- **A web UI written for this router** (Preact, no LuCI). Every change is staged, shown as a
  diff and applied with a 60-second confirm window: if you lock yourself out, the router
  rolls back on its own. See [docs/web-ui.md](docs/web-ui.md).
- **Two firmware images on the eMMC.** Installing a new image keeps the previous one, and you
  can boot it again from the UI. The stock U-Boot and SPI flash are never written.
- **Secure defaults.** On a fresh install the router asks you to set a password first. SSH
  accepts keys only, management and DNS are closed to the WAN, failed logins are throttled.
  See [docs/security.md](docs/security.md).

## Status and caveats

This is a hobby project, tested on **one** ER-4. It has run on that unit through its
development and a first stretch of everyday use. It went through a lab test plan, a code audit
and a black-box attack exercise (see [docs/security.md](docs/security.md)). That is still a small sample. Please treat it as
experimental and keep a way back (the [installing guide](docs/installing.md) keeps the stock
firmware on the router for that reason).

- **ER-4 only.** The ER-6P and ER-12 use the same SoC family but different port layouts and
  have not been tried. The image checks the board name before it installs.
- **Not done or not tested:**
  - PPPoE WAN is configurable but untested, and PPPoE offload is off by default.
  - Multi-WAN and failover are not implemented.
  - Tailscale runs in userspace on the CPU, so it is much slower than WireGuard, and it has had
    only light testing on hardware.
  - No DPI/traffic classification (the stock engine is closed source). Bridged traffic is
    never offloaded, so a LAN bridge across several ports is switched by the CPU. Use one port
    per network, or VLANs on one port, for full speed.
  - A full 24-hour soak hasn't been run on the current image yet. The longest runs so far are
    two runs of about 10 hours on earlier builds and a 2-hour run on the current one, with no
    errors or leaks (one unexplained dip in IPv6 upload throughput; see
    [docs/performance.md](docs/performance.md)).
- **Known open issues:**
  - Changing a LAN from bridged to unbridged on a running router leaves IPv6 disabled on that
    port until the network is restarted (a reload is not enough).
  - A static IPv6 route via a gateway in a new LAN prefix is skipped when the same apply
    also changes that prefix. It is installed on the next interface restart.
- **Stock U-Boot only.** There is no automatic fallback if a new image fails to boot. You fall
  back from the UI, or from the serial console (below).

## Quick start

**Get an image.** Prebuilt images are on the [Releases](../../releases) page: an
`er4-openwrt-….bin` file and its `.sha256`. Check it with `sha256sum -c` before you
install it.

**Or build it** on any Linux host with podman. You need about 80 GB of disk, 16 GB of RAM is
comfortable (the build runs `make -j$(nproc)`; pass a smaller `-j` on a small machine), and
the first build takes a few hours, most of it cloning the kernel and building OpenWrt's
toolchain. Details are in [docs/building.md](docs/building.md).

```sh
# on the host, from the repository root: the build container (rootless podman)
podman build -t er4-build -f tools/container/Containerfile tools/container
podman run --rm -it --userns=keep-id -v "$PWD:$PWD:Z" -w "$PWD" er4-build bash

# in the container
. ./versions      # the upstream tags to build from
git clone --single-branch --branch "$UEK7_BRANCH" https://github.com/oracle/linux-uek.git src/uek7
git -C src/uek7 checkout -b er4 "$UEK7_TAG"
git -C src/uek7 -c user.name=er4 -c user.email=er4@localhost am "$PWD"/patches/uek7/*.patch
git clone --branch "$OPENWRT_TAG" https://github.com/openwrt/openwrt.git src/openwrt
(cd src/openwrt && ./scripts/feeds update -a && ./scripts/feeds install -a)
(cd ui && npm ci)
openwrt/setup.sh && tools/build-openwrt.sh
# -> images/er4-openwrt-<date>-<commit>-k<kernel commit>.bin (+ .sha256)
```

**Install.** The first install is a file copy onto the router's boot partition, from EdgeOS
or from a netbooted image. You keep the stock kernel next to it so you can go back. After that,
upgrades go through **System → Firmware** in the web UI. Step by step:
[docs/installing.md](docs/installing.md).

**First boot.** Connect a computer to **eth1** and open <http://192.168.1.1/>. The router
asks you to set a password before anything else (at least 8 characters). Plug the WAN into
**eth0**. To use SSH, add your public key under **System → SSH** first: password login is off
on a fresh install.

> [!WARNING]
> Flashing custom firmware can leave a router unbootable, and you do it at your own risk. This
> port never writes U-Boot or the SPI flash, so a mistake on the eMMC can always be fixed from
> the **serial console** (an RJ45 "Cisco" console cable, 115200 8N1) by netbooting a working
> image over TFTP. Have the cable before you start. Recovery is covered in
> [docs/installing.md](docs/installing.md#recovery) and [docs/hardware.md](docs/hardware.md).

## Documentation

| Document | What's in it |
|---|---|
| [docs/building.md](docs/building.md) | Build container, source trees, build scripts, outputs |
| [docs/installing.md](docs/installing.md) | First install, the two image slots, upgrades, rollback, factory reset, recovery |
| [docs/hardware.md](docs/hardware.md) | ER-4 specifics: port names, eMMC layout, U-Boot, serial console |
| [docs/offload.md](docs/offload.md) | How the fast path works, what is offloaded and what isn't, invalidation, IPv6 |
| [docs/performance.md](docs/performance.md) | Measured forwarding, NAT, IPv6, VPN, QoS and soak results, and how they were measured |
| [docs/security.md](docs/security.md) | Defaults, what was audited and attacked, residual risks, how to report a problem |
| [docs/web-ui.md](docs/web-ui.md) | What the web UI does; [ui/README.md](ui/README.md) covers UI development |
| [openwrt/README.md](openwrt/README.md) | The OpenWrt overlay itself: target, packages, kernel config handling |
| [patches/README.md](patches/README.md) | The kernel and offload-module patch series and what they apply to |
| [modules/ipfwd/README.md](modules/ipfwd/README.md) | The offload module: origin, changes, build |
| [reference/README.md](reference/README.md) | Reference material (the upstream OpenWrt ER-4 device tree) |

## Credits

This port mostly connects other people's work, and it would not exist without them:

- **The OpenWrt project and its contributors**: the userland, the build system, netifd, fw4,
  procd, rpcd, uhttpd, and the existing `octeon` target and ER-4 device tree this port
  borrows from.
- **Oracle**, for the Unbreakable Enterprise Kernel ([linux-uek](https://github.com/oracle/linux-uek)).
  UEK7 is a maintained 5.15 kernel that still carries Cavium's Octeon SDK and its Ethernet
  driver, which the offload engine depends on.
- **Cavium (now Marvell)**, who wrote the IP forwarding offload engine, the Octeon SDK and the
  Ethernet driver, and **Ubiquiti**, for publishing them, together with their kernel hooks, in
  the EdgeOS GPL source release. The offload module here is their code with a port and fixes
  on top.
- **The authors of the Linux Octeon support and the `staging/octeon` Ethernet driver**, whose
  upstream work made Octeon boards like this one usable on mainline kernels. Their Octeon
  SHA-1/SHA-256/SHA-512 crypto drivers are used here as they are.
- **Bootlin**, for prebuilt cross toolchains; and the projects in the image: strongSwan,
  WireGuard, Tailscale, dnsmasq, odhcpd, nftables, and on the UI side Preact, uPlot and Vite.

Any mistakes in the port are mine, not theirs.

## License

GPL-2.0-only; see [COPYING](COPYING). Files without a license header of their own are covered
by it too. The exceptions keep the licenses they came with:

- the Cavium offload module in [`modules/ipfwd`](modules/ipfwd/README.md) (GPL-2.0, from
  Ubiquiti's EdgeOS GPL source release);
- the kernel patches (Linux, GPL-2.0) and the OpenWrt package files and patches (GPL-2.0, per
  OpenWrt);
- the upstream OpenWrt device tree in [`reference/`](reference/README.md)
  (GPL-2.0-or-later OR MIT);
- the web UI's bundled libraries and a few icons (MIT).

[NOTICE](NOTICE) lists the third-party code and where it came from. "EdgeRouter", "EdgeOS" and
"Ubiquiti" are trademarks of Ubiquiti Inc. This project is not affiliated with or endorsed by
Ubiquiti, Oracle, Marvell or the OpenWrt project.
