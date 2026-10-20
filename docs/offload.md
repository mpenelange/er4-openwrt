# Hardware flow offload

The ER-4's four MIPS cores can't route a gigabit of small packets through the full Linux
network stack. The stock firmware handles this with a flow offload engine written by Cavium:
once a connection is established, its packets are forwarded straight from the Ethernet
driver's receive path, without going through the network stack, conntrack, netfilter or the
qdisc. This port brings that engine (`cavium-ip-offload`, from Ubiquiti's GPL source release) to
a 5.15 kernel and OpenWrt's firewall, and fixes what it found along the way.

"Hardware offload" is the stock firmware's name for it. The engine is software running on the
same cores, helped by the SoC: the hardware CRC unit for hashing, packets rewritten in place
in the receive buffer, and hardware checksums on transmit. What it saves is the per-packet
work of the regular path.

## How it works

```
first packets of a flow                         every later packet
───────────────────────                         ──────────────────
port → driver → [rx hook: no entry]             port → driver → [rx hook: entry found]
   → Linux: conntrack, fw4/nftables, NAT,              rewrite L2 header, NAT, TTL in place
     routing, neighbour lookup                          → transmit queue of the out port
   → [tx hook: learn the flow, as it leaves]
   → transmit
```

1. **Learn.** A packet without a cache entry goes through Linux normally. Netfilter, conntrack
   and NAT decide everything, as on any OpenWrt router. If the packet comes out the other side,
   the transmit hook records what Linux did to it: the outgoing Ethernet header (with VLAN
   tag), the post-NAT addresses and ports, the output port and the MTU. Only packets Linux
   didn't otherwise change can teach the cache.
2. **Forward.** Later packets of the same flow are looked up in a hash table at the top of
   the receive path. On a hit, the packet is rewritten in its receive buffer and handed
   straight to the output port's transmit queue.
3. **Stay correct.** Entries age out by timestamp: an idle flow leaves the cache after 16 s.
   Once a flow is older, a small random sample of its packets (about 1 in 32, rate-limited)
   takes the regular path again. That keeps conntrack's timers alive and lets routing changes
   take effect. Flows are learned in both directions, each with its own entry.

Each address family has its own cache: 8192 buckets by default, tunable up to 32768.

### What changed from the stock engine

The full change history is the patch series in [`patches/ipfwd/`](../patches/README.md); see also
[modules/ipfwd/README.md](../modules/ipfwd/README.md).

| Change | Why |
|---|---|
| Each entry records the **ingress port**, and a hit on any other port goes the regular way | Without it, a frame from the WAN carrying the tuple of a LAN flow was forwarded past the firewall. Measured on the rig: 200 of 200 forged frames before, 0 after |
| **Keyed hash** (`hsiphash`, random key per boot) instead of an unkeyed CRC | The bucket of any tuple was predictable, so an attacker could precompute tuples to evict a chosen flow from the cache |
| **RCU and a sequence count** around entries | The lockless reader could use flow data that the transmit path had just freed |
| **Invalidation on policy, route, address, link and neighbour changes** (below) | A new drop rule took about 11 s to stop an offloaded flow |
| **Conntrack TCP windows** re-learned per flow (as mainline's flowtable does), not `be_liberal` for all connections | Offloaded TCP behind a rejecting zone was reset after exactly 16 s |
| **Bounded transmit queue** in the driver (`octeon_ethernet.fwd_queue_depth`, default 128) | One fast flow into a slower port held receive buffers until every port dropped input |
| `/proc` writes bounded, flow dumps root-only, control paths serialised | Robustness fixes from the code audit ([security.md](security.md)) |
| Built without DPI | The classifier it hooks into is closed source |

## What is offloaded

| Traffic | Offloaded? |
|---|---|
| Routed IPv4 and IPv6 TCP and UDP, between any two ports | Yes |
| Masquerade (SNAT) and port forwards (DNAT) | Yes, both directions, rewrite done in the fast path |
| 802.1Q VLAN subinterfaces (inter-VLAN routing, VLANs on the WAN) | Yes (`vlan` option) |
| PPPoE | Supported by the engine, **off by default** (untested on this port) |
| Traffic to or from the router itself (DNS, DHCP, the UI, VPN endpoints) | No: not forwarded |
| Bridged traffic, and traffic routed out through a bridge | No: stays on the CPU |
| Traffic into or out of a VPN tunnel (WireGuard, IPsec) | No. For IPsec this was checked on the WAN: only ESP leaves the router, and no fast-path entries are made for tunnelled flows |
| GRE or VXLAN encapsulated traffic | The engine can handle it, but it isn't enabled or tested here |
| ICMP, ESP and other protocols, IPv4 with options, fragments | No |
| TCP SYN, FIN and RST packets | Always take the regular path, so conntrack sees connection setup and teardown |
| Packets with TTL / hop limit below 2 | Regular path (so the router can answer with ICMP) |
| DHCP (UDP 67/68) | Never cached |
| Flows with a conntrack helper (FTP, SIP, …) | Never cached |

The firewall doesn't need any configuration for this. A connection fw4 accepts is offloaded
from its next packets on. A connection fw4 refuses never gets an entry.

## What keeps a flow on the CPU

Some rules have to see every packet to work. When a packet passes through such a rule, the
kernel marks it, and the engine won't cache its flow. The marks are in kernel patch
`0003` ([building.md](building.md#kernel-oracle-uek7)):

| On the packet's way through Linux | Effect |
|---|---|
| nftables `limit`, `quota`, `log`, `connlimit`, `queue`, `numgen`, dynamic sets (`dynset`) | Flow stays on the CPU, so the rule keeps working |
| nftables `ct bytes` / `ct packets` / `ct avgpkt`, `meta time` / `day` / `hour` | Same (counters and time-based rules need every packet) |
| iptables equivalents (`limit`, `hashlimit`, `quota`, `connbytes`, `LOG`, `NFLOG`, `recent`, `statistic`, `string`, `time`, `u32`, `length`, `rateest`) | Same, if you use iptables-nft or legacy extensions |
| A qdisc other than `pfifo_fast`/`noqueue` on the output port (e.g. CAKE or SQM) | Flows leaving that port stay on the CPU, so shaping works |
| A tc action, a bridge, a macvlan | Same |

What this means in practice:

- **Scheduled rules** in the UI (time of day, days of the week) put the flows they match on the
  CPU. That is expected.
- **Rule hit counters** count only the packets that went through netfilter. For an offloaded
  flow that's the first packets and the samples. The UI's traffic graphs use interface
  counters, which see everything.
- **SQM/CAKE on the WAN** works, and takes WAN traffic off the fast path in that direction. At
  1 Gbit/s that cost 48% CPU against 15% offloaded ([performance.md](performance.md#qos-and-bufferbloat)).

## Invalidation: rule changes take effect at once

A cached flow mustn't outlive the decision that allowed it. The engine has a global stamp:
bumping it makes every entry look expired at its next lookup, so the next packet of every flow
takes the regular path and gets the current ruleset. This is O(1), and flows that are still
allowed are learned again straight away. The stamp is bumped:

| Event | Hook |
|---|---|
| Every nftables commit (fw4 reload, set changes) and iptables table replace | Kernel patch `0005` |
| Route changes (FIB notifier) | Module |
| IPv4/IPv6 address changes (WAN renumbering, prefix delegation) | Module |
| Link up/down, device changes | Module |
| A neighbour's MAC address actually changing (not ordinary ARP/NDP state churn) | Module |
| A write to `/proc/cavium/invalidate` | Manual (reading it returns the count so far) |

The bump happens twice: once immediately, and again after an RCU grace period. A packet that
passed the old ruleset and is still on its way to the transmit hook can't re-learn its flow
with the new stamp.

Measured: a drop rule added under an offloaded stream stops it within 0.5 s (the test's
resolution), against about 11 s before.

**One thing no hook reports: deleting conntrack entries.** fw4 accepts packets of established
connections before any other rule (standard OpenWrt behaviour, offload or not). So removing a
port forward or adding a block rule doesn't cut connections that are already open. To cut them
you delete their conntrack entries, and with offload you also invalidate:

```sh
conntrack -D -s 192.168.1.50          # for example
echo 1 > /proc/cavium/invalidate
```

Without the second step, the offloaded flow can continue for up to 16 s.

## IPv6

The IPv6 cache works the same way (hop limit instead of TTL, 128-bit addresses). It is on by
default since it passed the same tests as IPv4: rule invalidation, per-packet rule marks,
long-lived flows, forged-tuple replay. One addition was needed. IPv4 has the kernel's reverse
path filter, but IPv6 has nothing equivalent by default, and the replay test found a gap: a
frame from the WAN with a LAN host's source address and an offloaded flow's tuple was refused by
the fast path (wrong port), but conntrack is lenient about TCP windows for offloaded flows, so
the regular path let it through. The image now includes an nftables reverse-path check for IPv6
(`fib saddr . iif oif missing drop`, in `mangle_prerouting`). It drops packets whose source isn't
routed back out the port they came in on. Source-specific default routes (DHCPv6-PD, 6in4)
still match.

## Configuration and status

`/etc/config/offload` (also **System → Hardware offload** in the UI):

```
config offload 'global'
	option enabled '1'     # load the module at boot
	option ipv4 '1'
	option ipv6 '1'
	option vlan '1'        # 802.1Q subinterfaces
	option pppoe '0'       # untested
	option stats '1'       # hit/miss counters; about 3 points of CPU at 790 kpps of 64-byte packets
```

`/etc/init.d/offload restart` applies changes (it reloads the module, so the caches start
empty).

| File | What |
|---|---|
| `/proc/cavium/stats` | Fast-path hits and misses per family (the dashboard's hit rate) |
| `/proc/cavium/flows` | Live cache entries, IPv4 and IPv6, as text. **Diagnostics → Connections** uses it to mark which connections are offloaded |
| `/proc/cavium/invalidate` | Write: invalidate everything. Read: number of invalidations |
| `/proc/cavium/ipv4/`, `ipv6/` | Per-family switches (`fwd`, `vlan`, `pppoe`), `cache_size`, the raw cache dump |
| `/proc/cavium/ipv4/flows` | The stock firmware's binary per-flow traffic export (reading it resets the counters). Checked against a known transfer of 50,000 UDP datagrams: it counted every one (plus the test tool's handshake datagram) |

## Not supported

- **Bridge offload.** The stock firmware's bridge fast path is a separate closed module and
  was never released. Bridged ports are switched in software.
- **DPI / traffic analysis.** The engine has hooks for a closed classifier. They're compiled
  out.
- **Hardware QoS classes in the fast path.** Ubiquiti's build compiles output QoS out of the
  engine too, and the driver picks the transmit queue by CPU core. Use CAKE/SQM where you need
  queue management.
- **IPsec offload in the stock firmware's sense** (a separate Cavium module hooked into XFRM).
  The new AES/GHASH crypto drivers take the cipher work to the crypto unit through the
  standard kernel crypto API instead.
