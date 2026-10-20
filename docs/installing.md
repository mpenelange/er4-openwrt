# Installing, upgrading and recovering

Read this whole page before you install, and have a serial console cable ready. This port never
writes U-Boot or the SPI flash, so the router can always be brought back from the console. But
only if you can reach the console. [hardware.md](hardware.md) has the console details.

## How the router boots

The stock U-Boot does the same thing at every power-on: it loads the file `vmlinux.64` from the
first eMMC partition (FAT) and starts it, passing EdgeOS's kernel arguments. An image from this
project *is* such a file. The kernel and the whole OpenWrt system are in that one ELF. So:

- **Installing** an image means putting it on the boot partition as `vmlinux.64`.
- **The previous image** stays next to it as `vmlinux.64.prev`. Booting it again means
  swapping the two names.
- **The stock EdgeOS kernel** is kept as `vmlinux.64.edgeos`. EdgeOS's root filesystem on the
  second partition isn't touched at all, so going back to EdgeOS is a rename too.

There is no automatic fallback: stock U-Boot always boots `vmlinux.64`. If an image doesn't
come up, you fall back from the serial console (see [Recovery](#recovery)).

### What is kept where

| Location | Contents |
|---|---|
| eMMC p1 (FAT) `vmlinux.64` | The image that boots |
| eMMC p1 `vmlinux.64.prev` | The image that was running when the current one was installed |
| eMMC p1 `vmlinux.64.edgeos` | The stock EdgeOS kernel (set aside at first install; nothing manages it) |
| eMMC p1 `vmlinux.64o` | EdgeOS's own previous kernel, if it had one (left alone) |
| eMMC p2 (ext3/4) `er4/etc` | Your configuration: the persistent upper layer of `/etc` |
| eMMC p2 `er4/dhcp.leases` | A copy of the DHCP leases, so devices keep their addresses and local DNS names across a reboot |
| eMMC p2 `er4/tailscale` | Tailscale's binaries, once it's set up (downloaded, then updated by Tailscale itself) |
| eMMC p2, everything else | EdgeOS's root filesystem and its configuration, untouched |
| RAM | Everything else. The system runs from the image's initramfs |

Each `vmlinux.64*` has a `.md5` file next to it, the way EdgeOS does it.

The image mounts `/etc` from the eMMC only when it was booted from the eMMC (it recognises
EdgeOS's `rootsqimg=` boot argument). An image netbooted over TFTP runs entirely in RAM and
forgets everything at reboot, unless you add `rootsqimg=x` to its boot arguments.

## Before you start

- **A serial console cable** (RJ45 "Cisco" console to USB) and a terminal program, 115200 8N1.
- **A computer on the router's eth1** for the web UI. The router will be 192.168.1.1, and gives
  out addresses by DHCP.
- **The image** (`images/er4-openwrt-….bin`) and its `.sha256` file. See
  [building.md](building.md).
- For a netboot: a **TFTP server** on that computer.
- **A note of what's on your boot partition now.** This port was developed on a unit running
  EdgeOS 2.0.9-hotfix.7, with its U-Boot (`e300_003_6be37`). Other EdgeOS versions should
  look the same, but check the file names against the table above before you rename anything.

## First install

There are two ways to get the image onto the eMMC the first time. Both end in the same layout.

### Option A: netboot first, then install (recommended)

Boot the image over TFTP. Nothing is written to the router, and you can see the image working
on your hardware before you install it.

1. Put the image in your TFTP server's directory, e.g. as `er4.bin`.
2. Connect the console and power the router on. The stock U-Boot has no boot delay, so keep
   pressing a key (Enter or space) from the moment you apply power until you see the prompt
   `Octeon ubnt_e300(ram)#`.
3. Netboot. `octeth2` is the U-Boot name of front-panel **eth1** (see
   [hardware.md](hardware.md#port-names)). The addresses are examples. The router's address
   must be in your computer's subnet.

   ```
   setenv ethact octeth2
   setenv ipaddr 192.168.1.20
   setenv serverip 192.168.1.10
   tftpboot $(loadaddr) er4.bin
   bootoctlinux $(loadaddr) numcores=4 endbootargs mem=0 console=ttyS0,115200
   ```

   None of this is saved (no `saveenv`). The next power cycle boots EdgeOS as before.
4. When the console says *Please press Enter to activate this console*, press Enter for a
   root shell. Or open <http://192.168.1.1/> to look at the UI. In RAM mode it starts from
   defaults and asks for a password.
5. Copy the image onto the boot partition from that shell. Serve the image from your computer
   over HTTP (e.g. `python3 -m http.server 8000` in the image directory), then on the router:

   ```sh
   mkdir -p /mnt/p1 && mount -t vfat /dev/mmcblk0p1 /mnt/p1 && cd /mnt/p1
   ls -l                                  # expect EdgeOS's vmlinux.64 and vmlinux.64.md5
   df -k .                                # room for one more image (25-30 MB; ls -l images/)?
   mv vmlinux.64 vmlinux.64.edgeos
   mv vmlinux.64.md5 vmlinux.64.edgeos.md5
   wget -O vmlinux.64.new http://192.168.1.10:8000/er4-openwrt-<...>.bin
   sha256sum vmlinux.64.new               # must match the .sha256 file
   mv vmlinux.64.new vmlinux.64
   md5sum vmlinux.64 | cut -d' ' -f1 > vmlinux.64.md5
   cd / && sync && umount /mnt/p1 && reboot
   ```

   If `df` shows too little space, stop and put `vmlinux.64.edgeos` back as `vmlinux.64`
   before you reboot.

### Option B: from EdgeOS

The same copy, done from a running EdgeOS over SSH. Copy the image to the router's `/tmp`
with `scp`, log in, become root with `sudo -i`, and run step 5 above. The only difference is
that the image comes from `/tmp` instead of `wget`. If `mount | grep mmcblk0p1` shows that
EdgeOS already has the partition mounted, work in that directory instead of mounting it again.
Then `reboot`.

### First boot

The first boot from the eMMC creates `er4/etc` on the second partition and starts from
defaults:

| | Default |
|---|---|
| WAN | **eth0**, DHCP (IPv4) and DHCPv6 with prefix delegation |
| LAN | **eth1**, 192.168.1.1/24, DHCP server, IPv6 from the delegated prefix |
| eth2, eth3 (SFP) | unassigned; add them to networks in the UI |
| Offload | on for IPv4, IPv6 and VLANs |
| Web UI | <http://192.168.1.1/>, from the LAN only |
| SSH | keys only; no keys yet |

Open the UI. It asks you to **set a password** first (at least 8 characters). Until you do,
nothing logs in, not even with an empty password. Then add your SSH public key under
**System → SSH** if you want shell access over the network.

## Upgrades

Use **System → Firmware** in the web UI:

1. **Upload** the new `.bin`. The router checks it: a MIPS64 big-endian ELF, built for
   `ubnt,edgerouter-4`, and small enough for the boot partition. It also shows the SHA-256.
   Compare it with the `.sha256` file that came with the image (images aren't signed).
2. **Install.** The running image is copied to `vmlinux.64.prev`, the new one is written as
   `vmlinux.64.new`, its checksum is verified, and only then is it renamed to `vmlinux.64`. If
   anything fails along the way, the running image is untouched. Your configuration in
   `/etc` is kept as it is.
3. **Reboot** into the new image. The page shows which build is running, which one boots next,
   and which one is the previous.

Each install replaces the previous slot with the image you were running. Two installs in a row
mean the image before both of them is gone. `vmlinux.64.edgeos` is never touched.

Don't use `sysupgrade`. On this target it still
uses upstream OpenWrt's layout and would write over EdgeOS's partitions.

## Rollback

- **From the UI:** System → Firmware → *Boot previous* swaps `vmlinux.64` and
  `vmlinux.64.prev` and reboots. Do it again to swap back.
- **From a shell** on the router: mount p1 and swap the two files (and their `.md5` files) by
  hand, as above.
- **From U-Boot**, once, without changing anything: run `printenv bootcmd`, then type the same
  two commands with the file name changed. On the development unit that was:

  ```
  fatload mmc 0 $(loadaddr) vmlinux.64.prev
  bootoctlinux $(loadaddr) numcores=4 endbootargs mem=0 root=/dev/mmcblk0p2 rootdelay=10 rw rootsqimg=squashfs.img rootsqwdir=w mtdparts=spi32766.0:3072k(boot0),1024k(dummy),64k(eeprom)
  ```

  Copy the arguments from your own unit's `bootcmd`, not from here.

### Back to EdgeOS

Rename `vmlinux.64.edgeos` and `vmlinux.64.edgeos.md5` back to `vmlinux.64` and
`vmlinux.64.md5`, after moving this project's `vmlinux.64` aside. You can do this from a shell on
either system. To boot EdgeOS just once, use the U-Boot command above with `vmlinux.64.edgeos`.
EdgeOS ignores the `er4/` directory on p2.

## Configuration backup and factory reset

- **Backup:** System → Backup & reboot downloads `/etc` as a `.tar.gz`. A restore accepts only
  files under `etc/` (no `..`, no hard links, nothing through a symlink), then reboots.
- **Factory reset:** System → Backup & reboot → *Factory reset* deletes `er4/etc` on p2 and
  reboots. The image's defaults come back. You set a password again, and SSH is keys-only
  again. The installed images aren't affected. From a shell, the same thing is:

  ```sh
  rm -rf /mnt/er4data/er4/etc /mnt/er4data/er4/.etc-work && sync && reboot -f
  ```

## Recovery

| Problem | What to do |
|---|---|
| A change cut you off | Wait. Every change made in the UI is applied with a 60-second confirm window. If you don't confirm (because you can't reach the router any more), it reverts by itself |
| Forgot the password | The serial console gives a root shell (OpenWrt's default, no login). Run `passwd`, or do a factory reset |
| New image doesn't boot, or boots but the network is broken | Console → U-Boot → boot `vmlinux.64.prev` once (above). From the shell that gives you, swap the files back for good |
| Nothing on the eMMC boots | Console → U-Boot → TFTP netboot a known-good image (Option A, step 3). Then repair p1 from its shell, or reinstall |
| Want EdgeOS back | [Back to EdgeOS](#back-to-edgeos) |

If the console shows nothing at all, check the cable (a console cable, not an Ethernet cable),
the speed (115200), and that you're on the port labelled *Console*.
