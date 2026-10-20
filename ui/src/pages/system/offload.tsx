// System > Hardware offload: UCI 'offload.global' toggles (staged) next to the live state
// (er4.offload) and the live fast-path figures.
import { router } from '../../api/router'
import { useAsync, usePoll } from '../../api/store'
import type { Er4Offload } from '../../api/types'
import { uci } from '../../api/uci'
import { count, pct, pps } from '../../components/format'
import { KV, SplitBar } from '../../components/readouts'
import { Trend } from '../../components/trend'
import { Badge, Card, ErrorBox, Toggle } from '../../components/ui'
import { useLive } from '../dashboard/live'
import { Unapplied, useStaged } from './common'

type Opt = 'enabled' | 'ipv4' | 'ipv6' | 'vlan' | 'pppoe' | 'stats'

const OPTIONS: { key: Opt; label: string; hint: string; untested?: boolean; live: (o: Er4Offload) => boolean }[] = [
  { key: 'enabled', label: 'Hardware offload', hint: 'Master switch. Established flows are forwarded by the ethernet driver\'s fast path instead of the Linux stack. Off: every packet goes through the CPU.', live: (o) => o.loaded },
  { key: 'ipv4', label: 'IPv4 flows', hint: 'Offload routed and NATed IPv4 TCP/UDP once conntrack marks them established.', live: (o) => o.ipv4 },
  { key: 'ipv6', label: 'IPv6 flows', hint: 'Offload routed IPv6 TCP/UDP. Off by default: not validated on the ER-4 yet.', untested: true, live: (o) => o.ipv6 },
  { key: 'vlan', label: 'VLAN-tagged flows', hint: 'Also offload flows on 802.1Q sub-interfaces (e.g. br-lan.30, the IoT network).', live: (o) => o.vlan },
  { key: 'pppoe', label: 'PPPoE sessions', hint: 'Offload flows inside a PPPoE WAN session (encap/decap in the fast path). Off by default: not validated yet.', untested: true, live: (o) => o.pppoe },
  { key: 'stats', label: 'Fast-path statistics', hint: 'Count fast-path hits and misses (the hit rate on this page and the dashboard). Costs about 3 points of CPU at 790k packets/s of minimum-size packets; negligible at normal sizes.', live: (o) => o.stats },
]

export function Offload() {
  const cfg = useAsync(() => uci.section('offload', 'global'))
  const state = usePoll(router.offload, 3000)
  const staged = useStaged('offload')
  const live = useLive()
  const o = state.samples[0]
  const g = cfg.data
  const master = g?.enabled === '1'

  return (
    <div class="sys-cols wide-left">
      <Card title="Offload settings" actions={<span class="muted">/etc/config/offload · global</span>} flush>
        {cfg.error ? <div class="card-body"><ErrorBox error={cfg.error} /></div> : !g ? <div class="card-body muted">Loading…</div> : (
          <table class="table offload-table">
            <thead>
              <tr><th style={{ width: 44 }} /><th>Setting</th><th style={{ width: 120 }}>Running now</th></tr>
            </thead>
            <tbody>
              {OPTIONS.map((opt) => {
                const on = g[opt.key] === '1'
                const sub = opt.key !== 'enabled'
                const dim = sub && !master
                const liveOn = o ? opt.live(o) : undefined
                const pending = staged.has('global', opt.key)
                return (
                  <tr class={dim ? 'disabled' : ''}>
                    <td><Toggle on={on} label={opt.label} disabled={dim} onChange={(v) => uci.set('offload', 'global', { [opt.key]: v ? '1' : '0' })} /></td>
                    <td class="wrap">
                      <div class="setting-label">
                        {opt.label}
                        <code class="muted">{opt.key}</code>
                        {opt.untested && <Badge status="warning">untested</Badge>}
                        <Unapplied show={pending} />
                      </div>
                      <div class="setting-hint">{opt.hint}</div>
                      {opt.untested && on && !dim && (
                        <div class="setting-note">
                          Not validated on this hardware. After Apply, check that traffic still flows; if it doesn't, don't confirm and the router undoes it within 60 s.
                        </div>
                      )}
                    </td>
                    <td>
                      {liveOn === undefined ? <span class="muted">…</span>
                        : liveOn ? <Badge status="good">on</Badge> : <Badge>off</Badge>}
                      {liveOn !== undefined && liveOn !== (on && (!sub || master)) && <div class="muted small">{pending ? 'changes on apply' : 'differs from config'}</div>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Card>
      <div class="stack-3">
        <LiveCard o={o} error={state.error} live={live} />
        <Card title="How it works">
          <ol class="plain-list numbered secondary">
            <li>The first packets of a connection go through the Linux stack: firewall (fw4), NAT, routing.</li>
            <li>Once a packet of the flow has made it through the Linux path, the driver caches the flow; later packets are forwarded by the ethernet driver directly. Rules that need to see every packet (limits, logging) keep their flows off the fast path.</li>
            <li>A firewall, route or interface change flushes the cache (an <em>invalidation</em>): flows re-learn on their next packet, nothing is dropped.</li>
          </ol>
        </Card>
      </div>
    </div>
  )
}

function LiveCard({ o, error, live }: { o?: Er4Offload; error?: Error; live: ReturnType<typeof useLive> }) {
  const s = live.samples
  const a = s[s.length - 2], b = s[s.length - 1]
  const dt = a && b ? (b.time - a.time) / 1000 : 1
  const fast = a && b ? (b.offload.flow_found - a.offload.flow_found) / dt : NaN
  const slow = a && b ? (b.offload.flow_not_found - a.offload.flow_not_found) / dt : NaN
  const idle = !(fast + slow > 0)
  return (
    <Card title="Live" actions={o ? (o.loaded ? <Badge status="good">loaded</Badge> : <Badge status="warning">not loaded</Badge>) : null}>
      {error && !o ? <ErrorBox error={error} /> : !o ? <div class="muted">Loading…</div> : (
        <div class="stack-3">
          {o.loaded && !live.error ? (
            <>
              <div class="offload-share-sm">
                <span class="value">{idle ? '–' : pct((100 * fast) / (fast + slow), 1)}</span>
                <span class="secondary">of forwarded packets on the fast path</span>
              </div>
              <SplitBar parts={[
                { value: idle ? 0 : fast, label: <>Fast path <b class="num">{pps(idle ? 0 : fast)}</b></> },
                { value: idle ? 0 : slow, neutral: true, label: <>Linux stack <b class="num">{pps(idle ? 0 : slow)}</b></> },
              ]} />
              <div class="row" style={{ justifyContent: 'space-between' }}>
                <span class="muted small">fast path · 5 min</span>
                <div style={{ width: '160px' }}><Trend values={live.rates.map((r) => (r ? r.offloadPps : null))} color="--accent" height={22} fill /></div>
              </div>
            </>
          ) : live.error ? <ErrorBox error={live.error} /> : (
            <p class="secondary" style={{ margin: 0 }}>The fast path is not loaded; all forwarding uses the CPU. Turn on <b>Hardware offload</b> and apply.</p>
          )}
          <KV rows={[
            ['Flow cache', <span class="num">{count(o.cache_size)} entries</span>],
            ['Forward queue', <span class="num">{o.fwd_queue_depth}</span>],
            b && ['Conntrack', <span class="num">{count(b.conntrack.count)} / {count(b.conntrack.max)}</span>],
            b && ['Invalidations', <span class="num">{count(b.offload.invalidations)} since boot</span>],
          ]} />
        </div>
      )}
    </Card>
  )
}
