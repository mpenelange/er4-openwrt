// System: #/system[/general|admin|ssh|services|cron|offload|firmware|maintenance]
import { useState } from 'preact/hooks'
import type { PageProps } from '../../app'
import { router } from '../../api/router'
import { useAsync } from '../../api/store'
import { system } from '../../api/system'
import { MockMenu } from '../../components/mockmenu'
import { Tabs } from '../../components/readouts'
import { Button, ErrorBox, Modal, PageHead } from '../../components/ui'
import { Admin } from './admin'
import { Ssh } from './ssh'
import { Services } from './services'
import { Cron } from './cron'
import { RebootWait, useStaged } from './common'
import { Firmware } from './firmware'
import { General } from './general'
import { Maintenance } from './maintenance'
import { Offload } from './offload'
import './system.css'

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'admin', label: 'Admin' },
  { id: 'ssh', label: 'SSH' },
  { id: 'services', label: 'Services' },
  { id: 'cron', label: 'Scheduled tasks' },
  { id: 'offload', label: 'Hardware offload' },
  { id: 'firmware', label: 'Firmware' },
  { id: 'maintenance', label: 'Backup & reboot' },
] as const

export default function System({ path }: PageProps) {
  // Sub-route; tolerate a "?scenario=…" query in the hash (mock flags)
  const sub = (path[0] ?? 'general').split('?')[0]
  const tab = TABS.find((t) => t.id === sub)?.id ?? 'general'
  const board = useAsync(router.board, [], [])
  const sysStaged = useStaged('system')
  const offStaged = useStaged('offload')
  const sshStaged = useStaged('dropbear')
  const dot = <span class="tab-dot" title="unapplied changes" />
  return (
    <div class="page system-page">
      <PageHead title="System">
        {board.data && <span class="muted">{board.data.hostname} · {board.data.model} · {board.data.release.distribution} {board.data.release.version}</span>}
        <MockMenu />
        <RebootButton />
      </PageHead>
      <Tabs active={tab} tabs={TABS.map((t) => ({
        id: t.id, label: t.label, href: `#/system/${t.id}`,
        badge: (t.id === 'general' && sysStaged.any) || (t.id === 'offload' && offStaged.any) || (t.id === 'ssh' && sshStaged.any) ? dot : undefined,
      }))} />
      {tab === 'general' && <General />}
      {tab === 'admin' && <Admin />}
      {tab === 'ssh' && <Ssh />}
      {tab === 'services' && <Services />}
      {tab === 'cron' && <Cron />}
      {tab === 'offload' && <Offload />}
      {tab === 'firmware' && <Firmware />}
      {tab === 'maintenance' && <Maintenance />}
    </div>
  )
}

function RebootButton() {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [err, setErr] = useState<unknown>()
  if (done) return <RebootWait reason="Rebooting" />
  return (
    <>
      <Button icon="power" onClick={() => setOpen(true)}>Reboot…</Button>
      {open && (
        <Modal title="Reboot the router?" onClose={() => setOpen(false)} footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" icon="power" disabled={busy} onClick={async () => {
              setBusy(true)
              try { await system.reboot(); setDone(true) } catch (e) { setErr(e) } finally { setBusy(false) }
            }}>{busy ? 'Rebooting…' : 'Reboot now'}</Button>
          </>
        }>
          <p style={{ margin: 0 }}>The router and everything behind it is offline for about 90 s. Unapplied changes are lost.</p>
          {err ? <ErrorBox error={err} /> : null}
        </Modal>
      )}
    </>
  )
}
