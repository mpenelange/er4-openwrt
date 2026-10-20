// Live traffic of one network device (br-lan, a VLAN, wg0, pppoe-wan...), polled from
// network.device status while it is on screen: the last two minutes, like LuCI's realtime graph.
import { useEffect, useState } from 'preact/hooks'
import { router } from '../api/router'
import { TimeSeries } from './charts'
import { bps } from './format'

const EVERY = 2000
const KEEP = 60

export function LiveTraffic({ device, slot = 1, inLabel = 'in', outLabel = 'out' }: { device: string; slot?: number; inLabel?: string; outLabel?: string }) {
  const [pts, setPts] = useState<{ t: number; rx: number; tx: number }[]>([])
  const [err, setErr] = useState<string>()
  useEffect(() => {
    setPts([])
    setErr(undefined)
    let alive = true, timer = 0
    const tick = async () => {
      try {
        const s = await router.device(device)
        if (!alive) return
        if (!s?.statistics) setErr('no counters')
        else setPts((p) => [...p, { t: Date.now() / 1000, rx: s.statistics.rx_bytes, tx: s.statistics.tx_bytes }].slice(-(KEEP + 1)))
      } catch (e) {
        if (alive) setErr((e as Error).message)
      }
      if (alive) timer = window.setTimeout(tick, EVERY)
    }
    tick()
    return () => { alive = false; clearTimeout(timer) }
  }, [device])
  if (err) return <p class="muted small" style={{ margin: 0 }}>No traffic counters for {device} ({err}).</p>
  // rates between samples; a counter reset (device recreated) gives no point, not a spike
  const t: number[] = [], rx: (number | null)[] = [], tx: (number | null)[] = []
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], dt = b.t - a.t
    t.push(b.t)
    rx.push(b.rx >= a.rx && dt > 0 ? ((b.rx - a.rx) * 8) / dt : null)
    tx.push(b.tx >= a.tx && dt > 0 ? ((b.tx - a.tx) * 8) / dt : null)
  }
  if (t.length < 2) return <p class="muted small" style={{ margin: 0 }}>Measuring {device}…</p>
  return <TimeSeries times={t} format={bps} height={120} series={[
    { label: inLabel, slot, values: rx },
    { label: outLabel, slot: slot === 2 ? 1 : 2, values: tx },
  ]} />
}
