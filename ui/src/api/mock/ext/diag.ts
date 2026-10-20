// Diagnostics mocks (shapes as the er4 plugin's; see api/diag.ts):
//   er4.log {source, lines}   logd ring buffer (logread -t) or dmesg -r, newest last
//   er4.routes {}             `ip -j route show table all` for both families, `ip -j neigh`
//   er4.conntrack {limit}    conntrack -L: LAN devices to the internet (NATed), DNS, the VPN
//   er4.wan_health {window}  a day of er4-wanmon samples: steady RTTs, evening jitter, an outage
//                            at 03:12 for 6 minutes (ifdown/ifup wan), some loss to 1.1.1.1 only
//   er4.diag_start/poll/stop  ping, traceroute, nslookup; output appears line by line like
//                             busybox's. Hosts containing "nope" don't resolve; 10.9.9.9 never
//                             answers (100% loss, traceroute stars).
import { mockUci, registerMock } from '../registry'
import { mockNow } from '../scenario'

const UPTIME0 = 3 * 86400 + 4 * 3600 + 1234 // at page load
const t0 = Date.now()
const uptime = () => UPTIME0 + (Date.now() - t0) / 1000
const boot = () => Math.floor(mockNow() - uptime())

// ---- logs ---------------------------------------------------------------------------------
type Line = { time?: number; uptime?: number; facility?: string; level?: string | null; tag?: string | null; msg: string }

const KERNEL: [number, string, string][] = [
  [0.0, 'notice', 'Linux version 5.15.0-er4 (builder@buildhost) (mips64-openwrt-linux-musl-gcc 14.3.0) #1 SMP'],
  [0.0, 'info', 'CVMSEG size: 2 cache lines (256 bytes)'],
  [0.0, 'info', 'Cavium Inc. SDK-3.1'],
  [0.0, 'info', 'bootconsole [early0] enabled'],
  [0.0, 'info', 'CPU0 revision is: 000d9602 (Cavium Octeon III)'],
  [0.0, 'info', 'Memory: 4005120K/4194304K available'],
  [0.112, 'info', 'smp: Brought up 1 node, 4 CPUs'],
  [1.204, 'info', 'mmc0: new high speed MMC card at address 0001'],
  [1.231, 'info', 'mmcblk0: mmc0:0001 8GTF4R 7.28 GiB'],
  [1.240, 'info', ' mmcblk0: p1 p2'],
  [2.871, 'info', 'octeon-ethernet 0.0: 4 ports (eth0..eth3)'],
  [2.902, 'warn', 'octeon-ethernet: SFP eth3: no module'],
  [3.410, 'info', 'cavium_ip_offload: flow table 65536 entries, hash 16 bits'],
  [5.882, 'info', 'init: Console is alive'],
  [6.120, 'info', 'kmodloader: done loading kernel modules from /etc/modules.d/*'],
  [9.402, 'info', 'eth0: Link is up - 1000/Full'],
  [9.450, 'info', 'eth1: Link is up - 1000/Full'],
  [9.511, 'info', 'br-lan: port 1(eth1) entered forwarding state'],
  [10.033, 'info', 'wireguard: WireGuard 1.0.0 loaded'],
  [86400 + 812.4, 'info', 'eth2: Link is down'],
  [86400 + 815.9, 'info', 'eth2: Link is up - 100/Full'],
  [2 * 86400 + 3990.2, 'err', 'octeon-ethernet eth0: rx error: frame check sequence (count 1)'],
  [UPTIME0 - 600, 'warn', 'nf_conntrack: nf_conntrack: table full, dropping packet'],
  [UPTIME0 - 590, 'info', 'cavium_ip_offload: invalidated 1834 flows (ruleset change)'],
]

function kernelLog(n: number): Line[] {
  return KERNEL.slice(-n).map(([u, level, msg]) => ({ uptime: u, level, msg }))
}

const DEVICES = [
  ['192.168.1.117', '02:00:00:0c:7e:19', 'study-laptop'],
  ['192.168.1.131', '6a:91:2e:dd:04:5c', 'iphone'],
  ['192.168.1.140', '02:00:00:fe:22:9d', 'living-room-tv'],
  ['192.168.30.101', '02:00:00:5a:61:07', 'thermostat'],
]

function systemLog(n: number): Line[] {
  const now = mockNow()
  const b = now - uptime()
  const out: Line[] = []
  const add = (t: number, facility: string, level: string, tag: string, msg: string) => out.push({ time: Math.round(t * 1000) / 1000, facility, level, tag, msg })
  // boot
  add(b + 5.9, 'user', 'notice', 'kernel', 'procd: - init -')
  add(b + 6.4, 'daemon', 'info', 'procd', '- ubus -')
  add(b + 7.1, 'daemon', 'notice', 'netifd', 'Interface \'lan\' is enabled')
  add(b + 7.2, 'daemon', 'notice', 'netifd', 'Interface \'wan\' is enabled')
  add(b + 9.6, 'daemon', 'notice', 'netifd', 'Network device \'eth0\' link is up')
  add(b + 9.7, 'daemon', 'notice', 'netifd', 'Interface \'lan\' is now up')
  add(b + 10.1, 'daemon', 'notice', 'netifd', 'Interface \'wg0\' is now up')
  add(b + 11.3, 'daemon', 'notice', 'netifd', 'wan (1702): udhcpc: sending discover')
  add(b + 12.0, 'daemon', 'notice', 'netifd', 'wan (1702): udhcpc: lease of 203.0.113.57 obtained from 203.0.113.1, lease time 86400')
  add(b + 12.1, 'daemon', 'notice', 'netifd', 'Interface \'wan\' is now up')
  add(b + 12.5, 'daemon', 'info', 'dnsmasq[2011]', 'started, version 2.91 cachesize 1000')
  add(b + 12.6, 'daemon', 'info', 'dnsmasq[2011]', 'using nameserver 203.0.113.2#53')
  add(b + 12.6, 'daemon', 'info', 'dnsmasq[2011]', 'using nameserver 10.8.0.1#53 for domain corp.example')
  add(b + 13.0, 'daemon', 'info', 'dropbear[2104]', 'Not backgrounding')
  add(b + 15.2, 'daemon', 'warn', 'sysntpd', 'ntpd: no valid servers yet, retrying')
  add(b + 21.8, 'daemon', 'notice', 'sysntpd', 'ntpd: clock stepped by 1.213 s')
  add(b + 22.0, 'user', 'notice', 'firewall', 'Reloading firewall due to ifup of wan (eth0)')
  // steady state: DHCP renewals, the odd login, a WAN renew, a ruleset reload
  let t = b + 600
  let i = 0
  while (t < now - 30) {
    const [ip, mac, name] = DEVICES[i % DEVICES.length]
    const dev = ip.startsWith('192.168.30.') ? 'br-lan.30' : 'br-lan'
    add(t, 'daemon', 'info', 'dnsmasq-dhcp[2011]', `DHCPREQUEST(${dev}) ${ip} ${mac}`)
    add(t + 0.002, 'daemon', 'info', 'dnsmasq-dhcp[2011]', `DHCPACK(${dev}) ${ip} ${mac} ${name}`)
    if (i % 9 === 4) add(t + 40, 'authpriv', 'info', 'dropbear[8812]', 'Password auth succeeded for \'root\' from 192.168.1.117:51234')
    if (i % 13 === 7) add(t + 120, 'daemon', 'notice', 'netifd', 'wan (1702): udhcpc: lease of 203.0.113.57 obtained from 203.0.113.1, lease time 86400')
    if (i % 17 === 11) add(t + 300, 'daemon', 'err', 'odhcpd[1650]', 'Failed to send to ff02::1%br-lan.30@br-lan.30 (Address not available)')
    t += 2300 + (i % 5) * 400
    i++
  }
  add(now - 600, 'kern', 'warn', 'kernel', '[273034.120] nf_conntrack: nf_conntrack: table full, dropping packet')
  add(now - 25, 'authpriv', 'info', 'rpcd', 'login: root from 192.168.1.117')
  add(now - 3, 'daemon', 'info', 'dnsmasq[2011]', 'query[A] connectivity-check.ubuntu.com from 192.168.1.117')
  return out.slice(-n)
}

// ---- routes -------------------------------------------------------------------------------
function routes() {
  const ipv4 = [
    { dst: 'default', gateway: '203.0.113.1', dev: 'eth0', protocol: 'static', flags: [] },
    { dst: '10.200.0.0/24', dev: 'wg0', protocol: 'kernel', scope: 'link', prefsrc: '10.200.0.1', flags: [] },
    { dst: '10.200.0.2', dev: 'wg0', protocol: 'static', scope: 'link', flags: [] },
    { dst: '10.200.0.3', dev: 'wg0', protocol: 'static', scope: 'link', flags: [] },
    { dst: '192.168.1.0/24', dev: 'br-lan', protocol: 'kernel', scope: 'link', prefsrc: '192.168.1.1', flags: [] },
    { dst: '192.168.20.0/24', dev: 'br-lan.20', protocol: 'kernel', scope: 'link', prefsrc: '192.168.20.1', flags: ['linkdown'] },
    { dst: '192.168.30.0/24', dev: 'br-lan.30', protocol: 'kernel', scope: 'link', prefsrc: '192.168.30.1', flags: [] },
    { dst: '203.0.113.0/24', dev: 'eth0', protocol: 'kernel', scope: 'link', prefsrc: '203.0.113.57', flags: [] },
    { type: 'local', dst: '127.0.0.0/8', dev: 'lo', table: 'local', protocol: 'kernel', scope: 'host', prefsrc: '127.0.0.1', flags: [] },
    { type: 'local', dst: '127.0.0.1', dev: 'lo', table: 'local', protocol: 'kernel', scope: 'host', prefsrc: '127.0.0.1', flags: [] },
    { type: 'broadcast', dst: '192.168.1.255', dev: 'br-lan', table: 'local', protocol: 'kernel', scope: 'link', prefsrc: '192.168.1.1', flags: [] },
    { type: 'local', dst: '192.168.1.1', dev: 'br-lan', table: 'local', protocol: 'kernel', scope: 'host', prefsrc: '192.168.1.1', flags: [] },
    { type: 'local', dst: '203.0.113.57', dev: 'eth0', table: 'local', protocol: 'kernel', scope: 'host', prefsrc: '203.0.113.57', flags: [] },
  ]
  const ipv6 = [
    { dst: 'default', gateway: 'fe80::1', dev: 'eth0', protocol: 'static', metric: 512, flags: [], pref: 'medium' },
    { dst: '2001:db8:4a10:100::/64', dev: 'br-lan', protocol: 'static', metric: 1024, flags: [], pref: 'medium' },
    { dst: '2001:db8:4a10:130::/64', dev: 'br-lan.30', protocol: 'static', metric: 1024, flags: [], pref: 'medium' },
    { type: 'unreachable', dst: '2001:db8:4a10:100::/56', dev: 'lo', protocol: 'static', metric: 2147483647, flags: [], pref: 'medium' },
    { dst: 'fd3c:6a1e:9b20::/64', dev: 'br-lan', protocol: 'static', metric: 1024, flags: [], pref: 'medium' },
    { type: 'unreachable', dst: 'fd3c:6a1e:9b20::/48', dev: 'lo', protocol: 'static', metric: 2147483647, flags: [], pref: 'medium' },
    { dst: 'fe80::/64', dev: 'eth0', protocol: 'kernel', metric: 256, flags: [], pref: 'medium' },
    { dst: 'fe80::/64', dev: 'br-lan', protocol: 'kernel', metric: 256, flags: [], pref: 'medium' },
    { type: 'local', dst: '2001:db8:4a10:100::1', dev: 'br-lan', table: 'local', protocol: 'kernel', metric: 0, flags: [], pref: 'medium' },
    { type: 'multicast', dst: 'ff00::/8', dev: 'br-lan', table: 'local', protocol: 'kernel', metric: 256, flags: [], pref: 'medium' },
  ]
  const neigh = [
    { dst: '203.0.113.1', dev: 'eth0', lladdr: '00:00:5e:00:01:07', state: ['REACHABLE'] },
    ...DEVICES.map(([ip, mac], k) => ({ dst: ip, dev: ip.startsWith('192.168.30.') ? 'br-lan.30' : 'br-lan', lladdr: mac, state: [k === 2 ? 'STALE' : 'REACHABLE'] })),
    { dst: '192.168.1.152', dev: 'br-lan', state: ['FAILED'] },
    { dst: 'fe80::1', dev: 'eth0', lladdr: '00:00:5e:00:01:07', router: null, state: ['REACHABLE'] },
    { dst: '2001:db8:4a10:100:0:ff:fe0c:7e19', dev: 'br-lan', lladdr: '02:00:00:0c:7e:19', state: ['REACHABLE'] },
    { dst: 'fe80::682e:ddff:fe04:5c', dev: 'br-lan', lladdr: '6a:91:2e:dd:04:5c', state: ['STALE'] },
  ]
  return { ipv4, ipv6, neigh }
}

// ---- connections ----------------------------------------------------------------------------
const WAN = '203.0.113.57'
function conntrack({ limit }: { limit?: unknown }) {
  const flows: object[] = []
  // big established flows are in the offload flow cache (both directions); small or idle ones aren't
  const lan = (ip: string) => (ip.startsWith('192.168.30.') ? 'eth1.30' : 'eth1')
  const both = (ip: string, age: number) => ({ orig: { in: lan(ip), out: 'eth0', age }, reply: { in: 'eth0', out: lan(ip), age: age - 40 } })
  const tcp = (src: string, sport: number, dst: string, dport: number, state: string, timeout: number, kb: number) => flows.push({
    family: 4, proto: 'tcp', state, timeout, src, dst, sport, dport, reply_src: dst, reply_dst: WAN, reply_sport: dport, reply_dport: sport,
    bytes: kb * 90, packets: kb, reply_bytes: kb * 1400, reply_packets: kb, flags: ['ASSURED'],
    ...(state === 'ESTABLISHED' && kb >= 90 ? { offload: both(src, 900 + (kb % 7000)) } : {}),
  })
  const udp = (src: string, sport: number, dst: string, dport: number, timeout: number, replied = true) => flows.push({
    family: 4, proto: 'udp', timeout, src, dst, sport, dport, reply_src: dst, reply_dst: dst.startsWith('192.168.') ? src : WAN, reply_sport: dport, reply_dport: sport,
    bytes: 120, packets: 1, reply_bytes: replied ? 480 : 0, reply_packets: replied ? 1 : 0, flags: replied ? [] : ['UNREPLIED'],
  })
  tcp('192.168.1.117', 51234, '93.184.215.14', 443, 'ESTABLISHED', 431990, 812)
  tcp('192.168.1.117', 51240, '140.82.112.4', 443, 'ESTABLISHED', 431200, 95)
  tcp('192.168.1.117', 49822, '17.253.144.10', 443, 'TIME_WAIT', 84, 3)
  tcp('192.168.1.140', 40110, '198.38.96.10', 443, 'ESTABLISHED', 431999, 48211)
  tcp('192.168.1.131', 60001, '17.57.146.20', 5223, 'ESTABLISHED', 430800, 12)
  tcp('192.168.1.42', 27015, '198.51.100.77', 52113, 'ESTABLISHED', 431000, 2100)
  tcp('192.168.30.101', 39000, '52.94.233.1', 443, 'SYN_SENT', 98, 1)
  udp('192.168.1.131', 40000, '1.1.1.1', 53, 25, false)
  udp('192.168.1.42', 3074, '198.51.100.90', 3074, 170)
  Object.assign(flows[flows.length - 1], { offload: both('192.168.1.42', 2300) })
  udp('192.168.1.117', 123, '162.159.200.1', 123, 12)
  for (let i = 0; i < 6; i++) udp(`192.168.1.${[117, 131, 140, 42, 152, 20][i]}`, 50000 + i * 7, '192.168.1.1', 53, 20 + i)
  flows.push({ family: 4, proto: 'icmp', timeout: 29, src: '192.168.1.117', dst: '8.8.8.8', reply_src: '8.8.8.8', reply_dst: WAN, flags: [] })
  flows.push({ family: 4, proto: 'udp', timeout: 179, src: '198.51.100.200', dst: WAN, sport: 41000, dport: 51820, reply_src: WAN, reply_dst: '198.51.100.200', reply_sport: 51820, reply_dport: 41000, bytes: 88000, packets: 410, reply_bytes: 120000, reply_packets: 395, flags: ['ASSURED'] })
  flows.push({ family: 4, proto: 'tcp', state: 'ESTABLISHED', timeout: 7440, src: '192.168.1.117', dst: '192.168.1.1', sport: 52000, dport: 443, reply_src: '192.168.1.1', reply_dst: '192.168.1.117', reply_sport: 443, reply_dport: 52000, bytes: 41000, packets: 300, reply_bytes: 980000, reply_packets: 700, flags: ['ASSURED'] })
  flows.push({ family: 6, proto: 'tcp', state: 'ESTABLISHED', timeout: 431000, src: '2001:db8:4a10:100:0:ff:fe0c:7e19', dst: '2606:4700::6810:84e5', sport: 50100, dport: 443, reply_src: '2606:4700::6810:84e5', reply_dst: '2001:db8:4a10:100:0:ff:fe0c:7e19', reply_sport: 443, reply_dport: 50100, bytes: 9000, packets: 60, reply_bytes: 410000, reply_packets: 290, flags: ['ASSURED'],
    offload: { reply: { in: 'eth0', out: 'eth1', age: 3100 } } })
  const n = typeof limit === 'number' && limit > 0 ? limit : 2000
  return { count: flows.length, max: 65536, offload: { ipv4: true, ipv6: true }, flows: flows.slice(0, n) }
}

// ---- WAN health -------------------------------------------------------------------------------
function wanHealth({ window }: { window?: unknown }) {
  const win = typeof window === 'number' && window > 0 ? Math.min(window, 86400) : 3600
  const step = Math.max(10, Math.floor(win / 720 / 10) * 10 || 10)
  const now = Math.floor(mockNow())
  const day = new Date(now * 1000)
  day.setHours(3, 12, 0, 0)
  let outage = Math.floor(day.getTime() / 1000)
  if (outage > now - 600) outage -= 86400
  // a whole 6-minute outage inside the last 24 h: just after 03:12 that's 15:12 yesterday instead
  if (outage < now - 86400 + 600) outage += 12 * 3600
  const samples = []
  for (let t = Math.floor((now - win) / step) * step; t <= now - step; t += step) {
    const down = t >= outage && t < outage + 360
    const h = new Date(t * 1000).getHours()
    const busy = h >= 19 && h <= 23 ? 6 * Math.abs(Math.sin(t / 900)) : 0
    const flaky = Math.sin(t / 2700) > 0.97
    samples.push({
      t,
      gw_rtt: down ? null : +(1.1 + 0.3 * Math.abs(Math.sin(t / 311))).toFixed(2), gw_loss: down ? 1 : 0,
      inet_rtt: down ? null : +(10.8 + busy + Math.abs(Math.sin(t / 97))).toFixed(2), inet_loss: down ? 1 : flaky ? 0.25 : 0,
    })
  }
  const events = [{ t: outage + 4, action: 'ifdown', iface: 'wan' }, { t: outage + 352, action: 'ifup', iface: 'wan' }, { t: outage + 355, action: 'ifup', iface: 'wan6' }]
    .filter((e) => e.t >= now - win)
  return { step, target: '1.1.1.1', running: true, samples, events }
}

// ---- tools --------------------------------------------------------------------------------
const NAMES: Record<string, [string, string?]> = {
  'example.com': ['93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c'],
  'one.one.one.one': ['1.1.1.1', '2606:4700:4700::1111'],
  'nas.lan': ['192.168.1.20'], nas: ['192.168.1.20'],
  'gaming-pc.lan': ['192.168.1.42'], 'printer.lan': ['192.168.1.50'],
}
const isAddr = (h: string) => /^[\d.]+$/.test(h) || h.includes(':')
const resolve = (h: string, six: boolean): string | undefined => {
  if (isAddr(h)) return six === h.includes(':') ? h : undefined
  if (h.includes('nope')) return undefined
  const r = NAMES[h.toLowerCase()]
  if (r) return six ? r[1] : r[0]
  // anything else resolves to something plausible
  let x = 0
  for (const c of h) x = (x * 31 + c.charCodeAt(0)) >>> 0
  return six ? `2001:db8:ff::${(x & 0xffff).toString(16)}` : `198.51.100.${(x % 250) + 2}`
}
const local = (ip: string) => /^(192\.168\.|10\.200\.|127\.)/.test(ip)

interface Job { lines: [number, string][]; t0: number; code: number; stopped?: number }
const jobs = new Map<string, Job>()
let seq = 0

function script(a: { tool: string; host: string; family?: number; count?: number; server?: string }): { lines: [number, string][]; code: number } {
  const six = a.family === 6
  const h = a.host
  const ip = resolve(h, six)
  const L: [number, string][] = []
  if (a.tool === 'nslookup') {
    const server = a.server ?? '127.0.0.1'
    L.push([300, `Server:\t\t${server}\nAddress:\t${server}:53\n`])
    if (h.includes('nope')) {
      L.push([0, `** server can't find ${h}: NXDOMAIN\n`])
      return { lines: L, code: 1 }
    }
    const [v4, v6] = [resolve(h, false), resolve(h, true)]
    const auth = local(v4 ?? '') ? '' : 'Non-authoritative answer:\n'
    L.push([0, `\n${auth}Name:\t${h}\nAddress: ${v4}\n`])
    if (v6 && !local(v4 ?? '')) L.push([0, `\n${auth}Name:\t${h}\nAddress: ${v6}\n`])
    return { lines: L, code: 0 }
  }
  if (!ip) {
    L.push([400, `${six ? 'ping6' : a.tool === 'ping' ? 'ping' : 'traceroute'}: bad address '${h}'\n`])
    return { lines: L, code: 1 }
  }
  const dead = ip === '10.9.9.9'
  const base = local(ip) ? 0.4 : ip.startsWith('203.0.113.') ? 1.2 : 11
  if (a.tool === 'ping') {
    const n = a.count ?? 5
    L.push([150, `PING ${h} (${ip}): 56 data bytes\n`])
    const rtts: number[] = []
    for (let i = 0; i < n; i++) {
      const r = +(base + Math.random() * base * 0.25).toFixed(3)
      if (dead) { L.push([1000, '']); continue }
      rtts.push(r)
      L.push([i ? 1000 : 50, `64 bytes from ${ip}: seq=${i} ttl=${local(ip) ? 64 : 56} time=${r.toFixed(3)} ms\n`])
    }
    L.push([dead ? 2000 : 30, `\n--- ${h} ping statistics ---\n${n} packets transmitted, ${rtts.length} packets received, ${Math.round(100 - (rtts.length / n) * 100)}% packet loss\n`])
    if (rtts.length) {
      const avg = rtts.reduce((s, x) => s + x, 0) / rtts.length
      L.push([0, `round-trip min/avg/max = ${Math.min(...rtts).toFixed(3)}/${avg.toFixed(3)}/${Math.max(...rtts).toFixed(3)} ms\n`])
    }
    return { lines: L, code: rtts.length ? 0 : 1 }
  }
  // traceroute -n -q 1 -w 2 -m 20
  L.push([200, `traceroute${six ? '6' : ''} to ${h} (${ip}), 20 hops max, ${six ? 64 : 46} byte packets\n`])
  const path = local(ip) ? [ip] : six
    ? ['2001:db8:ffff::1', '2001:db8:1::5', '*', '2001:db8:2::9', ip]
    : ['203.0.113.1', '198.51.100.1', '*', '192.0.2.17', '192.0.2.45', ip]
  const hops = dead ? ['203.0.113.1', '198.51.100.1', ...Array(18).fill('*')] : path
  hops.forEach((hop, i) => {
    const ms = (base * (i + 1) / hops.length + Math.random()).toFixed(3)
    L.push([hop === '*' ? 2000 : 350, `${String(i + 1).padStart(2)}  ${hop === '*' ? '*' : `${hop}  ${ms} ms`}\n`])
  })
  return { lines: L, code: 0 }
}

registerMock('er4', {
  log: ({ source, lines }) => {
    const n = typeof lines === 'number' && lines > 0 ? Math.min(lines, 5000) : 500
    if (source === 'saved') {
      // the file the log service writes when System > Logging keeps it on the eMMC
      const sys = Object.values(mockUci.live.system ?? {}).find((x) => x['.type'] === 'system')
      if (!sys?.log_file) return { error: 'no log file configured' }
      return { source: 'saved', boot: boot(), lines: systemLog(n).map(({ time, ...l }) => ({ ...l, time: Math.floor(time! - 86400) })) }
    }
    return source === 'kernel'
      ? { source: 'kernel', boot: boot(), lines: kernelLog(n) }
      : { source: 'system', boot: boot(), lines: systemLog(n) }
  },
  routes,
  conntrack,
  wan_health: wanHealth,
  diag_start: (args) => {
    const a = args as { tool: string; host: string; family?: number; count?: number; server?: string }
    const ok = (h: unknown) => typeof h === 'string' && /^[A-Za-z0-9][A-Za-z0-9.:_-]{0,252}$/.test(h)
    if (!['ping', 'traceroute', 'nslookup'].includes(a.tool) || !ok(a.host) || (a.server != null && !ok(a.server))) return { error: 'bad arguments' }
    if ([...jobs.values()].filter((j) => !j.stopped && Date.now() - j.t0 < total(j)).length >= 3) return { error: 'too many tools running' }
    const id = (Math.floor(Date.now() / 1000).toString(16) + (seq++ % 4096).toString(16))
    jobs.set(id, { ...script(a), t0: Date.now() })
    return { id }
  },
  diag_poll: ({ id }) => {
    const j = jobs.get(String(id))
    if (!j) return { error: 'no such job' }
    const until = j.stopped ?? Date.now()
    let t = j.t0, output = ''
    for (const [dt, s] of j.lines) {
      t += dt
      if (t > until) break
      output += s
    }
    const done = j.stopped != null || until - j.t0 >= total(j)
    return { output, done, code: done ? (j.stopped != null && until - j.t0 < total(j) ? 143 : j.code) : null }
  },
  diag_stop: ({ id }) => {
    const j = jobs.get(String(id))
    if (j && j.stopped == null) j.stopped = Date.now()
    return {}
  },
})

function total(j: Job) {
  return j.lines.reduce((s, [dt]) => s + dt, 0)
}

// ---- processes and packet capture ---------------------------------------------------------------
const PROCS: [number, number, string, string, number, string][] = [
  [1, 0, 'root', 'S', 1840, '/sbin/procd'], [2, 0, 'root', 'S', 0, '[kthreadd]'], [12, 2, 'root', 'S', 0, '[ksoftirqd/0]'],
  [620, 1, 'root', 'S', 1320, '/sbin/ubusd'], [681, 1, 'root', 'S', 1100, '/sbin/logd -S 64'], [702, 1, 'root', 'S', 2950, '/sbin/rpcd -s /var/run/ubus/ubus.sock -t 30'],
  [890, 1, 'root', 'S', 2400, '/sbin/netifd'], [911, 1, 'root', 'S', 1500, '/usr/sbin/odhcpd'], [1043, 1, 'root', 'S', 980, '/usr/sbin/dropbear -F -P /var/run/dropbear.1.pid -p 22 -K 300 -T 3'],
  [1120, 1, 'root', 'S', 2100, '/usr/sbin/uhttpd -f -h /www -r er4 -x /cgi-bin -u /ubus -t 60 -T 30 -k 20 -A 1 -n 3 -N 100 -R -p 0.0.0.0:80'],
  [1201, 1, 'dnsmasq', 'S', 3300, '/usr/sbin/dnsmasq -C /var/etc/dnsmasq.conf.cfg01411c -k -x /var/run/dnsmasq/dnsmasq.cfg01411c.pid'],
  [1302, 1, 'root', 'S', 1200, '/usr/sbin/ntpd -n -N -S /usr/sbin/ntpd-hotplug -p 0.openwrt.pool.ntp.org'],
  [1410, 1, 'root', 'S', 900, '/bin/sh /usr/libexec/er4-wanmon'], [1532, 890, 'root', 'S', 700, 'udhcpc -p /var/run/udhcpc-eth0.pid -s /lib/netifd/dhcp.script -f -t 0 -i eth0'],
]
const killed = new Set<number>()
let capture: { t0: number; secs: number; stopped?: number } | undefined
registerMock('er4', {
  processes: () => ({
    processes: PROCS.filter(([pid]) => !killed.has(pid)).map(([pid, ppid, user, state, rss, command], i) => ({
      pid, ppid, user, state, rss, mem: (rss * 100) / 1001060, command,
      cpu: command.startsWith('[') ? 0 : +(((i * 37) % 11) * 0.31 + Math.random() * 0.2).toFixed(2),
    })),
  }),
  kill: ({ pid, signal }) => {
    if (typeof pid !== 'number' || pid <= 1 || !['HUP', 'TERM', 'KILL'].includes(String(signal))) return { error: 'bad arguments' }
    if (!PROCS.some(([p]) => p === pid) || killed.has(pid)) return { error: 'no such process' }
    if (signal !== 'HUP') killed.add(pid)
    return {}
  },
  capture_start: ({ iface, filter, seconds }) => {
    if (capture && !capture.stopped && Date.now() - capture.t0 < capture.secs * 1000) return { error: 'a capture is already running' }
    if (!/^[A-Za-z0-9._-]{1,15}$/.test(String(iface))) return { error: 'no such interface' }
    if (/^\s*-/.test(String(filter ?? '')) || !/^[A-Za-z0-9 .:/()!&|=<>[\]_-]*$/.test(String(filter ?? ''))) return { error: 'bad filter' }
    capture = { t0: Date.now(), secs: typeof seconds === 'number' ? seconds : 30 }
    return {}
  },
  capture_status: () => {
    if (!capture) return { running: false, size: 0, log: '' }
    const el = Math.min(capture.secs * 1000, (capture.stopped ?? Date.now()) - capture.t0)
    const running = !capture.stopped && el < capture.secs * 1000
    const pk = Math.round(el / 10)
    return { running, size: 24 + pk * 120, log: running ? 'tcpdump: listening on eth0, link-type EN10MB (Ethernet), snapshot length 262144 bytes' : `${pk} packets captured\n${pk} packets received by filter\n0 packets dropped by kernel` }
  },
  capture_stop: () => { if (capture) capture.stopped = Date.now(); return {} },
})
