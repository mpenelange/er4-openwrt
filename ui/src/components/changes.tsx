// Pending changes: the topbar indicator, the review drawer (diff per config), and the
// apply -> confirm countdown. Pages never apply on their own: they stage with uci.set/add/
// remove, and everything goes live from here. Changes that could cut this browser off from the
// router (api/risk.ts) get the countdown; the rest applies in one step.
import { useEffect, useState } from 'preact/hooks'
import { ROLLBACK_SECONDS, uci } from '../api/uci'
import { lockoutRisks } from '../api/risk'
import { emit, on } from '../api/store'
import type { UciChange, UciChanges } from '../api/types'
import { Button, Drawer, Empty, ErrorBox } from './ui'
import { Icon } from './icons'

type Phase = { kind: 'idle' } | { kind: 'armed'; deadline: number } | { kind: 'rolledback' } | { kind: 'lost' }

// Module-level so the countdown survives page navigation
let phase: Phase = { kind: 'idle' }
const phaseSubs = new Set<() => void>()
function setPhase(p: Phase) {
  phase = p
  phaseSubs.forEach((f) => f())
}
function usePhase() {
  const [, force] = useState(0)
  useEffect(() => {
    const f = () => force((n) => n + 1)
    phaseSubs.add(f)
    return () => { phaseSubs.delete(f) }
  }, [])
  return phase
}

function useChanges() {
  const [changes, setChanges] = useState<UciChanges>({})
  useEffect(() => {
    const load = () => uci.changes().then(setChanges, () => {})
    load()
    const a = on('changes', load), b = on('applied', load)
    return () => { a(); b() }
  }, [])
  return changes
}

/** Sections touched: rpcd records one edit as several deltas (a list option is a remove plus a
 *  list-add per item), so counting deltas would overstate what the user changed. */
const countChanges = (c: UciChanges) => Object.values(c).reduce((n, l) => n + new Set(l.map((x) => x[1])).size, 0)

export function ChangesIndicator() {
  const changes = useChanges()
  const p = usePhase()
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (p.kind !== 'armed') return
    const t = setInterval(() => {
      setNow(Date.now())
      if (Date.now() > p.deadline + 2000) {
        // Router rolled back on its own (we never confirmed). Reloading the restored config
        // (and the edits rpcd stages again) has to wait until the router answers: after a
        // network change it needs a few more seconds.
        setPhase({ kind: 'rolledback' })
        whenRouterAnswers().then(() => emit('applied'))
      }
    }, 500)
    return () => clearInterval(t)
  }, [p])

  if (p.kind === 'armed') {
    const left = Math.max(0, Math.ceil((p.deadline - now) / 1000))
    return (
      <div class="changes-bar pending" role="status">
        <Icon name="warning" />
        Changes are live. Keep them? Undoing automatically in <span class="num">{left}s</span>
        <Button variant="primary" icon="check" onClick={confirm}>Keep</Button>
        <Button icon="undo" onClick={rollback}>Undo now</Button>
      </div>
    )
  }
  if (p.kind === 'rolledback' || p.kind === 'lost') {
    return (
      <div class="changes-bar pending" role="status">
        <Icon name="info" />
        {p.kind === 'rolledback' ? 'Not confirmed in time: the router undid the changes. They are staged again to fix or discard.' : 'Lost contact while confirming: the router will undo the changes.'}
        <Button variant="ghost" icon="close" aria-label="Dismiss" onClick={() => setPhase({ kind: 'idle' })} />
      </div>
    )
  }
  const n = countChanges(changes)
  if (!n) return null
  return (
    <>
      <button type="button" class="changes-bar btn" onClick={() => setOpen(true)}>
        <Icon name="edit" /> {n} unapplied change{n > 1 ? 's' : ''} · Review
      </button>
      {open && <ChangesDrawer changes={changes} onClose={() => setOpen(false)} />}
    </>
  )
}

/** Resolves once the router answers again (polls every 2 s, gives up after 3 min). */
async function whenRouterAnswers() {
  for (const end = Date.now() + 180_000; Date.now() < end;) {
    try { await uci.changes(); return } catch { await new Promise((r) => setTimeout(r, 2000)) }
  }
}

async function confirm() {
  try {
    await uci.confirm()
    setPhase({ kind: 'idle' })
  } catch {
    // the router rolls back when the timer runs out; reload once it's reachable again
    setPhase({ kind: 'lost' })
    await whenRouterAnswers()
  }
  emit('applied')
}

async function rollback() {
  try { await uci.rollback() } catch { /* the timer will do it */ }
  setPhase({ kind: 'idle' })
  await whenRouterAnswers()
  emit('applied')
}

function ChangesDrawer({ changes, onClose }: { changes: UciChanges; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  // undefined while the staged network/firewall are read; then why it needs the countdown
  const [risks, setRisks] = useState<string[]>()
  useEffect(() => {
    let alive = true
    const read = (c: string) => (changes[c] ? uci.get(c).catch(() => undefined) : Promise.resolve(undefined))
    Promise.all([read('network'), read('firewall')]).then(([network, firewall]) => alive && setRisks(lockoutRisks(changes, { network, firewall })))
    return () => { alive = false }
  }, [changes])
  const apply = async () => {
    setBusy(true)
    try {
      const safe = risks?.length === 0
      await uci.apply(ROLLBACK_SECONDS, !safe)
      if (safe) emit('applied')
      else setPhase({ kind: 'armed', deadline: Date.now() + ROLLBACK_SECONDS * 1000 })
      onClose()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  const configs = Object.keys(changes)
  return (
    <Drawer title="Review changes" onClose={onClose} footer={
      <>
        <Button variant="danger" icon="undo" disabled={busy} onClick={async () => { await uci.revertAll(); onClose() }}>Discard all</Button>
        <Button variant="primary" icon="check" disabled={busy || !configs.length || !risks} onClick={apply}>Apply</Button>
      </>
    }>
      <p class="secondary" style={{ marginTop: 0 }}>
        {!risks ? 'Checking the changes…'
          : risks.length ? <>These touch {risks.join(', ')}, which could cut this browser off from the router. Applying makes them
            live; you then have {ROLLBACK_SECONDS} s to keep them, and if you don't (or this browser loses the router), the
            router puts everything back by itself.</>
          : 'Applying makes these live at once.'}
      </p>
      {error ? <ErrorBox error={error} /> : null}
      {!configs.length && <Empty>No pending changes</Empty>}
      <div class="diff">
        {configs.map((cfg) => (
          <div key={cfg}>
            <div class="cfg">/etc/config/{cfg}</div>
            {changes[cfg].map((c, i) => <DiffLine key={i} c={c} />)}
            <Button variant="ghost" icon="undo" onClick={() => uci.revert(cfg)}>Discard {cfg} changes</Button>
          </div>
        ))}
      </div>
    </Drawer>
  )
}

function DiffLine({ c }: { c: UciChange }) {
  const [op, section, option, value] = c
  const v = Array.isArray(value) ? value.join(' ') : value
  switch (op) {
    case 'add': return <div class="add">+ section {section} ({option})</div>
    case 'remove': return <div class="del">− {option ? `${section}.${option}` : `section ${section}`}</div>
    // rpcd records a named section's creation as ['set', name, type] (no value)
    case 'set': return value === undefined ? <div class="add">+ section {section} ({option})</div> : <div class="add">~ {section}{option ? `.${option}` : ''} = '{v}'</div>
    case 'list-add': return <div class="add">+ {section}.{option} += '{v}'</div>
    case 'list-del': return <div class="del">− {section}.{option} −= '{v}'</div>
    case 'rename': return <div>~ rename {section} → {option}</div>
    case 'order': return <div>~ move {section} to position {option}</div>
    default: return <div>{op} {section} {option} {v}</div>
  }
}
