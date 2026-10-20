// System > Backup & reboot: download/restore the /etc config, reboot, factory reset.
// These act immediately (they aren't UCI changes), so each one confirms first.
import { useState } from 'preact/hooks'
import { router } from '../../api/router'
import { useAsync, usePoll } from '../../api/store'
import { BACKUP_PATH, downloadBackup, system, upload, type ConfigInspect } from '../../api/system'
import { duration } from '../../components/format'
import { Meter } from '../../components/readouts'
import { Badge, Button, Card, ErrorBox, Modal } from '../../components/ui'
import { agoRouter, Dropzone, fmtDate, RebootWait } from './common'

export function Maintenance() {
  const board = useAsync(router.board, [], [])
  const info = usePoll(router.info, 5000)
  const configs = useAsync(system.configs, [], [])
  const [rebooting, setRebooting] = useState<string>()
  const [confirm, setConfirm] = useState<'reboot' | 'restore' | 'reset'>()
  const [backupBusy, setBackupBusy] = useState(false)
  const [backupMsg, setBackupMsg] = useState<string>()
  const [backupErr, setBackupErr] = useState<unknown>()
  const [restore, setRestore] = useState<{ name: string; p: number; inspect?: ConfigInspect; error?: string }>()
  const [actionErr, setActionErr] = useState<unknown>()
  const [typed, setTyped] = useState('')
  const host = board.data?.hostname ?? 'er4'

  const doBackup = async () => {
    setBackupBusy(true)
    setBackupErr(undefined)
    try {
      await downloadBackup(host)
      setBackupMsg(`Downloaded at ${new Date().toLocaleTimeString()}`)
    } catch (e) { setBackupErr(e) } finally { setBackupBusy(false) }
  }

  const onRestoreFile = async (f: File) => {
    setRestore({ name: f.name, p: 0 })
    try {
      await upload(f, BACKUP_PATH, (p) => setRestore({ name: f.name, p }))
      const inspect = await system.configInspect(BACKUP_PATH)
      setRestore({ name: f.name, p: 1, inspect })
    } catch (e) {
      setRestore({ name: f.name, p: 1, error: (e as Error).message })
    }
  }

  const run = async (what: 'reboot' | 'restore' | 'reset') => {
    setConfirm(undefined)
    setActionErr(undefined)
    // the wait screen first: the router may go down before its answer gets here
    setRebooting(what === 'reboot' ? 'Rebooting' : what === 'restore' ? 'Restoring settings and rebooting' : 'Resetting to defaults and rebooting')
    try {
      if (what === 'reboot') await system.reboot()
      if (what === 'restore') await system.configRestore(BACKUP_PATH)
      if (what === 'reset') await system.factoryReset()
    } catch (e) { setRebooting(undefined); setActionErr(e) }
  }

  return (
    <div class="sys-cols">
      {rebooting && <RebootWait reason={rebooting} />}
      <div class="stack-3">
        <Card title="Backup">
          <div class="stack-3">
            <p class="secondary" style={{ margin: 0 }}>
              A <code>.tar.gz</code> of the settings (what <code>sysupgrade -b</code> saves): everything under /etc/config plus
              passwords, SSH keys and files listed in /etc/sysupgrade.conf. It contains secrets (WireGuard keys,
              password hashes): keep it somewhere safe.
            </p>
            {configs.data && (
              <div class="config-chips">
                {configs.data.map((c) => <code class="chip">{c}</code>)}
              </div>
            )}
            <div class="row">
              <Button variant="primary" icon="download" disabled={backupBusy} onClick={doBackup}>{backupBusy ? 'Preparing…' : 'Download backup'}</Button>
              {backupMsg && <Badge status="good">{backupMsg}</Badge>}
            </div>
            {backupErr ? <ErrorBox error={backupErr} /> : null}
          </div>
        </Card>

        <Card title="Restore">
          {!restore ? (
            <Dropzone accept=".tar.gz,.tgz,application/gzip" onFile={onRestoreFile}
              title="Drop a backup here, or click to choose" hint="You'll see what's in it before anything changes" />
          ) : !restore.inspect && !restore.error ? (
            <div class="stack">
              <div class="row"><span>{restore.p < 1 ? `Uploading ${restore.name}` : `Reading ${restore.name}`}</span><span class="spacer" /><span class="num muted">{Math.round(restore.p * 100)}%</span></div>
              <Meter value={restore.p} label="Upload" />
            </div>
          ) : restore.error || !restore.inspect?.valid ? (
            <div class="stack-3">
              <ErrorBox error={restore.error ?? restore.inspect?.error ?? 'Not a valid backup'} />
              <div class="row"><span class="secondary">Nothing was changed.</span><Button onClick={() => setRestore(undefined)}>Choose another file</Button></div>
            </div>
          ) : (
            <div class="stack-3">
              <div class="row">
                <Badge status="good">valid backup</Badge>
                <span>of <b>{restore.inspect.hostname}</b>, OpenWrt {restore.inspect.version}, made {fmtDate(restore.inspect.created)} <span class="muted">({agoRouter(restore.inspect.created)})</span></span>
              </div>
              <div class="file-list mono">
                {restore.inspect.files.map((f) => <div>{f}</div>)}
              </div>
              <div class="row">
                <Button variant="primary" icon="upload" onClick={() => setConfirm('restore')}>Restore and reboot</Button>
                <Button variant="ghost" onClick={() => setRestore(undefined)}>Cancel</Button>
              </div>
            </div>
          )}
        </Card>
      </div>

      <div class="stack-3">
        <Card title="Reboot" actions={info.samples[0] && <span class="muted num">up {duration(info.samples[0].uptime)}</span>}>
          <div class="stack-3">
            <p class="secondary" style={{ margin: 0 }}>Restarts the router now. About 90 s offline; staged changes that aren't applied are lost.</p>
            <div><Button icon="power" onClick={() => setConfirm('reboot')}>Reboot…</Button></div>
          </div>
        </Card>
        <Card title="Reset to defaults" class="danger-card">
          <div class="stack-3">
            <p class="secondary" style={{ margin: 0 }}>
              Erases all settings of the running image (passwords, network, firewall, VPN keys) and reboots
              into factory defaults: LAN 192.168.1.1, no password. The other image slot is not touched.
            </p>
            <div><Button variant="danger" icon="trash" onClick={() => { setTyped(''); setConfirm('reset') }}>Reset to defaults…</Button></div>
          </div>
        </Card>
        {actionErr ? <ErrorBox error={actionErr} /> : null}
      </div>

      {confirm && (
        <Modal title={{ reboot: `Reboot ${host}?`, restore: 'Restore this backup?', reset: 'Erase all settings?' }[confirm]} onClose={() => setConfirm(undefined)} footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(undefined)}>Cancel</Button>
            {confirm === 'reset'
              ? <Button variant="danger" icon="trash" disabled={typed !== host} onClick={() => run('reset')}>Erase and reboot</Button>
              : <Button variant="primary" icon="power" onClick={() => run(confirm)}>{confirm === 'reboot' ? 'Reboot now' : 'Restore and reboot'}</Button>}
          </>
        }>
          {confirm === 'reboot' && <p style={{ margin: 0 }}>The router and everything behind it is offline for about 90 s.</p>}
          {confirm === 'restore' && <p style={{ margin: 0 }}>The current settings are replaced by the backup's, then the router reboots. If the backup uses a different LAN address, reconnect on that one.</p>}
          {confirm === 'reset' && (
            <div class="stack">
              <p style={{ margin: 0 }}>This can't be undone (download a backup first). Type the hostname <code>{host}</code> to confirm.</p>
              <input class="input mono" autoFocus value={typed} onInput={(e) => setTyped((e.target as HTMLInputElement).value)} />
            </div>
          )}
        </Modal>
      )}
    </div>
  )
}
