// Tiny event bus + hooks. Pages re-fetch on the events they care about ('changes' after any
// UCI write, 'applied' after apply/confirm/rollback) instead of sharing a global store.
import { useEffect, useRef, useState } from 'preact/hooks'

type Topic = 'changes' | 'applied' | 'clock' | 'iface' // clock: routerClock measured the router's time; iface: an interface was started/stopped
const subs = new Map<Topic, Set<() => void>>()
const version = new Map<Topic, number>()

export function emit(topic: Topic) {
  version.set(topic, (version.get(topic) ?? 0) + 1)
  subs.get(topic)?.forEach((fn) => fn())
}

export function on(topic: Topic, fn: () => void) {
  if (!subs.has(topic)) subs.set(topic, new Set())
  subs.get(topic)!.add(fn)
  return () => subs.get(topic)!.delete(fn)
}

/** Re-render the caller when an event fires (e.g. 'clock', for "x ago" against router time). */
export function useEvent(topic: Topic) {
  const [, force] = useState(0)
  const seen = version.get(topic) ?? 0
  useEffect(() => {
    const off = on(topic, () => force((n) => n + 1))
    // an event between this render and the subscription would be missed: catch up
    if ((version.get(topic) ?? 0) !== seen) force((n) => n + 1)
    return off
  }, [topic])
}

export interface Async<T> {
  data: T | undefined
  error: Error | undefined
  loading: boolean
  reload: () => void
}

/** Run an async loader, re-run it on the given topics and when deps change. */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[] = [], topics: Topic[] = ['changes', 'applied']): Async<T> {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true })
  const gen = useRef(0)
  const run = () => {
    const g = ++gen.current
    setState((s) => ({ ...s, loading: true }))
    load().then(
      (data) => g === gen.current && setState({ data, loading: false }),
      (error) => g === gen.current && setState((s) => ({ ...s, error, loading: false })),
    )
  }
  useEffect(() => {
    run()
    const offs = topics.map((t) => on(t, run))
    return () => offs.forEach((off) => off())
  }, deps)
  return { ...state, reload: run } as Async<T>
}

/** Poll an async source every `ms`, keeping the last `keep` samples (oldest first). */
export function usePoll<T>(load: () => Promise<T>, ms: number, keep = 1): { samples: T[]; error?: Error } {
  const [state, setState] = useState<{ samples: T[]; error?: Error }>({ samples: [] })
  useEffect(() => {
    let alive = true
    let timer: number | undefined
    const tick = async () => {
      try {
        const v = await load()
        if (alive) setState((s) => ({ samples: [...s.samples, v].slice(-keep) }))
      } catch (error) {
        if (alive) setState((s) => ({ ...s, error: error as Error }))
      }
      if (alive) timer = window.setTimeout(tick, ms)
    }
    tick()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [ms, keep])
  return state
}
