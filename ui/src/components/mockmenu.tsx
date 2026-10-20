// Dev-only: switch the mock router into edge states (WAN down, no link, errors, slow ...).
// Renders nothing against a real router.
import { useState } from 'preact/hooks'
import { isMock } from '../api/client'
import { activeScenarios, SCENARIOS, setStoredScenarios, storedScenarios } from '../api/mock/scenario'
import { Button, Modal, Toggle } from './ui'

export function MockMenu() {
  const [open, setOpen] = useState(false)
  const [list, setList] = useState(storedScenarios)
  if (!isMock) return null
  const active = activeScenarios()
  const set = (name: string, on: boolean) => {
    const next = on ? [...list, name] : list.filter((x) => x !== name)
    setList(next)
    setStoredScenarios(next)
  }
  return (
    <>
      <Button variant="ghost" icon="info" title="Mock scenarios (dev)" onClick={() => setOpen(true)}>
        mock{active.size ? ` · ${active.size}` : ''}
      </Button>
      {open && (
        <Modal title="Mock scenarios" onClose={() => setOpen(false)} footer={
          <Button onClick={() => { setList([]); setStoredScenarios([]) }}>Clear all</Button>
        }>
          <p class="secondary" style={{ marginTop: 0 }}>
            Edge states of the mock router; they apply from the next poll. Also settable in the URL:
            <code> ?mock&scenario=wan-down,eth2-nolink</code> or <code>#/dashboard?scenario=…</code>
          </p>
          <div class="stack">
            {Object.entries(SCENARIOS).map(([k, label]) => (
              <label class="row" style={{ gap: 'var(--sp-3)' }}>
                <Toggle on={list.includes(k)} label={k} onChange={(v) => set(k, v)} />
                <code style={{ minWidth: '120px' }}>{k}</code>
                <span class="secondary">{label}</span>
                {active.has(k) && !list.includes(k) && <span class="muted">(from URL)</span>}
              </label>
            ))}
          </div>
        </Modal>
      )}
    </>
  )
}
