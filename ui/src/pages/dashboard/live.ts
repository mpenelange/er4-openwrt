// Live data for the dashboard: one er4.stats poll (2 s) feeding a 5-minute buffer that is
// seeded from er4.history and survives navigation (module level), plus coarser history for
// the 1 h / 24 h windows. Pages read derived rate series, never raw counters.
import { useEffect, useState } from 'preact/hooks'
import { history, type HistoryWindow } from '../../api/dashboard'
import { rates, router } from '../../api/router'
import type { Er4Stats } from '../../api/types'
import { UBUS_STATUS, UbusError } from '../../api/ubus'

/** Readable error for a missing plugin method. */
export function explain(e: unknown): Error {
  if (e instanceof UbusError && e.code === UBUS_STATUS.METHOD_NOT_FOUND) return new Error(`${e.object}.${e.method} is not available: the ER-4 rpcd plugin is missing or too old`)
  return e as Error
}

export const PORTS = ['eth0', 'eth1', 'eth2', 'eth3'] as const // categorical slots 1-4, fixed per port
const LIVE_MS = 2000
const LIVE_KEEP = 151

type Rate = ReturnType<typeof rates>

export interface Derived {
  /** Unix seconds, one per interval (end of interval). */
  times: number[]
  /** null where there's a gap (missed polls, router restart). */
  rates: (Rate | null)[]
  samples: Er4Stats[]
}

const live: { samples: Er4Stats[]; seeded: boolean; error?: Error; loading: boolean } = { samples: [], seeded: false, loading: true }
const hist: Partial<Record<HistoryWindow, { at: number; data: Er4Stats[]; step: number }>> = {}
const subs = new Set<() => void>()
const notify = () => subs.forEach((f) => f())
let timer: number | undefined
let users = 0

async function tick() {
  try {
    if (!live.seeded || (live.samples.length && Date.now() - live.samples[live.samples.length - 1].time > 15000)) {
      // First open, or back after a while: seed from the router's own buffer
      try {
        const h = await history(300)
        live.samples = h.samples
      } catch {
        live.samples = live.seeded ? live.samples : []
      }
      live.seeded = true
    }
    const s = await router.stats()
    live.samples = [...live.samples, s].slice(-LIVE_KEEP)
    live.error = undefined
  } catch (e) {
    live.error = explain(e)
  }
  live.loading = false
  notify()
  if (users > 0) timer = window.setTimeout(tick, LIVE_MS)
}

function start() {
  if (users++ === 0) tick()
}
function stop() {
  if (--users === 0) {
    clearTimeout(timer)
    timer = undefined
  }
}

function derive(samples: Er4Stats[], step: number): Derived {
  const times: number[] = []
  const out: (Rate | null)[] = []
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i]
    const gap = b.time - a.time > step * 1000 * 3 || b.offload.flow_found < a.offload.flow_found
    times.push(b.time / 1000)
    out.push(gap ? null : rates(a, b))
  }
  return { times, rates: out, samples }
}

/** Subscribe to the live poll. `latest` is the most recent interval's rates. */
export function useLive() {
  const [, force] = useState(0)
  useEffect(() => {
    const f = () => force((n) => n + 1)
    subs.add(f)
    start()
    return () => { subs.delete(f); stop() }
  }, [])
  const d = derive(live.samples, LIVE_MS / 1000)
  const latest = [...d.rates].reverse().find((r) => r) ?? undefined
  return { ...d, latest, error: live.error, loading: live.loading && !live.samples.length }
}

/** Series for a chart window: the live buffer for 5 min, router history for longer windows. */
export function useWindow(win: HistoryWindow) {
  const lv = useLive()
  const [, force] = useState(0)
  const [error, setError] = useState<Error>()
  useEffect(() => {
    if (win === 300) return
    let alive = true
    let t: number | undefined
    const load = async () => {
      const cached = hist[win]
      const ttl = win === 3600 ? 30000 : 240000
      if (!cached || Date.now() - cached.at > ttl) {
        try {
          const h = await history(win)
          hist[win] = { at: Date.now(), data: h.samples, step: h.step }
          setError(undefined)
        } catch (e) {
          setError(explain(e))
        }
      }
      if (alive) { force((n) => n + 1); t = window.setTimeout(load, 10000) }
    }
    load()
    return () => { alive = false; clearTimeout(t) }
  }, [win])
  if (win === 300) return { ...lv, step: LIVE_MS / 1000 }
  const h = hist[win]
  if (!h) return { times: [], rates: [], samples: [], latest: lv.latest, error: error ?? lv.error, loading: !error, step: 0 }
  return { ...derive(h.data, h.step), latest: lv.latest, error, loading: false, step: h.step }
}
