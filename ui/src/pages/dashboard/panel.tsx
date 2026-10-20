// The ER-4 front panel: eth0 (WAN) .. eth3, in panel order. Each port shows link
// state + speed (network.device status) and live rx/tx (er4.stats); click opens the port page.
import type { DeviceStatus, UciConfig } from '../../api/types'
import { bps, count, linkSpeed } from '../../components/format'
import { PORTS, type Derived } from './live'

type Rate = NonNullable<Derived['rates'][number]>

/** Role of a physical port from /etc/config/network: 'wan', 'lan', 'lan, iot' ... */
export function portRoles(net: UciConfig | undefined): Record<string, string> {
  const roles: Record<string, string> = {}
  if (!net) return roles
  const secs = Object.values(net)
  const ifacesOn = (dev: string) => secs.filter((s) => s['.type'] === 'interface' && s.device === dev).map((s) => s['.name'])
  for (const p of PORTS) {
    const names = new Set(ifacesOn(p))
    for (const b of secs.filter((s) => s['.type'] === 'device' && s.type === 'bridge' && Array.isArray(s.ports) && s.ports.includes(p))) {
      const br = String(b.name)
      ifacesOn(br).forEach((n) => names.add(n))
      // VLANs on the bridge (802.1q devices whose ifname is the bridge)
      for (const v of secs.filter((s) => s['.type'] === 'device' && s.ifname === br)) ifacesOn(String(v.name)).forEach((n) => names.add(n))
    }
    names.delete('wan6')
    roles[p] = [...names].join(', ') || 'unused'
  }
  return roles
}

export function FrontPanel({ devices, roles, latest }: {
  devices?: Record<string, DeviceStatus>; roles: Record<string, string>; latest?: Rate
}) {
  return (
    <div class="panel" aria-label="Front panel">
      {PORTS.map((p, i) => {
        const d = devices?.[p]
        const link = !!d?.carrier
        const r = latest?.ports[p]
        const errs = d?.statistics ? d.statistics.rx_errors + d.statistics.tx_errors : 0
        const role = roles[p] ?? ''
        const speed = d ? linkSpeed(d.carrier ? d.speed : undefined) : '…'
        const half = d?.speed?.endsWith('H')
        return (
          <a class={`port${link ? '' : ' nolink'}`} href={`#/network/port/${p}`}
            title={`${p} · ${role} · ${speed}${d?.macaddr ? ` · ${d.macaddr}` : ''}`}>
            <div class="port-top">
              <div class="port-id">
                <span class="port-name"><i class="swatch" style={{ background: `var(--series-${i + 1})` }} />{p}</span>
                <span class={`port-role${role.startsWith('wan') ? ' wan' : ''}`}>{role.toUpperCase() || ' '}</span>
              </div>
            </div>
            <div class={`port-link${link ? ' up' : ''}${half ? ' half' : ''}`}>
              <i class="dot" />{d ? (link ? speed : 'no link') : 'loading'}
              {half && <span class="port-warn">half duplex</span>}
              {errs > 0 && <span class="port-warn" title="receive + send errors since boot (details in the port drawer)">{count(errs)} errors</span>}
            </div>
            <div class="port-rates num">
              <span title="received"><span class="muted">rx</span> {link && r ? bps(r.rxBps) : '–'}</span>
              <span title="sent"><span class="muted">tx</span> {link && r ? bps(r.txBps) : '–'}</span>
            </div>
          </a>
        )
      })}
    </div>
  )
}
