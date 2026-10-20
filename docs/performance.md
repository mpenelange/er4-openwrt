# Performance

All numbers on this page were measured on one ER-4 in a home lab. They show what this setup
does. They aren't a datasheet. Where a result has a known limitation, it says so.

## The test rig, and what it can't measure

- **Traffic source:** a Linux PC with two USB 3 gigabit NICs (ASIX AX88179 class), plus an
  EdgeSwitch 8 for VLAN trunks. Each side of the router is a network namespace on the PC.
- **Router CPU** comes from `/proc/stat` on the router over the test. "Forwarded" packet
  rates come from the router's own interface counters, not from iperf3. At small packet sizes
  the USB NICs drop part of what they receive, so iperf3's loss figures describe the PC, not the
  router.
- **The offload ceiling is unknown.** With offload on, the router forwarded everything this rig
  could generate (about 820 kpps of 64-byte packets). Gigabit line rate at 64 bytes is
  1.488 Mpps per direction. Finding the real limit needs a faster traffic generator (PCIe NICs).
- **Gigabit TCP tops out at about 940 Mbit/s** of payload on these links. So with full-size
  packets, offload shows up as lower CPU use, not more throughput.

"Without offload" means the same image with the offload module disabled. Everything then goes
through the normal Linux path: conntrack, nftables, routing.

## Routed forwarding

Two ports, one PC NIC on each, plain routing. OpenWrt 25.12.5 userland on the UEK7 kernel, the
firewall stopped. This was the kernel acceptance test: UEK7 had to be within 10% of the
earlier UEK6 port, and it was.

| Test | Without offload | With offload |
|---|---|---|
| TCP, 1 stream | 940 Mbit/s, CPU 26% | 940 Mbit/s, CPU 15% |
| UDP 1470 B (81 kpps) | 0% loss, CPU 25% | 0% loss, CPU 15% |
| UDP 512 B (216 kpps) | 27% lost, CPU 69% | **0% loss**, CPU 23% |
| UDP 64 B, 4 streams | 145 kpps forwarded, CPU 97% | **824 kpps forwarded, 0 dropped**, CPU 29% |

The flow cache counted about 12.1 million hits against 62 misses over the run.

On the final OpenWrt build, with the firewall running, the hardened kernel and the bounded
transmit queue:

| Test | With offload |
|---|---|
| TCP, 1 stream | 940 Mbit/s, CPU 16% |
| UDP 512 B | 216 kpps (line rate), 0% loss, CPU 25% |
| UDP 64 B, 4 streams | 806 kpps in = 806 kpps out, 0 receive drops, CPU 34% |

Later runs without offload and with OpenWrt's packet steering off (the image default; see
[hardware.md](hardware.md#kernel-facts-worth-knowing)) forwarded 331–343 kpps of 64-byte
packets at about 96% CPU, and 512-byte packets at line rate (216 kpps, one direction) at about
60% CPU.

Smaller costs, measured at 64 bytes:

| Feature | Cost |
|---|---|
| Kernel hardening (usercopy checks, fortify, freelist hardening) | about 2–3% of slow-path packet rate; fast path 812 kpps, 0 drops at 30–32% CPU vs 820 kpps at 27–29% before |
| Offload statistics counters (`stats`, on by default) | about 3 points of CPU at 760–790 kpps; well under 1 point at normal packet sizes |

## NAT and firewall with offload

Same two-port rig, fw4 running with lab zones.

| Test | Result |
|---|---|
| Masquerade, TCP both directions | 940 / 935 Mbit/s, offloaded, correct source rewrite |
| Port forward (DNAT), TCP both directions | 940 / 935 Mbit/s, offloaded; the inside host sees the real client address |
| Port forward, UDP 50 Mbit/s | 0% loss, offloaded |
| Inter-VLAN, allowed direction | 927 Mbit/s, offloaded |
| Inter-VLAN, blocked direction | refused by the firewall, 0 fast-path hits |
| New drop rule under an offloaded stream | stops within 0.5 s (about 11 s before the invalidation work) |
| `limit`, `quota`, `log` rules | enforced exactly (e.g. 1000 pps delivered of 4881 sent); those flows stay on the CPU |
| 120 s masqueraded UDP (longer than the UDP conntrack timeout) | 0% loss, NAT mapping stable |

## Through the WAN, IPv4 and IPv6

A production-like setup: one LAN host, the router, and a fake ISP on the WAN port giving out
DHCPv4, DHCPv6 addresses and a delegated /56. There's no real internet behind it, so these are
single-hop numbers.

| Test | Without IPv6 offload | With IPv6 offload |
|---|---|---|
| TCP LAN → internet, 1 stream | 928 Mbit/s, CPU 55% | 928 Mbit/s, **CPU 16%** |
| TCP internet → LAN | 927 Mbit/s, CPU 52% | 928 Mbit/s, CPU 16% |
| TCP, 4 streams | | 928 Mbit/s, CPU 16% |
| With the IPv6 reverse-path rule added | | 923 / 924 Mbit/s, CPU 16% |

IPv4 through the WAN with NAT: 941 Mbit/s upload in the WAN soak below. The router's own
connection view showed the NAT'd flow as offloaded at 922 Mbit/s.

## Comparison with stock EdgeOS

Stock EdgeOS 2.0.9 on the same unit and rig, booted from its own kernel, same test: UDP at
4 × 200 Mbit/s in each direction for 25 minutes, with constant flow churn (new flows replacing
old ones, to stress the cache):

| | This port | Stock EdgeOS 2.0.9 |
|---|---|---|
| Throughput | 799 / 799 Mbit/s | 799 / 799 Mbit/s |
| Worst second | 778 Mbit/s | 738 Mbit/s |
| Receive drops over the run | +16 k | +250 k |

One open result goes the other way. With offload **off**, this port forwarded 334/334 Mbit/s
of bidirectional 512-byte UDP, against stock's 670/607. The likely difference is the
firewall: stock's factory configuration has no rules, while OpenWrt's fw4 ruleset was loaded.
That hasn't been confirmed yet. With offload on, both forward at line rate.

## VPN

| Test | Result |
|---|---|
| WireGuard, TCP 1 stream (client on one side, router terminates and forwards) | 556 Mbit/s, router CPU 85% |
| WireGuard, TCP 4 streams | 561 Mbit/s, CPU 86% |
| IPsec site-to-site, IKEv2 AES-GCM-256 (Octeon crypto drivers) | 376 Mbit/s, all 4 cores about 90% |
| IPsec site-to-site, ChaCha20-Poly1305 (software) | 317 Mbit/s, all 4 cores about 90% |
| IPsec road warrior (EAP-MSCHAPv2, LAN reachable) | 319 Mbit/s |
| Kernel crypto benchmark, `rfc4106(gcm(aes))` on the Octeon drivers | about 103 MB/s per core at 1420-byte packets |

VPN traffic is never offloaded, so it's the CPU's job. WireGuard is in the kernel. For
IPsec, the hardware AES and GHASH drivers make AES-GCM the faster choice, but at that point the
ESP/XFRM path itself is the limit, not the cipher. IPsec correctness: the crypto self-tests
pass, a Debian strongSwan/OpenSSL peer interoperates, and a capture on the WAN during a run
(860 k packets) showed only IKE and ESP, never inner addresses.

Tailscale runs WireGuard in userspace, and on this router that's far slower than the kernel's.
As an exit node (OpenWrt's 1.98.3 build, client on the LAN or on 5G) it gave 35-42 Mbit/s
download and was loss-limited, not CPU-limited: no core was saturated, but tailscaled dropped
packets going in and out of the tun device in bursts, and a 10x longer tun queue didn't help.
Tailscale's fast path on Linux relies on GRO/GSO batching (UDP GRO forwarding needs kernel 6.2+)
that this kernel and the Octeon Ethernet driver don't provide. For speed, use WireGuard: the
router's WireGuard with a 0.0.0.0/0 peer works as an exit node.

## QoS and bufferbloat

Router port eth3 forced to a 100 Mbit/s link, so its transmit queue is the bottleneck. Four bulk
TCP streams into it for 30 s, and two pings across the same port every 0.2 s, one marked DSCP EF.
Idle RTT is about 3 ms.

| Link | Mode | Bulk TCP | Router CPU | Ping RTT p50 / max (EF and unmarked alike) |
|---|---|---|---|---|
| 100M | offload, before the transmit-queue fix | 94.0 Mbit/s | 2% | 76 / 81 ms |
| 100M | offload, with the fix | 94.0 Mbit/s | 2% | **15 / 18 ms** |
| 100M | slow path | 93.1 Mbit/s | 5% | 79 / 119 ms |
| 100M | CAKE 95 Mbit diffserv4 | 90.7 Mbit/s | 5% | **2.9 / 4.4 ms** |
| 1G | offload | 941 Mbit/s | 15% | 4.8 / 5.7 ms |
| 1G | slow path | 941 Mbit/s | 35% | 5.0 / 6.5 ms |
| 1G | CAKE 1 Gbit | 941 Mbit/s | **48%** | 4.5 / 5.2 ms |

The fast path has no priority classes (see [offload.md](offload.md#not-supported)), so EF
pings fare no better than unmarked ones. If your bottleneck is the WAN uplink, CAKE/SQM on the
WAN is the tool. It costs CPU and takes that direction off the fast path, but at 1 Gbit/s one
way it still forwards line rate. LAN-to-LAN traffic stays offloaded. Not measured yet: CAKE in
both directions at once, and small packets through CAKE.

## Soak tests

| Run | Duration | Traffic per cycle | Result |
|---|---|---|---|
| Lab, earlier module | 9.5 h, 207 cycles | 60 s TCP between VLANs, 60 s UDP 50 Mbit/s with a firewall reload in the middle, 30 s reverse TCP | TCP 928 and 940–941 Mbit/s every cycle, UDP 0.000% loss every cycle, no reboot, 0 kernel warnings, memory flat (MemAvailable 896.9–903.5 MB) |
| Lab, all security fixes | 9.8 h, 204 cycles | same | TCP 925–931 / 940–941 Mbit/s, UDP 0% loss, 0 warnings, memory flat; 1.91 billion fast-path hits vs 22 k misses |
| WAN, current build | 2 h, 35 cycles | TCP v4 up, UDP v4 50 Mbit/s down with a firewall reload, TCP v6 both ways | TCP v4 941 Mbit/s, UDP 0.000% loss in all 35, TCP v6 920–928 Mbit/s, no reboot, 0 warnings, memory flat (843–850 MB), 8 DHCPv6-PD renewals with stable addresses |

Both lab runs were stopped early on purpose, to move on to a newer build. In the WAN run, one
cycle's IPv6 upload came in at 130 Mbit/s with nothing logged on the router; the next cycle
was back at 927. A 24-hour soak on the current build is still to do.
