// Static routes (UCI network @route / @route6): a card on the Network page and a drawer to add or
// edit one. IPv4 and IPv6 share the table; the target decides which section type it is.
//   #/network/route/new   #/network/route/<section>
import { useState } from 'preact/hooks'
import { go } from '../../app'
import { uci } from '../../api/uci'
import { inSubnet, str, type NetModel } from '../../api/net'
import type { UciValue } from '../../api/types'
import { Badge, Button, Card, Drawer, Empty, Field, Segmented, Toggle } from '../../components/ui'
import { Icon } from '../../components/icons'
import type { NetData } from './data'

const V4_CIDR = /^(\d{1,3}(?:\.\d{1,3}){3})(?:\/(\d{1,2}))?$/
const V6_CIDR = /^([0-9a-f:]+:[0-9a-f:]*)(?:\/(\d{1,3}))?$/i
const IP4 = /^\d{1,3}(\.\d{1,3}){3}$/
const IP6 = /^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}$/i
const okOctets = (ip: string) => ip.split('.').every((o) => Number(o) <= 255)

type RouteType = 'unicast' | 'blackhole' | 'unreachable'

export interface StaticRoute {
  section: string
  six: boolean
  target: string
  gateway?: string
  iface?: string
  metric?: string
  type: RouteType
  disabled: boolean
}

/** All static routes; target may be "a.b.c.d" + netmask (old style) or CIDR. */
export function staticRoutes(m: NetModel): StaticRoute[] {
  return Object.values(m.network)
    .filter((s) => s['.type'] === 'route' || s['.type'] === 'route6')
    .sort((a, b) => (a['.index'] ?? 0) - (b['.index'] ?? 0))
    .map((s) => {
      const six = s['.type'] === 'route6'
      let target = str(s.target) ?? ''
      const mask = str(s.netmask)
      if (!six && target && !target.includes('/') && mask) {
        const bits = mask.split('.').reduce((n, o) => n + (Number(o) >>> 0).toString(2).replace(/0/g, '').length, 0)
        target = `${target}/${bits}`
      }
      return {
        section: s['.name'], six, target, gateway: str(s.gateway), iface: str(s.interface), metric: str(s.metric),
        type: (str(s.type) as RouteType) ?? 'unicast', disabled: s.disabled === '1',
      }
    })
}

export function RoutesCard({ d, m }: { d: NetData; m: NetModel }) {
  const routes = staticRoutes(m)
  const changed = d.changed.network
  return (
    <Card flush title={`Static routes · ${routes.length}`} actions={<Button icon="plus" onClick={() => go('network', 'route', 'new')}>Add route</Button>}>
      {!routes.length ? <Empty>No static routes.</Empty> : (
        <table class="table routes-table">
          <thead><tr><th>Destination</th><th>Via</th><th>Network</th><th class="num">Metric</th></tr></thead>
          <tbody>
            {routes.map((r) => (
              <tr class={`clickable${r.disabled ? ' disabled' : ''}`} onClick={() => go('network', 'route', r.section)}>
                <td class="mono">{r.target}{r.type !== 'unicast' && <span class="muted"> {r.type}</span>}
                  {r.disabled && <> <Badge>off</Badge></>}{changed?.has(r.section) && <> <Badge status="accent">unapplied</Badge></>}</td>
                <td class="mono">{r.gateway ?? <span class="muted">{r.type === 'unicast' ? 'on-link' : '–'}</span>}</td>
                <td>{r.iface ?? <span class="muted">–</span>}</td>
                <td class="num">{r.metric ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}

function validTarget(v: string): string | undefined {
  const s = v.trim()
  if (!s) return 'Required'
  const a = V4_CIDR.exec(s)
  if (a) return !okOctets(a[1]) || (a[2] !== undefined && Number(a[2]) > 32) ? 'Not an IPv4 network' : undefined
  const b = V6_CIDR.exec(s)
  if (b && IP6.test(b[1])) return b[2] !== undefined && Number(b[2]) > 128 ? 'Prefix is 0 to 128' : undefined
  return 'An address or network, e.g. 10.20.0.0/16 or 2001:db8:5::/48'
}

export function RouteDrawer({ m, section, onClose }: { m: NetModel; section?: string; onClose: () => void }) {
  const existing = section ? staticRoutes(m).find((r) => r.section === section) : undefined
  const [target, setTarget] = useState(existing?.target ?? '')
  const [gateway, setGateway] = useState(existing?.gateway ?? '')
  const [iface, setIface] = useState(existing?.iface ?? '')
  const [metric, setMetric] = useState(existing?.metric ?? '')
  const [type, setType] = useState<RouteType>(existing?.type ?? 'unicast')
  const [enabled, setEnabled] = useState(!existing?.disabled)
  const [tried, setTried] = useState(false)
  if (section && !existing) {
    return <Drawer title="Static route" onClose={onClose}><Empty>No route “{section}” (deleted, or not created yet).</Empty></Drawer>
  }

  const t = target.trim(), g = gateway.trim()
  const six = t.includes(':')
  const tErr = validTarget(t)
  const gErr = g && type === 'unicast' && !(six ? IP6.test(g) : IP4.test(g) && okOctets(g)) ? `An ${six ? 'IPv6' : 'IPv4'} address` : undefined
  const iErr = !iface ? 'Pick the network the route leaves through' : undefined
  const mErr = metric && !/^\d{1,9}$/.test(metric) ? 'A number' : undefined
  const err = tErr || gErr || iErr || mErr
  // A gateway has to be reachable on the network (netifd won't add the route otherwise)
  const net = m.nets.find((n) => n.name === iface)
  const offLink = !six && g && !gErr && net?.subnet && !inSubnet(net.subnet, g)
  const nets = m.nets.filter((n) => n.proto !== 'none')

  const save = async () => {
    setTried(true)
    if (err) return
    const norm = !six && !t.includes('/') ? `${t}/32` : six && !t.includes('/') ? `${t}/128` : t
    const values: Record<string, UciValue> = { target: norm, interface: iface }
    const clear: string[] = []
    const opt = (k: string, v: string | undefined) => { if (v) values[k] = v; else if (existing) clear.push(k) }
    opt('gateway', type === 'unicast' ? g : undefined)
    opt('metric', metric)
    opt('type', type === 'unicast' ? undefined : type)
    opt('disabled', enabled ? undefined : '1')
    if (existing && existing.six === six) {
      await uci.set('network', existing.section, values)
      // the target is CIDR now, so an old-style netmask goes too
      if (m.network[existing.section]?.netmask !== undefined) clear.push('netmask')
      if (clear.length) await uci.remove('network', existing.section, clear)
    } else {
      // new, or the family changed: route <-> route6 is a different section type
      if (existing) await uci.remove('network', existing.section)
      await uci.add('network', six ? 'route6' : 'route', values)
    }
    onClose()
  }
  const del = async () => { await uci.remove('network', existing!.section); onClose() }

  return (
    <Drawer title={existing ? <span class="mono">{existing.target}</span> : 'New static route'} onClose={onClose} footer={<>
      {existing && <Button variant="danger" icon="trash" onClick={del}>Delete route</Button>}
      <span class="spacer" />
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" onClick={save} disabled={tried && !!err}>{existing ? 'Save' : 'Add route'}</Button>
    </>}>
      <form class="stack gap3" onSubmit={(e) => { e.preventDefault(); save() }}>
        <Field label="Destination" error={tErr && (tried || t) ? tErr : undefined}>
          <input class={`input mono${tried && tErr ? ' invalid' : ''}`} aria-label="Destination" placeholder="10.20.0.0/16" value={target} autocomplete="off" spellcheck={false}
            onInput={(e) => setTarget((e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="Kind">
          <Segmented value={type} onChange={setType} options={[{ value: 'unicast', label: 'Forward' }, { value: 'blackhole', label: 'Drop' }, { value: 'unreachable', label: 'Reject' }]} />
        </Field>
        {type === 'unicast' && (
          <Field label="Gateway" error={gErr && (tried || g) ? gErr : undefined}>
            <input class={`input mono${gErr && (tried || g) ? ' invalid' : ''}`} aria-label="Gateway" placeholder="on-link (no gateway)" value={gateway} autocomplete="off" spellcheck={false}
              onInput={(e) => setGateway((e.target as HTMLInputElement).value)} />
          </Field>
        )}
        <Field label="Network" error={tried ? iErr : undefined}>
          <div class="chips" role="group" aria-label="Network">
            {nets.map((n) => (
              <button type="button" class={`chip${iface === n.name ? ' on' : ''}`} aria-pressed={iface === n.name} onClick={() => setIface(n.name)}>
                {n.name}{n.ipaddr && <span class="muted small mono">{n.ipaddr}/{n.prefix}</span>}
              </button>
            ))}
          </div>
        </Field>
        {offLink && <div class="note warn"><Icon name="warning" /> {g} isn't in {iface}'s subnet ({net!.ipaddr}/{net!.prefix}): the route won't come up.</div>}
        <Field label="Metric" error={mErr}>
          <input class={`input num${mErr ? ' invalid' : ''}`} aria-label="Metric" placeholder="0" style={{ width: '100px' }} value={metric}
            onInput={(e) => setMetric((e.target as HTMLInputElement).value)} />
        </Field>
        <label class="row" style={{ gap: '8px' }}>
          <Toggle on={enabled} onChange={setEnabled} label="Enabled" /> Enabled
        </label>
      </form>
    </Drawer>
  )
}
