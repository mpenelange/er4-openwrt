// Data for the Network page and its drawers: staged UCI model, live netifd state, changes.
import { useEffect, useState } from 'preact/hooks'
import { router } from '../../api/router'
import { useAsync } from '../../api/store'
import { uci } from '../../api/uci'
import { changedSections, inSubnet, loadModel, type Net, type NetModel, type PortRole } from '../../api/net'
import type { DeviceStatus, DhcpLease, NetInterface } from '../../api/types'

export interface NetData {
  model?: NetModel
  modelError?: Error
  ifaces?: NetInterface[]
  ifaceError?: Error
  devs?: Record<string, DeviceStatus>
  leases?: DhcpLease[]
  changed: Record<string, Set<string>>
}

/** Live device state is polled (link changes); config re-reads on staged/applied changes. */
export function useNetData(): NetData {
  const model = useAsync(loadModel)
  const ifaces = useAsync(router.interfaces, [], ['applied', 'changes', 'iface'])
  const leases = useAsync(router.leases, [], ['applied'])
  const changes = useAsync(uci.changes)
  const [devs, setDevs] = useState<Record<string, DeviceStatus>>()
  useEffect(() => {
    let alive = true
    const tick = () => router.devices().then((d) => alive && setDevs(d), () => {})
    tick()
    const t = setInterval(tick, 5000)
    return () => { alive = false; clearInterval(t) }
  }, [])
  return {
    model: model.data, modelError: model.error,
    ifaces: ifaces.data, ifaceError: ifaces.error,
    devs, leases: leases.data,
    changed: changedSections((changes.data ?? {}) as never),
  }
}

export function netUnapplied(d: NetData, n: Net): boolean {
  const c = d.changed
  return !!(c.network?.has(n.name) || (n.where.kind === 'vlan' && n.where.section && c.network?.has(n.where.section)) ||
    (n.dhcp && c.dhcp?.has(n.dhcp['.name'])) || (n.zone && c.firewall?.has(n.zone['.name'])))
}

export function portUnapplied(d: NetData, p: PortRole): boolean {
  const m = d.model
  if (!m) return false
  const b = m.bridges.find((x) => x.ports.includes(p.name))
  const touched = [...(p.untagged?.nets ?? []), ...p.tagged.flatMap((t) => t.nets)].map((n) => n.name)
  // a port that just left a bridge: the bridge changed and the port has no role yet
  const leftBridge = !b && m.bridges.some((x) => d.changed.network?.has(x.section)) && p.role === 'unused'
  return !!((b && d.changed.network?.has(b.section)) || touched.some((t) => d.changed.network?.has(t)) || leftBridge)
}

export type LiveState = { kind: 'up'; uptime?: number } | { kind: 'down'; reason: string } | { kind: 'staged' } | { kind: 'unknown' }

export function liveState(d: NetData, n: Net): LiveState {
  const i = d.ifaces?.find((x) => x.interface === n.name)
  if (!d.ifaces) return { kind: 'unknown' }
  if (!i) return { kind: 'staged' }
  if (i.up) return { kind: 'up', uptime: i.uptime }
  if (i.autostart === false) return { kind: 'down', reason: 'stopped' }
  const err = i.errors?.[0]?.code
  if (err) return { kind: 'down', reason: err === 'AUTH_FAILED' ? 'login failed' : err.toLowerCase().replace(/_/g, ' ') }
  if (i.pending) return { kind: 'down', reason: 'connecting' }
  if (!n.device && n.where.kind !== 'virtual') return { kind: 'down', reason: 'no port' }
  return { kind: 'down', reason: 'no link' }
}

export const clientsIn = (d: NetData, n: Net) => (n.subnet && d.leases ? d.leases.filter((l) => inSubnet(n.subnet!, l.ipaddr)).length : undefined)

export const PROTO_LABEL: Record<string, string> = {
  static: 'Static', dhcp: 'DHCP client', dhcpv6: 'DHCPv6 client', wireguard: 'WireGuard', none: 'Unmanaged', pppoe: 'PPPoE', '6in4': '6in4 tunnel',
}

export function whereText(n: Net): string {
  const w = n.where
  switch (w.kind) {
    case 'bridge': return `bridge ${w.bridge}`
    case 'vlan': return `VLAN ${w.vid} on ${w.parent}`
    case 'port': return `port ${w.port}`
    case 'virtual': return n.proto === 'wireguard' ? 'WireGuard tunnel' : n.proto === '6in4' ? 'IPv6 tunnel over the WAN (6in4)' : 'virtual'
    case 'none': return 'no device'
  }
}
