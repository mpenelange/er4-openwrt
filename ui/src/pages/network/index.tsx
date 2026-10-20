// Network: which networks run on which port (a map: drag a port onto a network), the logical
// networks with inline editing, and the "New network" wizard. Routes:
//   #/network                     overview
//   #/network/port/<ethN>         port drawer (the dashboard links here)
//   #/network/iface/<name>        network drawer
//   #/network/new[/vlan/<parent>|/port/<ethN>]   wizard, optionally pre-placed
//   #/network/route/<section|new>  static route drawer
import type { PageProps } from '../../app'
import { go } from '../../app'
import { isPort, str, type NetModel, pool, poolRange, subnet } from '../../api/net'
import { uci } from '../../api/uci'
import { Segmented } from '../../components/ui'
import { InlineEdit } from '../../components/inline'
import { Badge, Button, Card, Empty, ErrorBox, PageHead } from '../../components/ui'
import { clientsIn, netUnapplied, useNetData, type NetData } from './data'
import { saveCidr, StatusBadge, Swatch, validateCidr } from './parts'
import { PortDrawer } from './port-drawer'
import { IfaceDrawer } from './iface-drawer'
import { Wizard } from './wizard'
import { RouteDrawer, RoutesCard } from './routes'
import { NetMap } from './map'
import './network.css'

export default function Network({ path: raw }: PageProps) {
  const path = raw.map((s) => s.split('?')[0]).filter(Boolean)
  const d = useNetData()
  const m = d.model
  const close = () => go('network')

  return (
    <div class="page network-page">
      <PageHead title="Network">
        <Button variant="primary" icon="plus" onClick={() => go('network', 'new')}>New network</Button>
      </PageHead>
      {d.modelError && <ErrorBox error={d.modelError} />}
      {!m && !d.modelError && <Empty>Loading network configuration…</Empty>}
      {m && (
        <>
          {d.ifaceError && <ErrorBox error={new Error(`Live interface status unavailable (${d.ifaceError.message}); showing configuration only.`)} />}
          <Card title="Ports ↔ networks" flush>
            <NetMap d={d} m={m} />
          </Card>
          <Card title={`Networks · ${m.nets.length}`} flush>
            <NetTable d={d} m={m} />
          </Card>
          <RoutesCard d={d} m={m} />
          <GlobalCard m={m} />
        </>
      )}
      {m && path[0] === 'port' && isPort(path[1]) && <PortDrawer d={d} m={m} port={path[1]} onClose={close} />}
      {m && path[0] === 'iface' && path[1] && <IfaceDrawer d={d} m={m} name={path[1]} onClose={close} />}
      {m && path[0] === 'new' && <Wizard d={d} m={m} preset={path.slice(1)} onClose={close} />}
      {m && path[0] === 'route' && path[1] && <RouteDrawer key={path[1]} m={m} section={path[1] === 'new' ? undefined : path[1]} onClose={close} />}
    </div>
  )
}

function NetTable({ d, m }: { d: NetData; m: NetModel }) {
  if (!m.nets.length) {
    return (
      <Empty>
        No networks configured.{' '}
        <Button variant="primary" icon="plus" onClick={() => go('network', 'new')}>Create the first network</Button>
      </Empty>
    )
  }
  return (
    <table class="table nettable">
      <thead>
        <tr>
          <th>Network</th>
          <th>Address</th>
          <th>Status</th>
          <th>DHCP</th>
          <th>Zone</th>
          <th class="num">Clients</th>
        </tr>
      </thead>
      <tbody>
        {m.nets.map((n) => {
          const live = d.ifaces?.find((i) => i.interface === n.name)
          const liveAddr = live?.['ipv4-address']?.[0] ?? live?.['ipv6-address']?.[0]
          const p = pool(n)
          const sn = n.ipaddr && n.prefix != null ? subnet(n.ipaddr, n.prefix) : undefined
          const clients = clientsIn(d, n)
          return (
            <tr key={n.name} class="clickable" onClick={() => go('network', 'iface', n.name)}>
              <td>
                <span class="row nowrap">
                  <Swatch slot={n.slot} />
                  <strong>{n.name}</strong>
                  {netUnapplied(d, n) && <Badge status="accent">unapplied</Badge>}
                </span>
              </td>
              <td>
                {n.proto === 'static' ? (
                  <InlineEdit mono label={`${n.name} address`} value={n.ipaddr ? `${n.ipaddr}/${n.prefix}` : ''}
                    validate={(v) => validateCidr(v, m, n.name)} onSave={(v) => saveCidr(n, v)} />
                ) : liveAddr ? (
                  <span class="mono" title="assigned by upstream">{liveAddr.address}/{liveAddr.mask}</span>
                ) : n.ipaddr ? <span class="mono">{n.ipaddr}/{n.prefix}</span> : <span class="muted">–</span>}
              </td>
              <td><StatusBadge d={d} n={n} /></td>
              <td>
                {/* the pool and its devices live on the Devices page */}
                {n.proto === 'static' && n.where.kind !== 'virtual' ? (
                  <a class={n.dhcpOn ? 'num small' : 'muted small'} href="#/devices" onClick={(e) => e.stopPropagation()} title="Pool and devices on the Devices page">
                    {n.dhcpOn ? (sn ? poolRange(sn, p.start, p.limit) : `+${p.start}, ${p.limit} addresses`) : 'off'}
                  </a>
                ) : <span class="muted">–</span>}
              </td>
              <td>{n.zoneName ? <Badge>{n.zoneName}</Badge> : <Badge status="warning">no zone</Badge>}</td>
              <td class="num">{clients ?? '–'}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/** network.globals: the IPv6 ULA prefix and packet steering (kept off on the ER-4, see below). */
function GlobalCard({ m }: { m: NetModel }) {
  const g = Object.values(m.network).find((x) => x['.type'] === 'globals')
  const sec = g?.['.name'] ?? 'globals'
  const set = (opt: string) => (v: string) =>
    g ? (v ? uci.set('network', sec, { [opt]: v }) : uci.remove('network', sec, [opt])) : v ? uci.add('network', 'globals', { [opt]: v }, 'globals') : Promise.resolve()
  const steering = str(g?.packet_steering) ?? '0'
  return (
    <Card title="Global">
      <div class="kv">
        <span>IPv6 ULA prefix</span>
        <span title="ula_prefix: private IPv6 addresses for the LANs, stable whatever the ISP delegates">
          <InlineEdit mono label="IPv6 ULA prefix" placeholder="none" value={str(g?.ula_prefix) ?? ''} width={220} onSave={set('ula_prefix')}
            validate={(v) => (v && !/^f[cd][0-9a-f]{0,2}(:[0-9a-f]{0,4}){1,7}\/(4[89]|5\d|6[0-4])$/i.test(v) ? 'A ULA prefix, e.g. fd3c:6a1e:9b20::/48' : undefined)} /></span>
        <span>Packet steering</span>
        <span class="row" title="Off on the ER-4: the ports already spread receive over all 4 cores; on, it funnels it to one core">
          <Segmented value={steering === '1' || steering === '2' ? '1' : '0'} onChange={set('packet_steering')}
            options={[{ value: '0', label: 'Off' }, { value: '1', label: 'On' }]} />
          {steering !== '0' && <Badge status="warning">slows offload</Badge>}
        </span>
      </div>
    </Card>
  )
}
