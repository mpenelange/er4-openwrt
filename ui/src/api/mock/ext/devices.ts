// Mock endpoints for the Devices page (pages/devices).
//
// Router sources:
//   luci-rpc getDHCPLeases   luci-base (core mock; overridden here for scenarios + countdown)
//   luci-rpc getHostHints    luci-base: { "<mac>": { name?, ipaddrs?: [], ip6addrs?: [] } }
//   er4.neighbors            ER-4 plugin: er4.neighbors -> { neighbors: [{ ip, mac, dev,
//                            state }] }, the IPv4 neighbour table (`ip -4 neigh show`, netlink
//                            RTM_GETNEIGH) so the UI can tell which devices are online now.
//                            state is the kernel NUD state name (REACHABLE, STALE, DELAY,
//                            PROBE, FAILED, PERMANENT, NOARP). rpcd/luci-rpc have no equivalent.
//
// Scenarios (see ../scenario.ts): empty, many (60 devices), error (lease read fails),
// staged (a rename, a new reservation and a removed reservation are staged), loading.
import { UBUS_STATUS, UbusError } from '../../ubus'
import type { DhcpLease, UciSection } from '../../types'
import { leases as baseLeases } from '../data'
import { mockUci as st, objects, registerMock } from '../registry'
import { afterCore, never, netScenario as scenario } from '../scenario'

const sc = scenario()
const t0 = Date.now()

// deterministic pseudo-random so screenshots are stable
let seed = 7
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)]
const mac = () => Array.from({ length: 6 }, (_, i) => Math.floor(rnd() * 256) & (i === 0 ? 0xfe : 0xff)).map((b) => b.toString(16).padStart(2, '0')).join(':')

const NAMES = {
  lan: ['macbook-air', 'pixel-8', 'ipad', 'work-laptop', 'desktop', 'kindle', 'switch', 'ps5', 'apple-tv', 'sonos-office', 'sonos-living', 'printer', 'raspberrypi', 'homeassistant', 'steamdeck', 'watch', 'surface', 'chromecast', 'nuc', 'unifi-ap'],
  iot: ['hue-bridge', 'thermostat-up', 'esp-garage', 'esp-blinds', 'roomba', 'washer', 'dryer', 'fridge', 'airpurifier', 'plug-desk', 'plug-tv', 'smoke-hall', 'cam-front', 'cam-back', 'doorlock'],
  guest: ['android', 'iPhone', 'laptop'],
}

function generate(): { leases: DhcpLease[]; hosts: { name: string; mac: string; ip: string }[] } {
  const out: DhcpLease[] = []
  const hosts: { name: string; mac: string; ip: string }[] = []
  const used = new Set(baseLeases.map((l) => l.ipaddr))
  const add = (net: string, prefix: string, n: number, from: number, span: number) => {
    for (let i = 0; i < n; i++) {
      let ip: string
      do ip = `${prefix}.${from + Math.floor(rnd() * span)}`
      while (used.has(ip))
      used.add(ip)
      const base = pick(NAMES[net as keyof typeof NAMES])
      const hostname = rnd() < 0.15 ? undefined : `${base}${rnd() < 0.4 ? `-${Math.floor(rnd() * 9) + 1}` : ''}`
      const m = mac()
      if (net === 'lan' && rnd() < 0.15 && hostname) {
        let rip = `${prefix}.${10 + i}`
        while (used.has(rip)) rip = `${prefix}.${Number(rip.split('.')[3]) + 1}`
        used.add(rip)
        hosts.push({ name: hostname, mac: m, ip: rip })
        out.push({ hostname, ipaddr: rip, macaddr: m, expires: -1 })
      } else out.push({ hostname, ipaddr: ip, macaddr: m, expires: Math.floor(rnd() * 86000) + 300 })
    }
  }
  add('lan', '192.168.1', 32, 100, 150)
  add('iot', '192.168.30', 14, 100, 100)
  add('guest', '192.168.20', 5, 50, 200)
  return { leases: out, hosts }
}

const extra = sc === 'many' ? generate() : { leases: [], hosts: [] }
const allLeases = (): DhcpLease[] => (sc === 'empty' ? [] : [...baseLeases, ...extra.leases])

// Hints: lease hosts plus devices with a static IP set on the device itself (no DHCP)
const staticHints: Record<string, { name?: string; ipaddrs: string[] }> = sc === 'empty' ? {} : {
  '02:00:00:aa:bc:01': { name: 'switch-core', ipaddrs: ['192.168.1.2'] },
  '02:00:00:0f:31:77': { ipaddrs: ['192.168.1.9'] },
}

// Neighbour states per MAC: most leases are online; a few idle/offline
function neighbors() {
  const out: { ip: string; mac: string; dev: string; state: string }[] = []
  let i = 0
  const dev = (ip: string) => (ip.startsWith('192.168.30.') ? 'br-lan.30' : ip.startsWith('192.168.20.') ? 'br-lan.20' : 'br-lan')
  for (const l of allLeases()) {
    const k = i++ % 7
    if (k === 5) continue // offline: no entry
    out.push({ ip: l.ipaddr, mac: l.macaddr, dev: dev(l.ipaddr), state: k === 3 ? 'STALE' : k === 6 ? 'FAILED' : 'REACHABLE' })
  }
  for (const [m, h] of Object.entries(staticHints)) out.push({ ip: h.ipaddrs[0], mac: m, dev: 'br-lan', state: 'REACHABLE' })
  return out
}

registerMock('er4', {
  neighbors: () => {
    if (sc === 'loading') return never()
    return { neighbors: neighbors() }
  },
})

afterCore(() => {
  if (sc === 'empty') {
    for (const [k, s] of Object.entries(st.live.dhcp)) if (s['.type'] === 'host') delete st.live.dhcp[k]
  }
  for (const [i, h] of extra.hosts.entries()) {
    st.live.dhcp[`cfg7${i.toString(16)}fe2b`] = { '.anonymous': true, '.type': 'host', '.name': `cfg7${i.toString(16)}fe2b`, '.index': 100 + i, ...h } as UciSection
  }
  st.staged = JSON.parse(JSON.stringify(st.live))

  // registered after core so these replace its getDHCPLeases and example.ts's getHostHints
  registerMock('luci-rpc', {
    getDHCPLeases: async () => {
      if (sc === 'error') throw new UbusError('luci-rpc', 'getDHCPLeases', UBUS_STATUS.TIMEOUT)
      if (sc === 'loading') return never()
      const el = Math.floor((Date.now() - t0) / 1000)
      return {
        dhcp_leases: allLeases().map((l) => ({ ...l, expires: l.expires < 0 ? -1 : Math.max(0, l.expires - el) })),
        // odhcpd: DUID-LL/LLT leases carry the MAC, DUID-UUID (Windows, some phones) don't
        dhcp6_leases: sc === 'empty' ? [] : [
          { hostname: 'study-laptop', duid: '000100012c4e5a100200000c7e19', iaid: '0c7e19', macaddr: '02:00:00:0c:7e:19', ip6addr: '2001:db8:4a10:100::1a2', ip6addrs: ['2001:db8:4a10:100::1a2/128'], expires: Math.max(0, 41000 - el) },
          { hostname: 'nas', duid: '0003000102000012aa01', iaid: '1', macaddr: '02:00:00:12:aa:01', ip6addr: '2001:db8:4a10:100::20', ip6addrs: ['2001:db8:4a10:100::20/128'], expires: 0 },
          { hostname: 'DESKTOP-7Q2', duid: '000400017a3c9e2b6f0b4d1c8e5f2a6b9c0d', iaid: '2a6b9c0d', ip6addr: '2001:db8:4a10:100::7b3', ip6addrs: ['2001:db8:4a10:100::7b3/128', 'fd3c:6a1e:9b20::7b3/128'], expires: Math.max(0, 3200 - el) },
        ],
      }
    },
    getHostHints: () => {
      const out: Record<string, { name?: string; ipaddrs: string[]; ip6addrs: string[] }> = {}
      for (const l of allLeases()) out[l.macaddr] = { name: l.hostname, ipaddrs: [l.ipaddr], ip6addrs: [] }
      for (const [m, h] of Object.entries(staticHints)) out[m] = { ...h, ip6addrs: [] }
      return out
    },
  })

  if (sc === 'staged') {
    const u = objects.uci
    u.add({ config: 'dhcp', type: 'host', values: { name: 'living-room-tv', mac: '02:00:00:fe:22:9d', ip: '192.168.1.140' } })
    u.add({ config: 'dhcp', type: 'host', values: { name: 'iphone-sam', mac: '6a:91:2e:dd:04:5c' } })
    const gaming = Object.values(st.staged.dhcp).find((s) => s.name === 'gaming-pc')
    if (gaming) u.delete({ config: 'dhcp', section: gaming['.name'] })
    u.set({ config: 'dhcp', section: 'lan', values: { start: '120', limit: '100' } })
  }
})
