# ER-4 hardware notes

What this port relies on, and what was found out about the EdgeRouter 4 along the way. Values
come from the development unit's U-Boot and boot logs. Your unit should match, but check before
you depend on a detail.

## The board

| | |
|---|---|
| SoC | Cavium (Marvell) Octeon III CN7130, 4 MIPS64 cores at 1000 MHz, big-endian |
| Memory | 1 GiB (about 970 MB available to Linux) |
| Storage | 4 GB eMMC (`mmcblk0`), plus SPI NOR flash holding U-Boot |
| Ethernet | 3 × RJ45 gigabit, 1 × SFP cage (1G), all on the SoC's QSGMII interface |
| Console | RJ45 console port, 115200 8N1 |
| Other | USB 3.0 host, hardware watchdog, Octeon crypto unit (AES, GHASH, SHA), CRC unit |
| Board ID | U-Boot reports `ubnt_e300`; the device tree says `cavium,ubnt_e300` (shared by the ER-4/6P/12 family). This image names the board `ubnt,edgerouter-4`, as upstream OpenWrt does |

The Ethernet ports use Cavium's SDK `octeon-ethernet` driver (from UEK7), like the stock
firmware, not the mainline `staging/octeon` driver. The offload engine needs the SDK driver.

## Port names

The kernel names the ports after the front panel, as the stock firmware does. The SoC brings
them up in a different order, so U-Boot's names don't match:

| Front panel | Linux | U-Boot | Default role |
|---|---|---|---|
| eth0 | `eth0` | `octeth1` | WAN (DHCP, DHCPv6-PD) |
| eth1 | `eth1` | `octeth2` | LAN, 192.168.1.1/24 |
| eth2 | `eth2` | `octeth3` | unassigned |
| SFP | `eth3` | `octeth0` | unassigned |

Upstream OpenWrt's ER-4 support (with the staging driver) calls the ports `lan0`–`lan3`.
Configurations aren't interchangeable.

**No switch chip.** Every port is a separate interface on the SoC. Bridging ports in Linux
works, but the CPU forwards every bridged frame and the offload engine stays out of it. That's
why the default LAN is plain `eth1` and not a bridge. If you need several ports on one network,
a bridge works, at CPU speed. For full speed, give each network its own port, or carry several
networks as VLANs on one port to a managed switch.

## eMMC layout

| Partition | Filesystem | Used for |
|---|---|---|
| `mmcblk0p1` | FAT | Kernel images: `vmlinux.64` (booted by U-Boot), `vmlinux.64.prev`, `vmlinux.64.edgeos`, EdgeOS's `vmlinux.64o`, each with a `.md5` |
| `mmcblk0p2` | ext3 (mounted as ext4) | EdgeOS's `squashfs.img` and overlay (`w/`), untouched; this port's persistent `/etc` in `er4/etc` |

The firmware page mounts p1 at `/mnt/er4p1` while it works on it. p2 is mounted at
`/mnt/er4data` while the system runs. [installing.md](installing.md#what-is-kept-where)
explains how the files are used.

## U-Boot

| | |
|---|---|
| Version | U-Boot 2013.07, Ubiquiti build `e300_003_6be37` (as shipped with EdgeOS 2.0.9) |
| Prompt | `Octeon ubnt_e300(ram)#` |
| Boot delay | 0: there's no countdown. Send keys continuously from power-on to get the prompt |
| Boot command | `fatload mmc 0 $(loadaddr) vmlinux.64; bootoctlinux $(loadaddr) numcores=$(numcores) endbootargs mem=0 root=/dev/mmcblk0p2 rootdelay=10 rw rootsqimg=squashfs.img rootsqwdir=w mtdparts=…` |
| `loadaddr` | `0x20000000` |
| Netboot | `tftpboot`, `dhcp`, `usbboot` available; `ethact` selects the port (table above) |

`bootoctlinux` starts a raw MIPS64 ELF from memory and passes U-Boot's own device tree, so
the image has no device tree of its own. The kernel adds `console=ttyS0,115200` when U-Boot
passes no console argument.

**Things this port never does**, and you shouldn't either unless you know you want to:

- `saveenv`: the U-Boot environment is left as shipped, so EdgeOS's boot command keeps working.
- `sf` writes or `bootloaderupdate`: U-Boot lives in the SPI flash. If that is damaged, the
  console can't help any more.

Stock EdgeOS can update U-Boot by itself at boot: its boot scripts flash the bootloader it
ships if that one is newer. This port was only tested with the U-Boot above.

## Serial console

- Cable: RJ45 "Cisco-style" console cable (rollover) to USB serial. The common blue cables
  work.
- Settings: 115200 baud, 8 data bits, no parity, 1 stop bit, no flow control.
- After boot, OpenWrt shows *Please press Enter to activate this console*. Pressing Enter gives
  a root shell without a login, so physical access to the console is root access.
- Magic SysRq over the console works (send a serial BREAK, then `b` to reboot). That's a way back to U-Boot
  from a hung system. Stock EdgeOS disables it.
- The router's UART loses characters when a long line arrives in one burst. Paste long
  commands slowly, or in pieces.

## Kernel facts worth knowing

- `CONFIG_HZ=100`: offload timers are in 10 ms ticks. An idle flow leaves the fast path after
  16 s.
- OpenWrt's packet steering (`network.globals.packet_steering`) pins each port's receive
  processing to one CPU. On this driver that funnels all four cores' receive work onto one.
  The image turns it off, and you should leave it off.
- The crypto self-tests are on: a crypto driver that fails them is never used, and the generic
  software version takes over.
