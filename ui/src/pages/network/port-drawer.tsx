// Port drawer: what a physical port carries. Untagged traffic is one of WAN / a bridge /
// a dedicated network / nothing (big choice cards, not a dropdown); tagged VLANs are listed
// with a shortcut into the wizard to add one.
import { useEffect, useState } from 'preact/hooks'
import { go } from '../../app'
import { uci } from '../../api/uci'
import { setPortUntagged, type NetModel, type PortName, type PortTarget } from '../../api/net'
import { bytes, linkSpeed } from '../../components/format'
import { PortPanel } from '../../components/ports'
import { Badge, Button, Drawer, ErrorBox } from '../../components/ui'
import { Icon } from '../../components/icons'
import { portViews, Swatch } from './parts'
import type { NetData } from './data'
import type { DeviceStatus } from '../../api/types'

type Choice = 'wan' | `bridge:${string}` | `net:${string}` | 'none'

const ERRORS: [keyof DeviceStatus['statistics'], string][] = [
  ['rx_crc_errors', 'CRC'], ['rx_frame_errors', 'frame'], ['rx_length_errors', 'length'], ['rx_missed_errors', 'missed'],
  ['rx_over_errors', 'overrun'], ['rx_fifo_errors', 'FIFO'], ['tx_carrier_errors', 'carrier'], ['collisions', 'collisions'],
]
/** Non-zero link error counters since boot; generic rx/tx errors only when no detail explains them. */
function linkErrors(dev: DeviceStatus): [string, number][] {
  const out = ERRORS.map(([k, l]) => [l, dev.statistics[k] ?? 0] as [string, number]).filter(([, v]) => v > 0)
  if (!out.length && dev.statistics.rx_errors) out.push(['receive', dev.statistics.rx_errors])
  if (dev.statistics.tx_errors) out.push(['send', dev.statistics.tx_errors])
  return out
}

export function PortDrawer({ d, m, port, onClose }: { d: NetData; m: NetModel; port: PortName; onClose: () => void }) {
  const r = m.ports.find((p) => p.name === port)!
  const current: Choice = r.role === 'wan' ? 'wan'
    : r.untagged?.kind === 'bridge' ? `bridge:${r.untagged.bridge}`
    : r.untagged?.kind === 'net' ? `net:${r.untagged.nets[0].name}` : 'none'
  const [choice, setChoice] = useState<Choice>(current)
  const [oldWanToLan, setOldWanToLan] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  useEffect(() => setChoice(current), [port, current])

  const dev = d.devs?.[port]
  const oldWan = m.ports.find((p) => p.role === 'wan' && p.name !== port)
  const lanBridge = m.bridges[0]
  // networks that can own a port outright: not on a bridge/VLAN, not WAN, not virtual
  const candidates = m.nets.filter((n) => !n.wan && (n.where.kind === 'port' || n.where.kind === 'none'))
  const dedicatedNet = choice.startsWith('net:') ? choice.slice(4) : undefined

  const stage = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const target: PortTarget = choice === 'wan' ? { kind: 'wan' } : choice === 'none' ? { kind: 'none' }
        : choice.startsWith('bridge:') ? { kind: 'bridge', bridge: choice.slice(7) } : { kind: 'net', net: choice.slice(4) }
      await setPortUntagged(m, port, target)
      if (choice === 'wan' && oldWan && oldWanToLan && lanBridge) {
        // WAN interfaces already moved to this port; just add the old WAN port to the bridge
        await uci.set('network', lanBridge.section, { ports: [...lanBridge.ports.filter((p) => p !== port), oldWan.name] })
      }
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  const bridgeAfter = (b: string) => {
    const br = m.bridges.find((x) => x.name === b)!
    return choice === `bridge:${b}` ? br.ports : br.ports.filter((p) => p !== port)
  }
  const warnings: string[] = []
  if (choice !== current) {
    for (const b of m.bridges) if (b.ports.includes(port) && !bridgeAfter(b.name).length) warnings.push(`${b.name} will have no ports left: everything on it (${m.nets.filter((n) => n.where.kind === 'bridge' && n.where.bridge === b.name).map((n) => n.name).join(', ') || 'nothing'}) goes offline.`)
    if (current === 'wan' && choice !== 'wan') warnings.push('No port will be WAN: the router loses its internet uplink until you assign one.')
    if (current.startsWith('bridge:')) warnings.push(`If this browser reaches the router through ${port}, you may lose the connection; unconfirmed changes revert by themselves after 60 s.`)
    const others = choice.startsWith('bridge:') ? bridgeAfter(choice.slice(7)).filter((p) => p !== port) : []
    if (others.length) warnings.push(`Traffic between ${port} and ${others.join(', ')} will be switched by the CPU (the ER-4 has no switch chip): much slower than routing, and never offloaded. “Its own network” routes it at full speed.`)
  }

  const cards: { id: Choice; title: string; desc: string; icon: 'globe' | 'network' | 'bolt' | 'close' }[] = [
    { id: 'wan', title: 'WAN', icon: 'globe', desc: `Internet uplink (${m.nets.filter((n) => n.wan).map((n) => n.name).join(', ') || 'wan'}). ${port === 'eth3' ? 'SFP: fibre or a GPON stick.' : 'Usually the modem.'}` },
    { id: dedicatedNet ? (`net:${dedicatedNet}` as Choice) : (`net:` as Choice), icon: 'bolt', title: 'Its own network', desc: 'One network on this port alone, routed (and offloaded) to the others.' },
    ...m.bridges.map((b) => {
      const shared = b.ports.filter((p) => p !== port)
      return {
        id: `bridge:${b.name}` as Choice, icon: 'network' as const,
        title: `LAN bridge ${b.name}`,
        desc: `Switch port of ${m.nets.filter((n) => n.where.kind === 'bridge' && n.where.bridge === b.name).map((n) => n.name).join(', ') || b.name}, shared with ${shared.join(', ') || 'no other port'}.${shared.length ? ' Switched by the CPU: slow, never offloaded.' : ''}`,
      }
    }),
    { id: 'none', icon: 'close', title: 'Unused', desc: 'Nothing untagged. Tagged VLANs below still work (trunk).' },
  ]

  return (
    <Drawer title={<span class="row">Port <span class="mono">{port}</span>{port === 'eth3' && <Badge>SFP</Badge>}</span>} onClose={onClose} footer={
      <>
        <span class="spacer" />
        <Button onClick={onClose}>Close</Button>
        <Button variant="primary" icon="check" disabled={busy || choice === current || choice === 'net:'} onClick={stage}>Stage change</Button>
      </>
    }>
      <div class="stack gap3">
        <PortPanel compact ports={portViews(d, m)} selected={port} onSelect={(p) => go('network', 'port', p)} />
        <div class="kv">
          <span>Link</span><span>{dev ? dev.carrier ? <Badge status="good">{linkSpeed(dev.speed)}</Badge> : <Badge status="serious">no link</Badge> : '–'}</span>
          <span>MAC</span><span class="mono">{dev?.macaddr ?? '–'}</span>
          <span>Received</span><span class="num">{dev ? `${bytes(dev.statistics.rx_bytes)} · ${dev.statistics.rx_dropped} dropped` : '–'}</span>
          <span>Sent</span><span class="num">{dev ? bytes(dev.statistics.tx_bytes) : '–'}</span>
          {dev?.autoneg !== undefined && <>
            <span>Negotiation</span>
            <span title={dev['link-partner-advertising']?.length ? `The other end offers ${dev['link-partner-advertising'].join(', ')}` : undefined}>
              {dev.autoneg ? 'auto' : <Badge status="warning">forced</Badge>}
              {dev.carrier && dev.autoneg && !dev['link-partner-advertising']?.length && <> <Badge status="warning">other end forced: duplex mismatch likely</Badge></>}
              {dev['flow-control']?.negotiated?.length ? <span class="muted"> · pause frames {dev['flow-control'].negotiated.join('+')}</span> : null}
            </span>
          </>}
          {dev && <>
            <span>Errors</span>
            <span class="num">{linkErrors(dev).length ? linkErrors(dev).map(([k, v]) => <><Badge status="warning">{v} {k}</Badge> </>) : <span class="muted">none</span>}</span>
          </>}
        </div>

        <section>
          <h4 class="section-h">Untagged traffic</h4>
          <div class="choice-grid">
            {cards.map((c) => {
              const on = c.id === choice || (c.id === 'net:' && choice.startsWith('net:'))
              return (
                <button type="button" class={`choice${on ? ' on' : ''}`} aria-pressed={on}
                  onClick={() => setChoice(c.id === 'net:' ? (candidates[0] ? `net:${candidates[0].name}` : 'net:') : c.id)}>
                  <span class="choice-title"><Icon name={c.icon} /> {c.title}{c.id === current && <span class="muted small">current</span>}</span>
                  <span class="choice-desc">{c.desc}</span>
                </button>
              )
            })}
          </div>
          {choice.startsWith('net:') && (
            <div class="subchoice">
              <span class="muted small">Network on {port}:</span>
              {candidates.map((n) => (
                <button type="button" class={`chip${dedicatedNet === n.name ? ' on' : ''}`} onClick={() => setChoice(`net:${n.name}`)}>
                  <Swatch slot={n.slot} /> {n.name}
                  <span class="muted small">{n.where.kind === 'port' ? `now on ${n.where.port}` : 'unassigned'}</span>
                </button>
              ))}
              <button type="button" class="chip add" onClick={() => go('network', 'new', 'port', port)}><Icon name="plus" size={12} /> New network on {port}</button>
            </div>
          )}
          {choice === 'wan' && oldWan && lanBridge && current !== 'wan' && (
            <label class="check">
              <input type="checkbox" checked={oldWanToLan} onChange={(e) => setOldWanToLan((e.target as HTMLInputElement).checked)} />
              Put the old WAN port <span class="mono">{oldWan.name}</span> into <span class="mono">{lanBridge.name}</span>
            </label>
          )}
          {warnings.map((w) => <div class="note warn"><Icon name="warning" /> {w}</div>)}
          {error ? <ErrorBox error={error} /> : null}
        </section>

        <section>
          <h4 class="section-h">Tagged VLANs <span class="muted small">802.1Q</span></h4>
          {r.tagged.length ? (
            <table class="table">
              <thead><tr><th class="num">VID</th><th>Device</th><th>Network</th><th>Via</th></tr></thead>
              <tbody>
                {r.tagged.map((t) => (
                  <tr class={t.nets.length ? 'clickable' : ''} onClick={() => t.nets[0] && go('network', 'iface', t.nets[0].name)}>
                    <td class="num">{t.vid}</td>
                    <td class="mono">{t.device}</td>
                    <td>{t.nets.length ? t.nets.map((n) => <span class="row nowrap"><Swatch slot={n.slot} /> {n.name}</span>) : <span class="muted">no network</span>}</td>
                    <td class="muted">{t.via ? `${t.via} (all its ports)` : 'this port'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p class="muted small">No VLANs on this port.</p>}
          <div class="row" style={{ marginTop: 'var(--sp-2)' }}>
            <Button icon="plus" onClick={() => go('network', 'new', 'vlan', port)}>Add a VLAN network on {port}</Button>
            {r.untagged?.kind === 'bridge' && (
              <Button variant="ghost" icon="plus" onClick={() => go('network', 'new', 'vlan', (r.untagged as { bridge: string }).bridge)}>… on all of {r.untagged.bridge}</Button>
            )}
          </div>
        </section>
      </div>
    </Drawer>
  )
}
