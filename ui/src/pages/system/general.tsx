// System > General: hostname, time zone, clock, NTP (UCI 'system', staged like everything else).
import { useMemo, useState } from 'preact/hooks'
import { router } from '../../api/router'
import { useAsync, usePoll } from '../../api/store'
import { system } from '../../api/system'
import type { UciSection } from '../../api/types'
import { uci } from '../../api/uci'
import { Icon } from '../../components/icons'
import { Badge, Button, Card, ErrorBox, Segmented, Toggle } from '../../components/ui'
import { InlineInput, SettingRow, Unapplied, useStaged } from './common'

const HOST_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/
const NTP_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$|^[0-9a-fA-F:]+$/
const DEFAULT_NTP = ['0.openwrt.pool.ntp.org', '1.openwrt.pool.ntp.org', '2.openwrt.pool.ntp.org', '3.openwrt.pool.ntp.org']

/** Seconds the zone is ahead of UTC at time t (rpcd's localtime = UTC epoch + this). */
export function zoneOffset(zone: string, t = Date.now()): number {
  try {
    const d = new Date(t)
    d.setMilliseconds(0)
    const wall = new Date(d.toLocaleString('en-US', { timeZone: zone }))
    const utc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }))
    return Math.round((wall.getTime() - utc.getTime()) / 1000)
  } catch {
    return 0
  }
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === 'string' && v ? v.split(/\s+/) : [])

export function General() {
  const cfg = useAsync(() => uci.get('system'))
  const staged = useStaged('system')
  if (cfg.error) return <ErrorBox error={cfg.error} />
  if (!cfg.data) return <div class="muted">Loading…</div>
  const sys = Object.values(cfg.data).find((s) => s['.type'] === 'system')
  const ntp = Object.values(cfg.data).find((s) => s['.type'] === 'timeserver')
  if (!sys) return <ErrorBox error="/etc/config/system has no 'system' section" />
  const name = sys['.name']
  return (
    <div class="sys-cols">
      <div class="stack-3">
        <Card title="Identity">
          <SettingRow label="Hostname" hint="Name on the LAN and in DHCP/DNS (er4.lan). Letters, digits, hyphens.">
            <InlineInput label="Hostname" value={String(sys.hostname ?? '')} staged={staged.has(name, 'hostname')} mono width={200}
              validate={(v) => (HOST_RE.test(v) ? '' : 'letters, digits, hyphens; max 63')}
              onCommit={(v) => uci.set('system', name, { hostname: v })} />
          </SettingRow>
          <SettingRow label="Description" hint="Free text for your own notes; kept in backups.">
            <InlineInput label="Description" value={String(sys.description ?? '')} placeholder="e.g. Home router, rack 1" staged={staged.has(name, 'description')} width={200}
              onCommit={(v) => uci.set('system', name, { description: v })} />
          </SettingRow>
        </Card>
        <Clock sys={sys} staged={staged.has(name, 'zonename')} />
      </div>
      <div class="stack-3">
        <Ntp ntp={ntp} staged={(o) => !!ntp && staged.has(ntp['.name'], o)} />
        <Logging sys={sys} staged={(o) => staged.has(name, o)} />
      </div>
    </div>
  )
}

function Clock({ sys, staged }: { sys: UciSection; staged: boolean }) {
  const info = usePoll(router.info, 1000)
  const zones = useAsync(system.timezones, [], [])
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [synced, setSynced] = useState<string>()
  const zone = String(sys.zonename ?? 'UTC')
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const names = useMemo(() => Object.keys(zones.data ?? {}).sort(), [zones.data])
  const matches = names.filter((z) => z.toLowerCase().replace(/_/g, ' ').includes(query.toLowerCase().replace(/_/g, ' '))).slice(0, 60)
  const local = info.samples[0]?.localtime
  // rpcd's localtime is wall-clock seconds in the applied zone; while a zone change is staged
  // the applied zone isn't known here, so skip the comparison
  const skew = local != null && !staged ? Math.round(local - zoneOffset(zone) - Date.now() / 1000) : 0
  const pick = (z: string) => {
    const tz = zones.data?.[z]?.tzstring ?? 'UTC0'
    uci.set('system', sys['.name'], { zonename: z, timezone: tz })
    setOpen(false)
    setQuery('')
  }
  const fmt = (t: number) => new Date(t * 1000).toLocaleString(undefined, { timeZone: 'UTC', weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return (
    <Card title="Time">
      <div class="clock">
        <span class="clock-time num">{local != null ? fmt(local) : '…'}</span>
        <span class="muted">{staged ? `${zone} after apply` : zone}</span>
      </div>
      <div class="row clock-skew">
        {local == null || staged ? null : Math.abs(skew) <= 2 ? (
          <Badge status="good">in sync with this browser</Badge>
        ) : (
          <>
            <Badge status="warning">{Math.abs(skew)} s {skew < 0 ? 'behind' : 'ahead of'} this browser</Badge>
            <Button icon="check" onClick={async () => { await system.setLocaltime(Math.round(Date.now() / 1000)); setSynced('Clock set from this browser') }}>Sync now</Button>
          </>
        )}
        {synced && <span class="muted">{synced}</span>}
      </div>
      <SettingRow label={<>Time zone <Unapplied show={staged} /></>} hint="Used for logs, schedules and the dashboard clock.">
        <div class="tz-picker">
          <button type="button" class="btn tz-current" onClick={() => setOpen(!open)} aria-expanded={open}>
            <Icon name="globe" /> {zone}
          </button>
        </div>
      </SettingRow>
      {open && (
        <div class="tz-panel">
          <div class="row">
            <input class="input" style={{ flex: 1 }} autoFocus placeholder="Search: berlin, new york, utc…" value={query}
              onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && matches[0]) pick(matches[0]); if (e.key === 'Escape') setOpen(false) }} />
            {browserZone && browserZone !== zone && names.includes(browserZone) && (
              <Button onClick={() => pick(browserZone)}>Use {browserZone}</Button>
            )}
          </div>
          {zones.error ? <ErrorBox error={zones.error} /> : (
            <div class="tz-list" role="listbox">
              {matches.map((z) => (
                <button type="button" role="option" aria-selected={z === zone} class={z === zone ? 'on' : ''} onClick={() => pick(z)}>
                  <span>{z.replace(/_/g, ' ')}</span>
                  <span class="muted mono">{zones.data?.[z].tzstring}</span>
                </button>
              ))}
              {!matches.length && <div class="muted" style={{ padding: 8 }}>No zone matches "{query}"</div>}
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

function Ntp({ ntp, staged }: { ntp?: UciSection; staged: (option: string) => boolean }) {
  const [adding, setAdding] = useState('')
  const [dragFrom, setDragFrom] = useState<number>()
  if (!ntp) {
    return (
      <Card title="NTP">
        <p class="muted">No timeserver section in /etc/config/system.</p>
        <Button icon="plus" onClick={() => uci.add('system', 'timeserver', { enabled: '1', server: DEFAULT_NTP }, 'ntp')}>Add NTP client</Button>
      </Card>
    )
  }
  const sec = ntp['.name']
  const servers = list(ntp.server)
  const enabled = ntp.enabled !== '0'
  const setServers = (s: string[]) => uci.set('system', sec, { server: s })
  const addErr = adding && !NTP_RE.test(adding.trim()) ? 'not a host name or IP' : servers.includes(adding.trim()) ? 'already in the list' : ''
  const add = () => {
    const v = adding.trim()
    if (!v || addErr) return
    setServers([...servers, v])
    setAdding('')
  }
  const move = (from: number, to: number) => {
    if (from === to) return
    const s = [...servers]
    const [x] = s.splice(from, 1)
    s.splice(to, 0, x)
    setServers(s)
  }
  return (
    <Card title="NTP" actions={<Unapplied show={staged('server') || staged('enabled') || staged('enable_server')} />}>
      <SettingRow label="Sync from NTP servers" hint="Keeps the clock right; needed for TLS, logs and WireGuard handshakes.">
        <Toggle on={enabled} label="NTP client" onChange={(v) => uci.set('system', sec, { enabled: v ? '1' : '0' })} />
      </SettingRow>
      <SettingRow label="Serve time to the LAN" hint="Clients can use this router (192.168.1.1) as their NTP server.">
        <Toggle on={ntp.enable_server === '1'} label="NTP server" onChange={(v) => uci.set('system', sec, { enable_server: v ? '1' : '0' })} />
      </SettingRow>
      <div class={`ntp-list${enabled ? '' : ' dim'}`}>
        <div class="ntp-head">
          <span class="setting-label">Servers</span>
          <span class="muted">first reachable wins · drag to reorder</span>
          <span class="spacer" />
          {servers.join() !== DEFAULT_NTP.join() && <Button variant="ghost" icon="undo" onClick={() => setServers(DEFAULT_NTP)}>OpenWrt pool</Button>}
        </div>
        {servers.map((s, i) => (
          <div class={`ntp-item${dragFrom === i ? ' dragging' : ''}`} draggable
            onDragStart={() => setDragFrom(i)} onDragEnd={() => setDragFrom(undefined)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => { if (dragFrom != null) move(dragFrom, i); setDragFrom(undefined) }}>
            <Icon name="drag" class="grip" />
            <span class="num muted">{i + 1}</span>
            <span class="mono">{s}</span>
            <span class="spacer" />
            <Button variant="ghost" icon="trash" aria-label={`Remove ${s}`} title="Remove" onClick={() => setServers(servers.filter((_, j) => j !== i))} />
          </div>
        ))}
        {!servers.length && <div class="muted ntp-empty">No servers: the clock will drift.</div>}
        <div class="ntp-add">
          <input class={`input mono${addErr ? ' invalid' : ''}`} placeholder="add server: time.cloudflare.com" value={adding}
            onInput={(e) => setAdding((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
          <Button icon="plus" disabled={!adding.trim() || !!addErr} onClick={add}>Add</Button>
          {addErr && <span class="field-error">{addErr}</span>}
        </div>
      </div>
    </Card>
  )
}

// ---- logging (UCI system: logd's buffer, the log service's file and remote syslog) ---------
/** On p2 (persistent, mounted in preinit); rotated to .old at LOG_FILE_KB. */
export const LOG_FILE = '/mnt/er4data/er4/log/messages'
const LOG_FILE_KB = '1024'
const BUFFERS = ['64', '128', '256', '512']
const HOST_OR_IP = /^[A-Za-z0-9]([A-Za-z0-9.:-]*[A-Za-z0-9])?$/

function Logging({ sys, staged }: { sys: UciSection; staged: (option: string) => boolean }) {
  const name = sys['.name']
  // log_size doubles as the buffer size unless log_buffer_size is set: always set the buffer explicitly
  const buffer = String(sys.log_buffer_size ?? (sys.log_file ? '64' : sys.log_size ?? '64'))
  const keep = !!sys.log_file
  const setKeep = (on: boolean) => on
    ? uci.set('system', name, { log_file: LOG_FILE, log_size: LOG_FILE_KB, log_buffer_size: buffer })
    : uci.remove('system', name, ['log_file', 'log_size'])
  // read the staged config first: this card may not have re-rendered since "Keep on eMMC"
  const setBuffer = async (b: string) => {
    const cur = (await uci.get('system'))[name]
    await uci.set('system', name, cur?.log_file ? { log_buffer_size: b } : { log_buffer_size: b, log_size: b })
  }
  const remote = String(sys.log_ip ?? '')
  return (
    <Card title="Logging">
      <SettingRow label="Buffer" badges={<Unapplied show={staged('log_buffer_size') || staged('log_size')} />} hint="The system log in RAM, in KB. Lost on reboot.">
        <div class="chips">
          {BUFFERS.map((b) => <button type="button" class={`chip${buffer === b ? ' on' : ''}`} aria-pressed={buffer === b}
            onClick={() => setBuffer(b)}>{b}</button>)}
          {!BUFFERS.includes(buffer) && <span class="chip on">{buffer}</span>}
        </div>
      </SettingRow>
      <SettingRow label="Keep on eMMC" badges={<Unapplied show={staged('log_file')} />}
        hint={keep ? <>Survives reboots: <span class="mono">{String(sys.log_file)}</span>, {Number(sys.log_size ?? 0) || '?'} KB then rotated. Every line is a write to the eMMC.</> : 'Lets you read what happened before a crash or reboot (Diagnostics → Logs → Saved).'}>
        <Toggle label="Keep the log on eMMC" on={keep} onChange={setKeep} />
      </SettingRow>
      <SettingRow label="Remote syslog" badges={<Unapplied show={staged('log_ip') || staged('log_port') || staged('log_proto')} />} hint="Also send every line to a syslog server.">
        <span class="row">
          <InlineInput label="Remote syslog host" value={remote} placeholder="off" mono width={150}
            validate={(v) => (!v || HOST_OR_IP.test(v) ? '' : 'a host name or address')}
            onCommit={(v) => (v ? uci.set('system', name, { log_ip: v }) : uci.remove('system', name, ['log_ip', 'log_port', 'log_proto']))} />
          {remote && <>
            <InlineInput label="Remote syslog port" value={String(sys.log_port ?? '514')} mono width={64}
              validate={(v) => (/^\d+$/.test(v) && +v > 0 && +v < 65536 ? '' : '1 to 65535')}
              onCommit={(v) => (v === '514' ? uci.remove('system', name, ['log_port']) : uci.set('system', name, { log_port: v }))} />
            <Segmented value={String(sys.log_proto ?? 'udp')} onChange={(v) => (v === 'udp' ? uci.remove('system', name, ['log_proto']) : uci.set('system', name, { log_proto: v }))}
              options={[{ value: 'udp', label: 'UDP' }, { value: 'tcp', label: 'TCP' }]} />
          </>}
        </span>
      </SettingRow>
    </Card>
  )
}
