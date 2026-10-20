// Dashboard: live overview. Front panel + WAN on top, throughput in the middle,
// system below. Live rates come from one shared er4.stats poll (live.ts).
import { useState } from 'preact/hooks'
import type { PageProps } from '../../app'
import type { HistoryWindow } from '../../api/dashboard'
import { router } from '../../api/router'
import { useAsync, usePoll } from '../../api/store'
import { uci } from '../../api/uci'
import { TimeSeries } from '../../components/charts'
import { bps, pps } from '../../components/format'
import { Icon } from '../../components/icons'
import { MockMenu } from '../../components/mockmenu'
import { Badge, Card, ErrorBox, PageHead, Segmented } from '../../components/ui'
import { dnsModel } from '../../api/dns'
import { SystemCard, WanCard } from './cards'
import { PORTS, useLive, useWindow } from './live'
import { FrontPanel, portRoles } from './panel'
import './dashboard.css'

type Dir = 'rx' | 'tx'
type Unit = 'bps' | 'pps'

function useStored<T extends string | number>(key: string, init: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    const s = localStorage.getItem(key)
    return s == null ? init : ((typeof init === 'number' ? Number(s) : s) as T)
  })
  return [v, (x: T) => { localStorage.setItem(key, String(x)); setV(x) }]
}

export default function Dashboard(_props: PageProps) {
  const live = useLive()
  const devices = usePoll(router.devices, 5000)
  const ifaces = usePoll(router.interfaces, 10000)
  const info = usePoll(router.info, 5000)
  const board = useAsync(router.board, [], [])
  const net = useAsync(() => uci.get('network'), [], ['applied'])
  const dhcp = useAsync(() => uci.get('dhcp'), [], ['applied'])
  const roles = portRoles(net.data)
  const dev = devices.samples[0]

  return (
    <div class="page dashboard">
      <PageHead title="Dashboard">
        {live.error
          ? <Badge status="critical">live stats unavailable</Badge>
          : live.loading ? <Badge>connecting…</Badge> : <Badge status="good">live · 2 s</Badge>}
        <MockMenu />
      </PageHead>
      {live.error && !live.samples.length && <ErrorBox error={`No live statistics: ${live.error.message}. Link states, WAN and devices still work.`} />}

      <div class="dash-grid">
        <Card class="span-8 panel-card" title="Ports">
          {devices.error && !dev ? <ErrorBox error={devices.error} /> : (
            <FrontPanel devices={dev} roles={roles} latest={live.latest} />
          )}
        </Card>
        <div class="span-4"><WanCard ifaces={ifaces.samples[0]} dns={dhcp.data && dnsModel(dhcp.data, [])} eth0={dev?.eth0} rate={live.latest?.ports.eth0} error={!ifaces.samples[0] ? ifaces.error : undefined} /></div>

        <div class="span-12"><Throughput /></div>

        <div class="span-12"><SystemCard board={board.data} info={info.samples[0]} rates={live.rates} latest={live.latest} error={!info.samples[0] ? info.error : undefined} /></div>
      </div>
    </div>
  )
}

const WINDOWS: { value: string; label: string }[] = [
  { value: '300', label: '5 min' },
  { value: '3600', label: '1 h' },
  { value: '86400', label: '24 h' },
]

const axisFmt = (f: (v: number) => string) => (v: number) => (v === 0 ? '0' : f(v))

function Throughput() {
  const [win, setWin] = useStored<HistoryWindow>('er4.dash.window', 300)
  const [dir, setDir] = useStored<Dir>('er4.dash.dir', 'rx')
  const [unit, setUnit] = useStored<Unit>('er4.dash.unit', 'bps')
  const d = useWindow(win)
  const pick = (p: string) => d.rates.map((r) => {
    const x = r?.ports[p]
    if (!x) return null
    return unit === 'bps' ? (dir === 'rx' ? x.rxBps : x.txBps) : (dir === 'rx' ? x.rxPps : x.txPps)
  })
  const series = PORTS.map((p, i) => ({ label: p, slot: i + 1, values: pick(p) }))
  return (
    <Card class="chart-card" title={<><Icon name="network" size={13} class="head-icon" /> Throughput per port</>} actions={
      <div class="row chart-controls">
        <Segmented value={dir} onChange={setDir} options={[{ value: 'rx', label: 'Received' }, { value: 'tx', label: 'Sent' }]} />
        <Segmented value={unit} onChange={setUnit} options={[{ value: 'bps', label: 'bit/s' }, { value: 'pps', label: 'pkt/s' }]} />
        <Segmented value={String(win)} onChange={(v) => setWin(Number(v) as HistoryWindow)} options={WINDOWS} />
      </div>
    }>
      {d.error && !d.times.length ? <ErrorBox error={d.error} />
        : d.loading && !d.times.length ? <div class="chart-placeholder muted">Loading…</div>
        : (
          <div class={d.loading ? 'refetching' : ''}>
            <TimeSeries times={d.times} series={series} height={196} format={axisFmt(unit === 'bps' ? bps : pps)} />
          </div>
        )}
    </Card>
  )
}
