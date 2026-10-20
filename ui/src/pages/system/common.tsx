// Helpers shared by the System tabs.
import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { router, routerClock } from '../../api/router'
import { on } from '../../api/store'
import { uci } from '../../api/uci'
import type { UciChanges } from '../../api/types'
import { Icon } from '../../components/icons'
import { Badge, Button } from '../../components/ui'
import { duration } from '../../components/format'
import { reloadFresh } from '../../api/fresh'

/** Which options of a config have unapplied (staged) changes: has('cfg01e48a', 'hostname'). */
export function useStaged(config: string) {
  const [ch, setCh] = useState<UciChanges>({})
  useEffect(() => {
    const load = () => uci.changes().then(setCh, () => {})
    load()
    const a = on('changes', load), b = on('applied', load)
    return () => { a(); b() }
  }, [])
  const list = ch[config] ?? []
  return {
    has: (section: string, option?: string) => list.some((c) => c[1] === section && (option == null || c[2] === option)),
    any: list.length > 0,
  }
}

export function Unapplied({ show }: { show: boolean }) {
  return show ? <Badge status="accent">unapplied</Badge> : null
}

/**
 * Text input that stages its value on blur / Enter (Escape reverts). `validate` returns an
 * error message or ''. Shows "unapplied" when the option has a staged change.
 */
export function InlineInput({ value, onCommit, validate, placeholder, staged, mono, width, label }: {
  value: string; onCommit: (v: string) => void | Promise<void>; validate?: (v: string) => string; placeholder?: string; staged?: boolean; mono?: boolean; width?: number
  /** accessible name of the input */
  label?: string
}) {
  const [v, setV] = useState(value)
  const [focus, setFocus] = useState(false)
  useEffect(() => { if (!focus) setV(value) }, [value])
  const err = validate?.(v) ?? ''
  const commit = () => { if (v !== value && !err) onCommit(v) }
  return (
    <div class="inline-input">
      <input class={`input${err ? ' invalid' : ''}${mono ? ' mono' : ''}`} value={v} placeholder={placeholder} style={width ? { width } : undefined} aria-label={label}
        onInput={(e) => setV((e.target as HTMLInputElement).value)}
        onFocus={() => setFocus(true)}
        onBlur={() => { setFocus(false); commit() }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') { setV(value); setTimeout(() => (e.target as HTMLInputElement).blur()) }
        }} />
      {err ? <span class="field-error">{err}</span> : <Unapplied show={!!staged} />}
    </div>
  )
}

/** A settings row: label + one-line explanation on the left, control on the right. */
export function SettingRow({ label, hint, children, badges, dim }: { label: ComponentChildren; hint?: ComponentChildren; children: ComponentChildren; badges?: ComponentChildren; dim?: boolean }) {
  return (
    <div class={`setting-row${dim ? ' dim' : ''}`}>
      <div class="setting-text">
        <div class="setting-label">{label}{badges}</div>
        {hint && <div class="setting-hint">{hint}</div>}
      </div>
      <div class="setting-control">{children}</div>
    </div>
  )
}

/** Drop a file here or click to choose. */
export function Dropzone({ accept, onFile, title, hint, disabled }: { accept?: string; onFile: (f: File) => void; title: ComponentChildren; hint?: ComponentChildren; disabled?: boolean }) {
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  return (
    <div class={`dropzone${over ? ' over' : ''}${disabled ? ' disabled' : ''}`} role="button" tabIndex={0}
      onClick={() => !disabled && input.current?.click()}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && !disabled && input.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const f = e.dataTransfer?.files[0]
        if (f && !disabled) onFile(f)
      }}>
      <Icon name="upload" size={20} />
      <div>
        <div class="dz-title">{title}</div>
        {hint && <div class="dz-hint">{hint}</div>}
      </div>
      <input ref={input} type="file" accept={accept} hidden onChange={(e) => {
        const f = (e.target as HTMLInputElement).files?.[0]
        if (f) onFile(f)
        ;(e.target as HTMLInputElement).value = ''
      }} />
    </div>
  )
}

/**
 * Full-screen wait while the router reboots: polls system.board until it answers again.
 * On the real router the session is gone after a reboot, so the app drops to the login page.
 */
export function RebootWait({ reason, expect = 90 }: { reason: string; expect?: number }) {
  const [t0] = useState(Date.now())
  const [now, setNow] = useState(Date.now())
  const [seenDown, setSeenDown] = useState(false)
  const [back, setBack] = useState<string>()
  useEffect(() => {
    let alive = true
    let timer: number
    const seenDownRef = { current: false }
    const poll = async () => {
      setNow(Date.now())
      try {
        const b = await router.board()
        if (!alive) return
        if (seenDownRef.current || Date.now() - t0 > 20000) { setBack(`${b.release.distribution} ${b.release.version}`); return }
      } catch {
        seenDownRef.current = true
        setSeenDown(true)
      }
      if (alive) timer = window.setTimeout(poll, 2000)
    }
    timer = window.setTimeout(poll, 1500)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => { alive = false; clearTimeout(timer); clearInterval(tick) }
  }, [])
  const el = Math.round((now - t0) / 1000)
  return (
    <div class="reboot-wait" role="alertdialog" aria-live="polite">
      <div class="card reboot-card">
        <div class="card-head"><Icon name="power" size={14} /><h3>{reason}</h3></div>
        <div class="card-body stack">
          {back ? (
            <>
              <div class="row"><Badge status="good">back online</Badge><span>{back} · after {duration(el)}</span></div>
              <Button variant="primary" icon="check" onClick={reloadFresh}>Reload</Button>
            </>
          ) : (
            <>
              <div class="row"><Badge status="warning">{seenDown ? 'restarting' : 'going down'}</Badge><span class="num">{duration(el)}</span><span class="muted">usually ~{expect} s</span></div>
              <div class="reboot-progress"><div style={{ width: `${Math.min(95, (el / expect) * 100)}%` }} /></div>
              <p class="secondary" style={{ margin: 0 }}>
                The router is unreachable while it restarts. This page reconnects by itself; if the address changed, open the new one.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export const fmtDate = (s?: number) => (s ? new Date(s * 1000).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '–')
export const ago = (s?: number) => (s ? `${duration(Date.now() / 1000 - s)} ago` : '')
/** ago() for a timestamp taken by the router's clock (install times, backups made on it). */
export const agoRouter = (s?: number) => (s ? `${duration(Math.max(0, routerClock.now() - s))} ago` : '')
