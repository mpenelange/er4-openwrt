// Network model for the Network and Devices pages: reads UCI network/dhcp/firewall into
// ports + logical networks, and stages the edits those pages make (port roles, new network,
// delete network). Everything here only stages (uci.set/add/remove); nothing is applied.
//
// VLAN model (ER-4, Cavium SDK ethernet, no DSA switch): VLANs are 802.1Q devices
// (`config device` type 8021q, ifname = a port or a bridge, vid) such as eth3.30 or br-lan.30.
// A VLAN on a bridge is carried tagged on every bridge member port. No bridge-vlan filtering.
import { uci } from './uci'
import type { UciConfig, UciSection, UciValue } from './types'

export const PORT_NAMES = ['eth0', 'eth1', 'eth2', 'eth3'] as const
export type PortName = (typeof PORT_NAMES)[number]
export const isPort = (s: string | undefined): s is PortName => !!s && (PORT_NAMES as readonly string[]).includes(s)

// ---- small helpers -------------------------------------------------------------------
export const str = (v: unknown): string | undefined => (Array.isArray(v) ? v[0] : typeof v === 'string' ? v : undefined)
export const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : typeof v === 'string' && v.trim() ? v.trim().split(/\s+/) : []

export function ipToInt(ip: string): number | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim())
  if (!m) return undefined
  const o = m.slice(1).map(Number)
  if (o.some((x) => x > 255)) return undefined
  return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3]
}
export const intToIp = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
export const maskOf = (prefix: number) => (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0)
export const prefixToNetmask = (p: number) => intToIp(maskOf(p))
export function netmaskToPrefix(m: string): number | undefined {
  const n = ipToInt(m)
  if (n === undefined) return undefined
  let p = 0
  while (p < 32 && n & (0x80000000 >>> p)) p++
  return maskOf(p) === n ? p : undefined
}

export interface Subnet { ip: string; prefix: number; network: number; broadcast: number; size: number }
export function subnet(ip: string, prefix: number): Subnet | undefined {
  const n = ipToInt(ip)
  if (n === undefined || prefix < 8 || prefix > 30) return undefined
  const network = (n & maskOf(prefix)) >>> 0
  const size = 2 ** (32 - prefix)
  return { ip, prefix, network, broadcast: network + size - 1, size }
}
export const inSubnet = (s: Subnet, ip: string) => {
  const n = ipToInt(ip)
  return n !== undefined && n > s.network && n < s.broadcast
}
export const cidr = (s: Subnet) => `${intToIp(s.network)}/${s.prefix}`

// ---- model ---------------------------------------------------------------------------
export type Where =
  | { kind: 'bridge'; bridge: string }
  | { kind: 'vlan'; parent: string; vid: number; device: string; section?: string }
  | { kind: 'port'; port: string }
  | { kind: 'virtual' } // wireguard, ppp... no L2 device of ours
  | { kind: 'none' } // no device assigned

export interface Net {
  name: string
  sec: UciSection
  proto: string
  device?: string
  where: Where
  ipaddr?: string
  prefix?: number
  subnet?: Subnet
  dhcp?: UciSection
  dhcpOn: boolean
  zone?: UciSection
  zoneName?: string
  wan: boolean
  slot: number
}

export interface Bridge { section: string; name: string; ports: string[] }
export interface Vlan { section?: string; name: string; parent: string; vid: number }

export interface PortRole {
  name: PortName
  untagged: { kind: 'bridge'; bridge: string; nets: Net[] } | { kind: 'net'; nets: Net[] } | null
  tagged: { vid: number; device: string; nets: Net[]; via?: string }[]
  role: 'wan' | 'lan' | 'net' | 'trunk' | 'unused'
  label: string
}

export interface NetModel {
  network: UciConfig
  dhcp: UciConfig
  firewall: UciConfig
  bridges: Bridge[]
  vlans: Vlan[]
  nets: Net[]
  ports: PortRole[]
  zones: UciSection[]
  wanZone: string
}

const byIndex = (a: UciSection, b: UciSection) => (a['.index'] ?? 0) - (b['.index'] ?? 0)
const ofType = (c: UciConfig, t: string) => Object.values(c).filter((s) => s['.type'] === t).sort(byIndex)

/** Colour slot per network (identity, never rank): lan 1, wan* 2, the others 3..8 in config
 *  order (creation order), so a network keeps its colour while others come and go after it. */
const OTHER_SLOTS = [3, 4, 5, 6, 7, 8]

export function buildModel(network: UciConfig, dhcp: UciConfig, firewall: UciConfig): NetModel {
  const devices = ofType(network, 'device')
  const bridges: Bridge[] = devices.filter((d) => d.type === 'bridge').map((d) => ({ section: d['.name'], name: str(d.name) ?? d['.name'], ports: list(d.ports) }))
  const vlans: Vlan[] = devices
    .filter((d) => d.type === '8021q' && str(d.ifname))
    .map((d) => {
      const parent = str(d.ifname)!
      const vid = Number(str(d.vid))
      return { section: d['.name'], name: str(d.name) ?? `${parent}.${vid}`, parent, vid }
    })
  const zones = ofType(firewall, 'zone')
  const wanZone = str(zones.find((z) => z.masq === '1')?.name) ?? 'wan'

  const whereOf = (device: string | undefined, proto: string): Where => {
    if (!device) return ['wireguard', 'ppp', 'pppoe', 'gre', 'vti', '6in4', '6rd', '6to4'].includes(proto) ? { kind: 'virtual' } : { kind: 'none' }
    const v = vlans.find((x) => x.name === device)
    if (v) return { kind: 'vlan', parent: v.parent, vid: v.vid, device, section: v.section }
    const m = /^(.+)\.(\d+)$/.exec(device) // netifd creates eth0.7-style VLAN devices on demand
    if (m) return { kind: 'vlan', parent: m[1], vid: Number(m[2]), device }
    if (bridges.some((b) => b.name === device)) return { kind: 'bridge', bridge: device }
    return { kind: 'port', port: device }
  }

  let other = 0
  const nets: Net[] = ofType(network, 'interface')
    .filter((s) => s['.name'] !== 'loopback')
    .map((sec) => {
      const name = sec['.name']
      const proto = str(sec.proto) ?? 'none'
      const device = str(sec.device)
      let ipaddr = str(sec.ipaddr)
      let prefix: number | undefined
      if (ipaddr?.includes('/')) {
        const [a, p] = ipaddr.split('/')
        ipaddr = a
        prefix = Number(p)
      } else if (ipaddr) prefix = netmaskToPrefix(str(sec.netmask) ?? '255.255.255.0') ?? 24
      if (!ipaddr && proto === 'wireguard') {
        const a = list(sec.addresses)[0]
        if (a) [ipaddr, prefix] = [a.split('/')[0], Number(a.split('/')[1] ?? 32)]
      }
      const d = ofType(dhcp, 'dhcp').find((x) => x.interface === name)
      const zone = zones.find((z) => list(z.network).includes(name))
      const zoneName = str(zone?.name)
      return {
        name, sec, proto, device, where: whereOf(device, proto), ipaddr, prefix,
        subnet: ipaddr && prefix !== undefined ? subnet(ipaddr, prefix) : undefined,
        dhcp: d, dhcpOn: !!d && d.ignore !== '1' && proto === 'static',
        zone, zoneName, wan: zoneName === wanZone || name.startsWith('wan'),
        slot: name === 'lan' ? 1 : name.startsWith('wan') ? 2 : OTHER_SLOTS[other++ % OTHER_SLOTS.length],
      }
    })

  const ports: PortRole[] = PORT_NAMES.map((p) => {
    const bridge = bridges.find((b) => b.ports.includes(p))
    const direct = nets.filter((n) => n.where.kind === 'port' && n.where.port === p)
    const untagged: PortRole['untagged'] = bridge
      ? { kind: 'bridge', bridge: bridge.name, nets: nets.filter((n) => n.where.kind === 'bridge' && n.where.bridge === bridge.name) }
      : direct.length ? { kind: 'net', nets: direct } : null
    const vlanNets = (parent: string) => {
      const out = new Map<number, { vid: number; device: string; nets: Net[] }>()
      for (const v of vlans.filter((x) => x.parent === parent)) out.set(v.vid, { vid: v.vid, device: v.name, nets: [] })
      for (const n of nets) if (n.where.kind === 'vlan' && n.where.parent === parent) {
        const e = out.get(n.where.vid) ?? { vid: n.where.vid, device: n.where.device, nets: [] }
        e.nets.push(n)
        out.set(n.where.vid, e)
      }
      return [...out.values()]
    }
    const tagged = [...vlanNets(p), ...(bridge ? vlanNets(bridge.name).map((t) => ({ ...t, via: bridge.name })) : [])].sort((a, b) => a.vid - b.vid)
    let role: PortRole['role'] = 'unused'
    let label = 'Unused'
    if (untagged?.kind === 'net' && untagged.nets.some((n) => n.wan)) [role, label] = ['wan', 'WAN']
    else if (untagged?.kind === 'bridge') [role, label] = ['lan', untagged.nets[0]?.name === 'lan' || !untagged.nets.length ? 'LAN' : untagged.nets[0].name]
    else if (untagged?.kind === 'net') [role, label] = ['net', untagged.nets[0].name]
    else if (tagged.length) [role, label] = ['trunk', 'Trunk']
    return { name: p, untagged, tagged, role, label }
  })

  return { network, dhcp, firewall, bridges, vlans, nets, ports, zones, wanZone }
}

export async function loadModel(): Promise<NetModel> {
  const [n, d, f] = await Promise.all([uci.get('network'), uci.get('dhcp'), uci.get('firewall')])
  return buildModel(n, d, f)
}

// ---- suggestions ---------------------------------------------------------------------
export const NAME_RE = /^[a-z][a-z0-9_]{0,10}$/ // fw4 zone names are limited to 11 chars

export function usedThirdOctets(m: NetModel): Set<number> {
  const s = new Set<number>()
  for (const n of m.nets) if (n.ipaddr?.startsWith('192.168.')) s.add(Number(n.ipaddr.split('.')[2]))
  return s
}

/** A free 192.168.X.0/24: X = the VLAN id when free, else the first free multiple of 10, else any. */
export function suggestSubnet(m: NetModel, vid?: number): string {
  const used = usedThirdOctets(m)
  const cands = [vid ?? -1, ...Array.from({ length: 25 }, (_, i) => (i + 1) * 10), ...Array.from({ length: 254 }, (_, i) => i + 1)]
  const x = cands.find((c) => c > 1 && c < 255 && !used.has(c)) ?? 254
  return `192.168.${x}.1`
}

export function usedVids(m: NetModel, parent: string): Set<number> {
  return new Set([...m.vlans.filter((v) => v.parent === parent).map((v) => v.vid), ...m.nets.flatMap((n) => (n.where.kind === 'vlan' && n.where.parent === parent ? [n.where.vid] : []))])
}

export function suggestVid(m: NetModel, parent: string): number {
  const used = usedVids(m, parent)
  for (let v = 10; v < 4095; v += 10) if (!used.has(v)) return v
  for (let v = 2; v < 4095; v++) if (!used.has(v)) return v
  return 4094
}

// ---- staging: ports --------------------------------------------------------------------
export type PortTarget = { kind: 'bridge'; bridge: string } | { kind: 'wan' } | { kind: 'net'; net: string } | { kind: 'none' }

/** Change what a port carries untagged. Tagged VLANs on the port are left as they are. */
export async function setPortUntagged(m: NetModel, port: PortName, target: PortTarget) {
  const cur = m.ports.find((p) => p.name === port)!
  // detach from the current role
  for (const b of m.bridges) {
    if (b.ports.includes(port) && !(target.kind === 'bridge' && target.bridge === b.name)) {
      await uci.set('network', b.section, { ports: b.ports.filter((x) => x !== port) })
    }
  }
  if (cur.untagged?.kind === 'net') {
    for (const n of cur.untagged.nets) {
      const keep = (target.kind === 'wan' && n.wan) || (target.kind === 'net' && target.net === n.name)
      if (!keep) await uci.remove('network', n.name, ['device'])
    }
  }
  // attach
  if (target.kind === 'bridge') {
    const b = m.bridges.find((x) => x.name === target.bridge)!
    if (!b.ports.includes(port)) await uci.set('network', b.section, { ports: [...b.ports, port] })
  } else if (target.kind === 'wan') {
    // every WAN-zone interface that sits directly on a port (or on none) moves to this one
    for (const n of m.nets.filter((x) => x.wan && (x.where.kind === 'port' || x.where.kind === 'none'))) {
      if (n.device !== port) await uci.set('network', n.name, { device: port })
    }
  } else if (target.kind === 'net') {
    await uci.set('network', target.net, { device: port })
  }
}

// ---- staging: new / delete network ---------------------------------------------------------
export type NewProto = 'static' | 'dhcp' | 'pppoe' | 'none'
export interface NewNetwork {
  name: string
  where: { kind: 'vlan'; parent: string; vid: number } | { kind: 'port'; port: PortName }
  /** static: this router serves it; dhcp/pppoe: an uplink (a second WAN); none: just the device */
  proto: NewProto
  pppoe?: { username: string; password: string }
  ipaddr: string
  prefix: number
  dhcp: { on: boolean; start: number; limit: number; leasetime: string }
  fw: { zone: 'new' | string; internet: boolean; toLan: boolean; fromLan: boolean; routerAccess: boolean }
}

/** Stages everything a new network needs: device, interface, dhcp, zone + forwardings. */
export async function createNetwork(m: NetModel, s: NewNetwork) {
  let device: string
  if (s.where.kind === 'vlan') {
    device = `${s.where.parent}.${s.where.vid}`
    await uci.add('network', 'device', { type: '8021q', ifname: s.where.parent, vid: String(s.where.vid), name: device }, `${s.name}_dev`)
  } else {
    device = s.where.port
    await setPortUntagged(m, s.where.port, { kind: 'none' })
  }
  const iface: Record<string, UciValue> = { device, proto: s.proto }
  if (s.proto === 'static') Object.assign(iface, { ipaddr: s.ipaddr, netmask: prefixToNetmask(s.prefix) })
  if (s.proto === 'pppoe') Object.assign(iface, { username: s.pppoe?.username ?? '', password: s.pppoe?.password ?? '' })
  await uci.add('network', 'interface', iface, s.name)
  // only a network this router serves gets a DHCP server section
  if (s.proto === 'static') {
    await uci.add('dhcp', 'dhcp', s.dhcp.on
      ? { interface: s.name, start: String(s.dhcp.start), limit: String(s.dhcp.limit), leasetime: s.dhcp.leasetime }
      : { interface: s.name, ignore: '1' }, s.name)
  }

  if (s.fw.zone !== 'new') {
    const z = m.zones.find((x) => x.name === s.fw.zone)
    if (z) await uci.set('firewall', z['.name'], { network: [...list(z.network), s.name] })
    return
  }
  await uci.add('firewall', 'zone', {
    name: s.name, network: [s.name], input: s.fw.routerAccess ? 'ACCEPT' : 'REJECT', output: 'ACCEPT', forward: 'REJECT',
  })
  if (!s.fw.routerAccess) {
    await uci.add('firewall', 'rule', { name: `${s.name}-DHCP-DNS`, src: s.name, proto: 'tcp udp', dest_port: '53 67', target: 'ACCEPT' })
  }
  if (s.fw.internet) await uci.add('firewall', 'forwarding', { src: s.name, dest: m.wanZone })
  if (s.fw.toLan) await uci.add('firewall', 'forwarding', { src: s.name, dest: 'lan' })
  if (s.fw.fromLan) await uci.add('firewall', 'forwarding', { src: 'lan', dest: s.name })
}

/** What deleting a network removes (shown before the user stages it). */
export function deletePlan(m: NetModel, n: Net) {
  const out: { config: string; section: string; what: string; options?: Record<string, UciValue> }[] = []
  out.push({ config: 'network', section: n.name, what: `interface ${n.name}` })
  if (n.where.kind === 'vlan' && n.where.section) {
    const dev = n.where.device
    if (!m.nets.some((x) => x !== n && x.device === dev)) out.push({ config: 'network', section: n.where.section, what: `VLAN device ${dev}` })
  }
  for (const d of ofType(m.dhcp, 'dhcp').filter((x) => x.interface === n.name)) out.push({ config: 'dhcp', section: d['.name'], what: `DHCP server for ${n.name}` })
  for (const r of [...ofType(m.network, 'route'), ...ofType(m.network, 'route6')].filter((x) => x.interface === n.name))
    out.push({ config: 'network', section: r['.name'], what: `static route ${str(r.target) ?? ''}` })
  for (const z of m.zones.filter((x) => list(x.network).includes(n.name))) {
    const rest = list(z.network).filter((x) => x !== n.name)
    const zn = str(z.name)!
    if (!rest.length && zn === n.name) {
      out.push({ config: 'firewall', section: z['.name'], what: `firewall zone ${zn}` })
      for (const s of Object.values(m.firewall)) {
        if (['forwarding', 'rule', 'redirect'].includes(s['.type']) && (s.src === zn || s.dest === zn)) {
          out.push({ config: 'firewall', section: s['.name'], what: `${s['.type']} ${str(s.name) ?? `${str(s.src) ?? '*'} → ${str(s.dest) ?? 'router'}`}` })
        }
      }
    } else {
      out.push({ config: 'firewall', section: z['.name'], what: `remove ${n.name} from zone ${zn}`, options: { network: rest } })
    }
  }
  return out
}

export async function deleteNetwork(m: NetModel, n: Net) {
  for (const step of deletePlan(m, n)) {
    if (step.options) {
      const v = step.options.network as string[]
      if (v.length) await uci.set(step.config, step.section, step.options)
      else await uci.remove(step.config, step.section, ['network'])
    } else await uci.remove(step.config, step.section)
  }
}

/** Move a network to another firewall zone (zone membership lives on the zone's network list). */
export async function setNetZone(m: NetModel, n: Net, zoneName: string) {
  for (const z of m.zones) {
    const nets = list(z.network)
    const want = z.name === zoneName
    if (nets.includes(n.name) && !want) await uci.set('firewall', z['.name'], { network: nets.filter((x) => x !== n.name) })
    if (!nets.includes(n.name) && want) await uci.set('firewall', z['.name'], { network: [...nets, n.name] })
  }
}

/** DHCP server on/off for a network; creates the dhcp section when missing. */
export async function setDhcp(n: Net, on: boolean) {
  if (n.dhcp) await (on ? uci.remove('dhcp', n.dhcp['.name'], ['ignore']) : uci.set('dhcp', n.dhcp['.name'], { ignore: '1' }))
  else if (on) await uci.add('dhcp', 'dhcp', { interface: n.name, start: '100', limit: '150', leasetime: '12h' }, n.name)
}

/** A host in `s` by its offset: '.42' in a /24 or smaller, the whole address in anything bigger. */
export const hostTail = (s: Subnet, off: number) => (s.prefix >= 24 ? `.${(s.network + off) & 255}` : intToIp(s.network + off))

/** The addresses a DHCP pool hands out. UCI's start is an offset from the network address and
 *  limit a count, and dnsmasq stops at the last host, so the end is clamped there. */
export function poolRange(s: Subnet, start: number, limit: number) {
  const a = Math.max(1, start)
  const b = Math.min(s.size - 2, start + limit - 1)
  return b < a ? 'empty' : `${hostTail(s, a)}–${hostTail(s, b)}`
}

export const pool = (n: Net) => ({
  start: Number(str(n.dhcp?.start) ?? 100),
  limit: Number(str(n.dhcp?.limit) ?? 150),
  leasetime: str(n.dhcp?.leasetime) ?? '12h',
})

/** Sections with unapplied changes, per config. */
export function changedSections(ch: Record<string, [string, string, string?, unknown?][]>): Record<string, Set<string>> {
  return Object.fromEntries(Object.entries(ch).map(([c, l]) => [c, new Set(l.map((x) => x[1]))]))
}

// ---- IPv6 -----------------------------------------------------------------------------------
/** The DHCPv6 client(s) riding on a WAN network: same device, or "@<name>" (netifd's alias). */
export const ipv6Uplinks = (m: NetModel, n: Net) =>
  m.nets.filter((x) => x.proto === 'dhcpv6' && x !== n && (x.device === `@${n.name}` || (!!n.device && x.device === n.device)))

/** 6in4 tunnels (IPv6 from a tunnel broker such as Hurricane Electric when the ISP has none). */
export const tunnels6in4 = (m: NetModel) => m.nets.filter((x) => x.proto === '6in4')

/** Stage a 6in4 tunnel: the interface (its details filled in on its drawer), in the WAN zone, and
 *  a WAN rule letting the tunnel's packets (IP protocol 41) in, which fw4 would otherwise reject. */
export async function add6in4(m: NetModel): Promise<string> {
  let name = 'henet'
  for (let i = 2; m.network[name]; i++) name = `henet${i}`
  await uci.add('network', 'interface', { proto: '6in4', mtu: '1480' }, name)
  const wan = m.zones.find((z) => str(z.name) === m.wanZone)
  if (wan) {
    await uci.set('firewall', wan['.name'], { network: [...list(wan.network), name] })
    const has = Object.values(m.firewall).some((r) => r['.type'] === 'rule' && str(r.name) === 'Allow-6in4')
    if (!has) await uci.add('firewall', 'rule', { name: 'Allow-6in4', src: m.wanZone, proto: '41', target: 'ACCEPT' })
  }
  return name
}

/** Add a DHCPv6 client for a WAN network (wan -> wan6), in the WAN's firewall zone. Over PPPoE it
 *  rides on the session (@wan), otherwise on the same device. */
export async function addIpv6Uplink(m: NetModel, n: Net): Promise<string> {
  let name = `${n.name}6`
  for (let i = 2; m.network[name]; i++) name = `${n.name}6_${i}`
  await uci.add('network', 'interface', { device: n.proto === 'pppoe' ? `@${n.name}` : n.device!, proto: 'dhcpv6' }, name)
  if (n.zone) await uci.set('firewall', n.zone['.name'], { network: [...list(n.zone.network), name] })
  return name
}

/** How a LAN hands out IPv6 (odhcpd: the dhcp section's ra and dhcpv6 modes). Relay passes the
 *  ISP's RA/DHCPv6/NDP through from the DHCPv6 uplink, whose dhcp section is the relay master. */
export type V6Mode = 'off' | 'slaac' | 'dhcpv6' | 'stateful' | 'relay' | 'other'
export function v6Mode(d?: UciSection): V6Mode {
  const ra = str(d?.ra) ?? 'disabled', dh = str(d?.dhcpv6) ?? 'disabled'
  if (ra === 'disabled' && dh === 'disabled') return 'off'
  if (ra === 'server' && dh === 'disabled') return 'slaac'
  if (ra === 'server' && dh === 'server') return str(d?.ra_slaac) === '0' ? 'stateful' : 'dhcpv6'
  if (ra === 'relay' && dh === 'relay') return 'relay'
  return 'other'
}

/** The DHCPv6 uplink a relay would pass through from (wan6). */
export const relayMaster = (m: NetModel) => m.nets.find((x) => x.proto === 'dhcpv6')

export async function setV6Mode(n: Net, mode: Exclude<V6Mode, 'other'>, m?: NetModel) {
  const v: Record<string, UciValue> = mode === 'off' ? { ra: 'disabled', dhcpv6: 'disabled' } : mode === 'slaac' ? { ra: 'server', dhcpv6: 'disabled' }
    : mode === 'dhcpv6' ? { ra: 'server', dhcpv6: 'server' }
    // addresses from DHCPv6 only: no SLAAC prefix, the M flag (Android can't do DHCPv6 and gets none)
    : mode === 'stateful' ? { ra: 'server', dhcpv6: 'server', ra_slaac: '0', ra_flags: ['managed-config', 'other-config'] }
    : { ra: 'relay', dhcpv6: 'relay', ndp: 'relay' }
  if (n.dhcp) {
    await uci.set('dhcp', n.dhcp['.name'], v)
    const drop = [...(mode !== 'relay' ? ['ndp'] : []), ...(mode !== 'stateful' ? ['ra_slaac', 'ra_flags'] : [])].filter((k) => n.dhcp![k] !== undefined)
    if (drop.length) await uci.remove('dhcp', n.dhcp['.name'], drop)
  } else await uci.add('dhcp', 'dhcp', { interface: n.name, ignore: '1', ...v }, n.name)
  // relay needs a master: the uplink's dhcp section relaying all three
  const up = mode === 'relay' && m ? relayMaster(m) : undefined
  if (up) {
    const master = { master: '1', ra: 'relay', dhcpv6: 'relay', ndp: 'relay' }
    if (up.dhcp) await uci.set('dhcp', up.dhcp['.name'], master)
    else await uci.add('dhcp', 'dhcp', { interface: up.name, ignore: '1', ...master }, up.name)
  }
}
