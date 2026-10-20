// DHCP address map for one subnet: the dynamic pool as a band with drag handles, leased
// addresses (series 1) and reservations (series 3, taller marks) as ticks, the router as an
// ink tick. Hover a tick for the host; drag a handle (or focus it and use the arrow keys,
// Enter to commit) to move the pool edge. Legend below; the device table is the table view.
import { useEffect, useRef, useState } from 'preact/hooks'
import { hostTail as tail, intToIp, type Subnet } from '../api/net'
import './poolbar.css'

export interface PoolMark { ip: string; label: string }

const host = (s: Subnet, ip: string) => {
  const p = ip.split('.').map(Number)
  return (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) - s.network
}

export function PoolBar({ subnet: s, router, start, limit, leased, reserved, onChange, disabled }: {
  subnet: Subnet
  router?: string
  start: number
  limit: number
  leased: PoolMark[]
  reserved: PoolMark[]
  /** Called once when a drag / key edit ends. Omit for read-only. */
  onChange?: (start: number, limit: number) => void
  disabled?: boolean
}) {
  const max = s.size - 2 // last host offset
  const clampStart = (v: number) => Math.max(1, Math.min(max, v))
  const [edit, setEdit] = useState<{ a: number; b: number } | null>(null)
  const a = edit?.a ?? clampStart(start)
  const b = edit?.b ?? Math.min(max, clampStart(start) + Math.max(1, limit) - 1)
  const track = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null)
  useEffect(() => setEdit(null), [start, limit])

  // max host cells across the track; cell `off` spans [off-1, off] / max
  const pos = (off: number) => `${((off - 1) / max) * 100}%`
  const frac = (clientX: number) => {
    const r = track.current!.getBoundingClientRect()
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width))
  }
  const offAt = (clientX: number) => Math.min(max, Math.floor(frac(clientX) * max) + 1)
  const boundaryAt = (clientX: number) => Math.round(frac(clientX) * max)
  const commit = (e: { a: number; b: number } | null) => {
    if (e && onChange && (e.a !== start || e.b - e.a + 1 !== limit)) onChange(e.a, e.b - e.a + 1)
    else setEdit(null)
  }

  const drag = (which: 'a' | 'b') => (ev: PointerEvent) => {
    if (!onChange || disabled) return
    ev.preventDefault()
    const el = ev.currentTarget as HTMLElement
    el.setPointerCapture(ev.pointerId)
    let cur = { a, b }
    const move = (m: PointerEvent) => {
      const o = boundaryAt(m.clientX)
      cur = which === 'a' ? { a: Math.max(1, Math.min(o + 1, cur.b)), b: cur.b } : { a: cur.a, b: Math.min(max, Math.max(o, cur.a)) }
      setEdit(cur)
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      commit(cur)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }
  const key = (which: 'a' | 'b') => (ev: KeyboardEvent) => {
    const step = ev.shiftKey ? 10 : 1
    const d = ev.key === 'ArrowLeft' || ev.key === 'ArrowDown' ? -step : ev.key === 'ArrowRight' || ev.key === 'ArrowUp' ? step : 0
    if (ev.key === 'Enter') return commit({ a, b })
    if (ev.key === 'Escape') return setEdit(null)
    if (!d) return
    ev.preventDefault()
    const n = which === 'a' ? { a: Math.max(1, Math.min(b, a + d)), b } : { a, b: Math.min(max, Math.max(a, b + d)) }
    setEdit(n)
  }

  const marks = [
    ...leased.map((m) => ({ ...m, kind: 'leased' as const, off: host(s, m.ip) })),
    ...reserved.map((m) => ({ ...m, kind: 'reserved' as const, off: host(s, m.ip) })),
  ].filter((m) => m.off > 0 && m.off <= max)
  const routerOff = router ? host(s, router) : undefined

  const onMove = (ev: MouseEvent) => {
    const r = track.current!.getBoundingClientRect()
    const o = offAt(ev.clientX)
    const tol = Math.max(0, Math.round((4 / r.width) * max))
    const near = marks.filter((m) => Math.abs(m.off - o) <= tol).sort((x, y) => Math.abs(x.off - o) - Math.abs(y.off - o))
    let text: string
    if (routerOff !== undefined && Math.abs(routerOff - o) <= tol) text = `${router} · router`
    else if (near.length) text = near.slice(0, 3).map((m) => `${m.ip} · ${m.label} (${m.kind})`).join('\n')
    else text = `${intToIp(s.network + Math.max(1, Math.min(max, o)))}${o >= a && o <= b ? ' · in pool' : ''}`
    setHover({ x: ev.clientX, y: r.top, text })
  }

  const inPool = marks.filter((m) => m.kind === 'leased' && m.off >= a && m.off <= b).length
  const size = b - a + 1
  return (
    <div class={`poolbar${disabled ? ' disabled' : ''}`}>
      <div class="pb-track" ref={track} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <div class="pb-pool" style={{ left: pos(a), width: `${(size / max) * 100}%` }} />
        {routerOff !== undefined && <div class="pb-router" style={{ left: pos(routerOff + 0.5) }} />}
        {marks.map((m) => <div class={`pb-mark ${m.kind}`} style={{ left: pos(m.off + 0.5) }} />)}
        {onChange && !disabled && (
          <>
            <div class="pb-handle" role="slider" tabIndex={0} aria-label="Pool start" aria-valuemin={1} aria-valuemax={b} aria-valuenow={a}
              aria-valuetext={tail(s, a)} style={{ left: pos(a) }} onPointerDown={drag('a')} onKeyDown={key('a')} onBlur={() => edit && commit(edit)} />
            <div class="pb-handle" role="slider" tabIndex={0} aria-label="Pool end" aria-valuemin={a} aria-valuemax={max} aria-valuenow={b}
              aria-valuetext={tail(s, b)} style={{ left: pos(b + 1) }} onPointerDown={drag('b')} onKeyDown={key('b')} onBlur={() => edit && commit(edit)} />
          </>
        )}
      </div>
      <div class="pb-axis num">
        {a > max * 0.1 && <span style={{ left: 0 }}>{tail(s, 1)}</span>}
        <span class={`pb-edge${edit ? ' editing' : ''}`} style={{ left: pos(a) }}>{tail(s, a)}</span>
        <span class={`pb-edge end${edit ? ' editing' : ''}`} style={{ left: pos(b + 1) }}>{tail(s, b)}</span>
        {b < max * 0.9 && <span style={{ right: 0 }}>{tail(s, max)}</span>}
      </div>
      <div class="pb-legend">
        <span><i class="k pool" /> pool <b class="num">{size}</b> addresses{edit ? ' (release to save)' : ''}</span>
        <span><i class="k leased" /> leased <b class="num">{inPool}</b>{marks.length && inPool < marks.filter((m) => m.kind === 'leased').length ? ` (+${marks.filter((m) => m.kind === 'leased').length - inPool} outside)` : ''}</span>
        <span><i class="k reserved" /> reserved <b class="num">{reserved.length}</b></span>
        {router && <span><i class="k router" /> router <span class="num">{router}</span></span>}
        <span class="muted">{size > 0 ? `${Math.round((100 * inPool) / size)}% of pool in use` : ''}</span>
      </div>
      {hover && <div class="tooltip" style={{ left: hover.x + 12, top: hover.y - 34, whiteSpace: 'pre' }}>{hover.text}</div>}
    </div>
  )
}
