# The web UI

The image has a web interface written for this router instead of
LuCI. It's a single-page app (Preact and TypeScript) served by uhttpd at `/`. It talks to the
router over the same ubus JSON-RPC API LuCI uses, plus a small rpcd plugin (`er4`) for things
OpenWrt has no API for: offload state, image management, live statistics, diagnostics. All
configuration is still plain UCI in `/etc/config`, so the command line and the UI can be used
side by side.

The UI is meant to be dense and direct: tables where there's a list, drag and drop where it
helps, relationships drawn as maps. It comes in a light and a dark theme.

## Changes are staged, reviewed and confirmed

Nothing a page does takes effect right away. Edits are staged, and the top bar counts them.
Before applying, you see the changes as a diff. After you apply, you have **60 seconds to
confirm**. If you don't (for example because the change cut off your own connection), the
router reverts to the previous configuration by itself. This is rpcd's apply/rollback, as in
LuCI.

Staged deletes can be undone until they're applied, so the UI doesn't interrupt you with "are
you sure?" dialogs.

## Pages

| Page | What's there |
|---|---|
| **Dashboard** | Ports and link state, WAN status, throughput per port (bit/s or packets/s, up to 24 h), CPU, memory and system facts |
| **Network** | A map of ports and networks: drag a port onto a network. A wizard for new networks (VLANs, DHCP client, PPPoE, unmanaged). WAN settings: DHCP, PPPoE, static, MAC clone, DHCP options. IPv6: DHCPv6/prefix delegation, prefix hints, RA and DHCPv6 modes, relay mode, a 6in4 tunnel for ISPs without IPv6. Static routes (IPv4 and IPv6), interface restart and renew. Bridged ports are marked, because the CPU switches them |
| **Devices** | One card per network: DHCP pool usage, leases (IPv4 and DHCPv6), one-click reservations, reservations for devices not yet seen |
| **DNS** | Local hostnames and aliases, per-domain forwarding, blocked and wildcard domains, upstream servers, rebind protection allowlist, query logging, and a diagram of the lookup path |
| **Firewall** | A zone map (who may talk to whom) plus a matrix. Rules written as sentences, grouped by direction, drag to reorder, with hit counters, schedules and MAC matches. Port forwards with NAT loopback. A NAT tab for SNAT, masquerade and no-NAT exceptions. Rules that keep traffic on the CPU are marked |
| **VPN** | WireGuard: several tunnels, add a device with keys generated in the browser and a QR code, import a `.conf`. IPsec/IKEv2 for phones and laptops (username and password, Apple profile) and site-to-site. Tailscale (log in, subnet routes, exit node, updates) |
| **Diagnostics** | Logs (kernel, system, saved on the eMMC), ping, traceroute, DNS lookup, packet capture to a `.pcap` download, routes and neighbours, connections (which ones are offloaded, and why the others aren't), WAN health history, processes, the loaded firewall ruleset |
| **System** | General settings and time zone, logging (RAM, eMMC, remote syslog), admin password, SSH (keys, listen interfaces, password login), services, scheduled tasks, hardware offload (switches, live fast-path share of forwarded packets), firmware (upload, install, boot previous), backup, restore, reboot, factory reset |

On a fresh install, the login page asks you to set a password first
([security.md](security.md)).

## Tailscale

The image doesn't carry Tailscale. **VPN → Set up Tailscale** downloads Tailscale's official
static Linux build (`mips64`, about 36 MB) from pkgs.tailscale.com, checks it against the
published SHA-256, and keeps it on the eMMC (`er4/tailscale` on p2), where it survives reboots
and image updates. Then it starts the service and opens Tailscale's login page.

From then on Tailscale updates itself with its own updater, which checks Tailscale's release
signature, replaces the binaries and restarts the service. You can switch that off with
**Update automatically**; **Update now** appears when a newer release is out. If the binaries
are ever missing on a router that was set up (a reformatted p2), the service downloads them
again at boot.

## Not included

- **No package manager page.** The system runs from RAM and only `/etc` is kept, so packages
  installed at runtime would disappear at reboot. Tools belong in the image.
- **No DDNS or UPnP.**
- **No LuCI.** For stock LuCI on the ER-4, use upstream OpenWrt's image (without the offload
  engine).

## Developing the UI

[ui/README.md](../ui/README.md) covers the development setup (`npm run dev` with an in-browser
mock router, so no router is needed) and the project's conventions.
