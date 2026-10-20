// Devices: merges DHCP leases (luci-rpc getDHCPLeases), static reservations (UCI dhcp `host`),
// host hints (luci-rpc getHostHints) and the neighbour table (er4.neighbors) into one row per
// MAC, and stages reservation edits.
import { api } from './client'
import { uci } from './uci'
import { router } from './router'
import type { DhcpLease, UciSection } from './types'
import { inSubnet, ipToInt, list, str, type Net, type NetModel } from './net'

/** luci-rpc getHostHints: per MAC, the names/addresses the router has seen. */
export interface HostHint { name?: string; ipaddrs?: string[]; ip6addrs?: string[] }

/** er4.neighbors: the kernel neighbour table (ip -4 neigh), MACs lowercase. */
export interface Neighbor { ip: string; mac: string; dev: string; state: 'REACHABLE' | 'STALE' | 'DELAY' | 'PROBE' | 'FAILED' | 'PERMANENT' | 'NOARP' }

export const devicesApi = {
  hints: () => api.call<Record<string, HostHint>>('luci-rpc', 'getHostHints'),
  neighbors: async () => (await api.call<{ neighbors: Neighbor[] }>('er4', 'neighbors')).neighbors,
  leases: router.leases,
}

export type Online = 'online' | 'idle' | 'offline'

export interface DeviceRow {
  mac: string
  name?: string
  ip?: string
  host?: UciSection // the reservation / name pin
  reservedIp?: string
  lease?: DhcpLease
  hintName?: string
  online: Online
  net?: Net
}

export function mergeDevices(m: NetModel, leases: DhcpLease[], hints: Record<string, HostHint>, neigh: Neighbor[]): DeviceRow[] {
  const rows = new Map<string, DeviceRow>()
  const row = (mac: string) => {
    const k = mac.toLowerCase()
    let r = rows.get(k)
    if (!r) rows.set(k, (r = { mac: k, online: 'offline' }))
    return r
  }
  for (const h of Object.values(m.dhcp).filter((s) => s['.type'] === 'host')) {
    for (const mac of list(h.mac)) {
      const r = row(mac)
      r.host = h
      r.name = str(h.name)
      r.reservedIp = str(h.ip)
    }
  }
  for (const l of leases) {
    const r = row(l.macaddr)
    r.lease = l
    r.name ??= l.hostname
    r.ip = l.ipaddr
  }
  for (const [mac, h] of Object.entries(hints)) {
    // hints include the router's own interfaces and IPv6-only neighbours; keep the ones with IPv4
    if (!h.ipaddrs?.length && !rows.has(mac.toLowerCase())) continue
    const r = row(mac)
    r.hintName = h.name
    r.ip ??= h.ipaddrs?.[0]
  }
  for (const n of neigh) {
    const r = rows.get(n.mac.toLowerCase())
    if (!r) continue
    const st: Online = ['REACHABLE', 'DELAY', 'PROBE', 'PERMANENT'].includes(n.state) ? 'online' : n.state === 'STALE' ? 'idle' : 'offline'
    if (st === 'online' || (st === 'idle' && r.online === 'offline')) r.online = st
    r.ip ??= n.ip
  }
  for (const r of rows.values()) {
    r.ip ??= r.reservedIp
    const ip = r.reservedIp ?? r.ip
    r.net = ip ? m.nets.find((n) => n.subnet && inSubnet(n.subnet, ip)) : undefined
  }
  return [...rows.values()]
}

export const displayName = (r: DeviceRow) => r.name ?? r.hintName
export const ipSortKey = (ip?: string) => (ip ? ipToInt(ip) ?? 0 : 0xffffffff)

export const HOSTNAME_RE = /^[A-Za-z0-9]([A-Za-z0-9-]{0,62})$/

/** Rename a device: edits its host section, or pins the name with a new name-only host section. */
export async function renameDevice(r: DeviceRow, name: string) {
  if (r.host) await uci.set('dhcp', r.host['.name'], { name })
  else await uci.add('dhcp', 'host', { name, mac: r.mac })
}

/** "Reserve this IP": one click from a lease. */
export async function reserve(r: DeviceRow, ip = r.ip!) {
  const name = displayName(r) ?? `host-${r.mac.slice(-5).replace(':', '')}`
  if (r.host) await uci.set('dhcp', r.host['.name'], { ip, ...(str(r.host.name) ? {} : { name }) })
  else await uci.add('dhcp', 'host', { name, mac: r.mac, ip })
}

export async function setReservedIp(r: DeviceRow, ip: string) {
  if (r.host) await uci.set('dhcp', r.host['.name'], { ip })
  else await reserve(r, ip)
}

export async function unreserve(r: DeviceRow) {
  if (r.host) await uci.remove('dhcp', r.host['.name'])
}

/** Why an IP can't be reserved for this device, or undefined if it can. */
export function checkReservedIp(m: NetModel, rows: DeviceRow[], r: DeviceRow, ip: string): string | undefined {
  if (ipToInt(ip) === undefined) return 'Not an IPv4 address'
  const net = m.nets.find((n) => n.subnet && inSubnet(n.subnet, ip))
  if (!net) return 'Not in any local network'
  if (net.ipaddr === ip) return `That's the router's address on ${net.name}`
  const other = rows.find((x) => x !== r && x.reservedIp === ip)
  if (other) return `Reserved for ${displayName(other) ?? other.mac}`
  return undefined
}
