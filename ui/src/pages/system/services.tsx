// System > Services: procd init scripts (rpcd's rc list / rc init). Start, stop and restart act
// now; At boot enables or disables the script. Not UCI, so nothing is staged.
import { useState } from 'preact/hooks'
import { useAsync } from '../../api/store'
import { system, type Service, type ServiceAction } from '../../api/system'
import { Badge, Button, Card, ErrorBox, Modal, Segmented, Toggle } from '../../components/ui'

const WHAT: Record<string, string> = {
  boot: 'early boot setup', cron: 'scheduled tasks', dnsmasq: 'DNS and DHCP', done: 'end of boot', dropbear: 'SSH server',
  firewall: 'firewall (fw4)', gpio_switch: 'GPIO pins', led: 'LED triggers', log: 'system log (logd)', network: 'interfaces (netifd)',
  odhcpd: 'IPv6 RA and DHCPv6', offload: 'hardware offload', packet_steering: 'spread packet work across cores', rpcd: 'the API this page uses',
  sysctl: 'kernel settings', sysfixtime: 'clock from last save', sysntpd: 'NTP time sync', system: 'hostname, zone, logging',
  uhttpd: 'web server for this page', umount: 'unmount at shutdown', urandom_seed: 'random seed', urngd: 'entropy',
}

/** What stopping, disabling or restarting it does to the router or to this page; asks first. */
const RISK: Record<string, string> = {
  network: 'every interface goes down and comes back; this page loses the router for a while',
  firewall: 'the firewall reloads; connections may drop',
  rpcd: 'this page loses its session and has to log in again',
  uhttpd: 'this page stops loading until the web server is back',
  dnsmasq: 'DNS and DHCP stop: clients can\'t resolve names or get addresses',
  odhcpd: 'IPv6 clients stop getting router advertisements',
  dropbear: 'SSH logins stop',
  log: 'the system log stops (and loses its contents on restart)',
}

type Filter = 'daemons' | 'all'

export function Services() {
  const list = useAsync(system.services, [], [])
  const [filter, setFilter] = useState<Filter>('daemons')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState<unknown>()
  const [ask, setAsk] = useState<{ s: Service; action: ServiceAction } | null>(null)
  const act = async (s: Service, action: ServiceAction) => {
    setAsk(null)
    setBusy(`${s.name}:${action}`)
    setErr(undefined)
    try { await system.service(s.name, action) } catch (e) { setErr(e) }
    setBusy('')
    list.reload()
  }
  const run = (s: Service, action: ServiceAction) => () =>
    RISK[s.name] && action !== 'start' && action !== 'enable' ? setAsk({ s, action }) : act(s, action)
  if (list.error) return <ErrorBox error={`Couldn't list services: ${list.error.message}`} />
  if (!list.data) return <div class="muted">Loading…</div>
  // daemons (with a running state) first; one-shot boot scripts only on "All"
  const rows = list.data.filter((s) => filter === 'all' || s.running !== undefined)
  return (
    <>
      {err != null && <ErrorBox error={err} />}
      <Card flush title={`Services · ${rows.length}`} actions={
        <Segmented value={filter} onChange={setFilter} options={[{ value: 'daemons', label: 'Daemons' }, { value: 'all', label: 'All scripts' }]} />
      }>
        <div class="table-wrap">
          <table class="table services-table">
            <thead><tr><th>Service</th><th>State</th><th>At boot</th><th /></tr></thead>
            <tbody>
              {rows.map((s) => {
                const b = (a: string) => busy === `${s.name}:${a}`
                return (
                  <tr class={s.enabled ? '' : 'disabled'}>
                    <td><span class="svc-name mono">{s.name}</span> <span class="muted small">{WHAT[s.name] ?? ''}</span></td>
                    <td>{s.running === undefined ? <span class="muted small">one-shot</span>
                      : s.running ? <Badge status="good">running</Badge> : <Badge status={s.enabled ? 'warning' : undefined}>stopped</Badge>}</td>
                    <td><Toggle label={`Start ${s.name} at boot`} on={s.enabled} disabled={!!busy} onChange={(v) => run(s, v ? 'enable' : 'disable')()} /></td>
                    <td class="svc-actions">
                      {s.running === false && <Button disabled={!!busy} onClick={run(s, 'start')}>{b('start') ? 'Starting…' : 'Start'}</Button>}
                      {s.running && <>
                        <Button disabled={!!busy} onClick={run(s, 'restart')}>{b('restart') ? 'Restarting…' : 'Restart'}</Button>
                        <Button disabled={!!busy} onClick={run(s, 'stop')}>{b('stop') ? 'Stopping…' : 'Stop'}</Button>
                      </>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>
      {ask && (
        <Modal title={`${ask.action[0].toUpperCase()}${ask.action.slice(1)} ${ask.s.name}?`} onClose={() => setAsk(null)} footer={<>
          <Button onClick={() => setAsk(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => act(ask.s, ask.action)}>{ask.action[0].toUpperCase()}{ask.action.slice(1)} {ask.s.name}</Button>
        </>}>
          <p style={{ margin: 0 }}>{RISK[ask.s.name][0].toUpperCase()}{RISK[ask.s.name].slice(1)}{ask.action === 'disable' ? ', from the next boot on' : ''}.</p>
        </Modal>
      )}
    </>
  )
}
