# Security

An edge router faces the internet directly, and this one adds a fast path that skips most of
the kernel's network stack. So the offload code was reviewed line by line, then the finished
image was attacked from the WAN side in the lab, and the problems both found were fixed and
tested again. This page describes the defaults that came out of that, what was tested and how,
and the risks that remain.

None of this replaces your own judgement. It's one person's lab, one unit and one set of
tests.

## Defaults

| Area | Default |
|---|---|
| First boot | Nothing can log in until a password is set. The web UI's login page offers to set one (at least 8 characters). This is the only thing it allows without a login, and only while root has no password. rpcd refuses an empty-password login (stock OpenWrt accepts any password while none is set) |
| SSH | Keys only on a fresh install (password and root-password login off). Add keys under System → SSH. A router that already had a password (an upgrade) keeps its SSH settings |
| Management from the WAN | TCP 22, 80 and 443 from the WAN zone are dropped **before any user rule**, so a rule that "opens" SSH or the UI to the internet has no effect. Port forwards aren't affected |
| DNS from the WAN | TCP/UDP 53 from the WAN dropped the same way: never an open resolver |
| Login attempts | uhttpd throttles failed logins per client address: 5 free attempts, then lockouts from 2 s growing to 60 s (about one guess per minute). A success or 15 quiet minutes resets the count |
| Firewall | OpenWrt's fw4 with a quieter WAN: input and forward **dropped** (no answer, so scans see nothing), no ping from the internet (IPv4 or IPv6), IGMP/MLD multicast off, and inbound IPsec isn't forwarded to the LAN. DHCP, DHCPv6 and the ICMPv6 that IPv6 needs stay allowed. LAN to WAN allowed, established traffic accepted. Applied on a fresh install, and on an update only to a firewall still at OpenWrt's stock WAN settings (`92-er4-firewall`) |
| IPv6 | Reverse-path filter (nftables `fib`) on all ports. Inbound connections from the internet refused unless a rule allows them |
| Connection tracking | Table size 65,536 (kernel default 7,680), unreplied UDP timeout 30 s |
| Kernel | Hardened usercopy, `FORTIFY_SOURCE`, SLAB freelist randomisation and hardening, list corruption checks; no `/proc/kcore`, no `/dev/mem`, debugfs can't be mounted |
| Offload `/proc` files | Flow dumps and cache controls readable and writable by root only |
| Web UI | Can't be framed by another page. Configuration restore accepts only files under `etc/`: no `..`, no hard links, nothing through a symlink |

Things to be aware of:

- **The web UI is plain HTTP** on the LAN, as LuCI is by default. The session token crosses the
  LAN in the clear. Manage the router from a network you trust.
- **The serial console is a root shell** without a login (OpenWrt's default). Physical access
  means full access.
- **The WAN guard covers the standard ports.** If you move SSH to another port and open that
  to the WAN yourself, it isn't caught.
- **Management over a VPN** (WireGuard, IPsec, Tailscale) is allowed. The services aren't bound
  to the LAN address, precisely so that VPN clients can reach them.

## What was tested

### Code audit of the offload path

A white-box review of the offload engine and of this project's kernel patches. The threat model
was an attacker on the ISP access segment (arbitrary frames), untrusted devices on the LAN and
guest networks, and local unprivileged processes. Every finding was first confirmed on the
hardware where possible, then fixed, then re-tested with the same test.

| Severity | Finding | Outcome |
|---|---|---|
| High | The flow cache didn't check which port a packet arrived on, so a forged frame matching a live flow's addresses was forwarded past the firewall | Fixed: entries record the ingress port. Forged frames forwarded: 200 of 200 before, 0 after |
| High | The lockless fast-path reader could use flow data the transmit path had just freed (use-after-free under churn) | Fixed (RCU, sequence count). Confirmed with an instrumented build that wedged within seconds without the fix and ran clean with it |
| Medium | Predictable flow hash: precomputed tuples could evict a chosen flow from the cache | Fixed: keyed `hsiphash` with a random per-boot key |
| Medium | One offloaded flow into a slower port could exhaust receive buffers on **all** ports (found during the QoS tests) | Fixed in the driver: transmit queue capped per queue. 90% loss on unrelated traffic before, 0% after |
| Medium | Conntrack's TCP window tracking is relaxed for offloaded flows | Accepted: this matches mainline Linux flow offload and is stricter than the stock firmware's global setting. Residual risk below |
| Low | Bounded `/proc` writes (a single 200 KB write could reset the chip), root-only flow dumps, a race in the flow export after a cache resize (could hard-lock a core), invalidation on neighbour MAC changes | Fixed |
| Low/Info | Kernel hardening options | Mostly applied (see Defaults); module signing and `init_on_free` left off, as low value or too costly on this CPU |

### Attack exercise from the WAN

A black-box exercise against the image as shipped, in a production-like configuration: DHCP
WAN, LAN plus guest and IoT VLANs, one port forward, offload on. The attacker controlled the
fake ISP: the WAN segment and "the internet" behind it.

| Stage | Result |
|---|---|
| WAN reconnaissance (full port scan, ICMP) | Only the forwarded port answers. No management ports visible |
| Replaying live flows' tuples from the WAN (also VLAN-tagged) | All refused by the fast path |
| Blind TCP injection (RST, SYN, data) into an offloaded 941 Mbit/s flow | Flow unaffected. Conntrack dropped every forged segment |
| Flow-cache pressure (targeted eviction, random sprays) | Targeted eviction impossible. Found conntrack exhaustion (below) |
| Malformed frames (fragments, VLAN/QinQ, PPPoE, GRE, length lies, ARP), also with the PPPoE/GRE offload options on | No crash, no stall, no kernel warnings |
| Floods at 4,000 pps (SYN, UDP, ICMP) | No measurable effect on throughput, latency or the console |
| DNS (rebinding, a 45 k queries/s blast from the LAN) | Rebind protection held, including reserved ranges. No effect |
| Hostile DHCP from the WAN segment | Malformed leases refused. A rogue server can redirect the router's upstream (inherent to DHCP; below) |
| Management plane, including a deliberately wrong "allow WAN" rule | Before the fixes: exposed, no login throttling, slowloris could block the UI. After: inert |
| Factory-fresh state | Before the fixes: root with any password from the LAN (the WAN stayed closed). After: no login until a password is set |

The exercise found these, all fixed in the image and verified with the same scripts on the
hardware:

| Finding | Fix | Verified |
|---|---|---|
| A UDP spray through one forwarded port filled the 7,680-entry connection table and blocked all new LAN connections for minutes, without a log line | Table 65,536, shorter unreplied-UDP timeout | Same spray: the table levels off below the limit, 10 of 10 new connections succeed during it (0 of 15 before), drains in 22 s |
| Empty password on a factory-fresh router accepted any password on the LAN (UI and SSH) | Set-password-first flow, rpcd refuses empty-password logins, SSH keys-only on a fresh install | Real factory reset on the hardware: empty and wrong passwords refused on the UI and SSH |
| No login throttling (17 attempts/s sustained) | Per-address throttling in uhttpd | 6 attempts answered, then lockouts |
| A firewall mistake could expose SSH and the UI to the WAN, including uhttpd's connection slots | WAN guard ahead of all user rules (see Defaults) | With the mistake in place, all three ports stay filtered from the WAN |

The checks done later on the final image added two more fixes: the IPv6 reverse-path filter (a
forged LAN-source frame matching an offloaded flow got through the regular path), and DNS
refused from the WAN.

## Residual risks

These are known, measured, and accepted for now:

- **Established connections survive rule changes.** As on any fw4-based OpenWrt, a new block rule
  affects new connections only. To cut a live connection, delete its conntrack entry *and*
  invalidate the offload cache ([offload.md](offload.md#invalidation-rule-changes-take-effect-at-once)).
  The UI has no "block this host now" button that does both yet.
- **An attacker on the path who knows a live flow's addresses and ports can inject into it**
  through the regular path (conntrack accepts established traffic). That applies to Linux
  routers in general, not to the offload. The endpoints' own TCP checks and TLS are the
  protection. Masquerade keeps the client's source port, so an on-path observer has the tuple.
- **The ISP segment is trusted for DHCP and DNS.** A rogue DHCP server on the WAN segment can
  redirect the router's default route and resolver. Upstream DNS isn't validated (no DNSSEC or
  encrypted DNS by default).
- **Slowloris from the LAN.** uhttpd shares 100 connection slots, and a device on the LAN can
  hold them all. The WAN side is closed by the guard.
- **Blind injection into offloaded TCP** needs the full tuple and an in-window sequence number.
  At worst it drops a connection. It's no easier than with mainline Linux flow offload.

## Reporting a problem

If you find a security issue, please report it privately rather than in a public issue: use
the repository's private vulnerability reporting ("Report a vulnerability" on the Security
tab; see [SECURITY.md](../SECURITY.md)). Include the image's build ID (shown on
**System → Firmware**) and, if you can, the steps to reproduce. This is a hobby project, so
there's no formal response time, but reports are welcome and will be taken seriously.

For anything else, bugs and questions included, a normal issue is the right place.
