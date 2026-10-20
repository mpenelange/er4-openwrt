// Pieces shared by the Network page and its drawers.
import { uci } from '../../api/uci'
import { pool, prefixToNetmask, subnet, type Net, type NetModel } from '../../api/net'
import { ER4_PORTS, type PortView } from '../../components/ports'
import { duration } from '../../components/format'
import { Badge } from '../../components/ui'
import { liveState, portUnapplied, type NetData } from './data'

export function portViews(d: NetData, m: NetModel): PortView[] {
  return ER4_PORTS.map((p) => {
    const r = m.ports.find((x) => x.name === p.name)!
    const dev = d.devs?.[p.name]
    return {
      ...p,
      link: dev ? dev.carrier : undefined,
      speed: dev?.speed,
      role: r.label,
      idle: r.role === 'unused',
      unapplied: portUnapplied(d, r),
      nets: [
        ...(r.untagged?.nets ?? []).filter((n, i, a) => !n.wan || a.findIndex((x) => x.wan) === i).map((n) => ({ slot: n.slot, name: n.name, label: `${n.name} (untagged)` })),
        ...r.tagged.flatMap((t) => t.nets.map((n) => ({ slot: n.slot, name: n.name, vid: t.vid, label: `${n.name} (VLAN ${t.vid}${t.via ? ` via ${t.via}` : ''})` }))),
      ],
    }
  })
}

export function Swatch({ slot }: { slot: number }) {
  return <span class="swatch" style={{ background: `var(--series-${slot})` }} aria-hidden="true" />
}

export function StatusBadge({ d, n }: { d: NetData; n: Net }) {
  const s = liveState(d, n)
  switch (s.kind) {
    case 'up': return <span class="row nowrap"><Badge status="good">up</Badge>{s.uptime !== undefined && <span class="muted small num">{duration(s.uptime)}</span>}</span>
    case 'down': return <Badge status={s.reason === 'connecting' ? 'warning' : 'serious'}>{s.reason}</Badge>
    case 'staged': return <Badge status="accent">not applied yet</Badge>
    default: return <span class="muted">–</span>
  }
}

const CIDR_RE = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/
export function validateCidr(v: string, m: NetModel, self?: string): string | undefined {
  const x = CIDR_RE.exec(v)
  if (!x) return 'Use address/prefix, e.g. 192.168.40.1/24'
  const s = subnet(x[1], Number(x[2]))
  if (!s) return 'Invalid address or prefix (/8 to /30)'
  const host = Number(x[1].split('.').reduce((n, o) => n * 256 + Number(o), 0))
  if (host === s.network || host === s.broadcast) return 'That is the network or broadcast address'
  const clash = m.nets.find((n) => n.name !== self && n.subnet && (Math.max(n.subnet.network, s.network) <= Math.min(n.subnet.broadcast, s.broadcast)))
  if (clash) return `Overlaps ${clash.name} (${clash.ipaddr}/${clash.prefix})`
  return undefined
}

export async function saveCidr(n: Net, v: string) {
  const [ip, p] = v.split('/')
  await uci.set('network', n.name, { ipaddr: ip, netmask: prefixToNetmask(Number(p)) })
  // a smaller subnet: fit the DHCP pool into it (start is an offset, limit a count)
  const sn = subnet(ip, Number(p))
  if (!sn || !n.dhcp) return
  const { start, limit } = pool(n)
  const last = sn.size - 2
  if (start + limit - 1 <= last) return
  const a = start <= last ? start : Math.min(100, Math.max(1, last - 9))
  await uci.set('dhcp', n.dhcp['.name'], { start: String(a), limit: String(last - a + 1) })
}

