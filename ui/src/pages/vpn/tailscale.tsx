// Tailscale on the VPN page. Set up (staged firewall/network, Tailscale's own build downloaded
// onto the eMMC, the service started), log in through Tailscale's own page, then: share home networks (subnet routes), offer the router as an
// exit node, use other nodes' routes. Routes and the exit node also need approval in the
// Tailscale admin console; until then they show as waiting. Tailscale updates itself (its own
// updater, release signature checked) unless "Update automatically" is off.
import { useEffect, useState } from 'preact/hooks'
import { usePoll } from '../../api/store'
import { ensureExitForwarding, stageTailscale, tailscale, tsNetwork, unstageTailscale, type TsNode, type TsSettings, type TsStatus } from '../../api/tailscale'
import { interfaceSubnets, cidrStr } from '../../api/ip4'
import { zones as zonesOf } from '../../api/firewall'
import { bytes } from '../../components/format'
import { Badge, Button, Card, ErrorBox, Modal, Table, Toggle } from '../../components/ui'
import { MultiChips } from '../../components/chips'
import { CopyButton } from '../../components/copy'
import type { VpnData } from './shared'

const ADMIN = 'https://login.tailscale.com/admin/machines'

export function TailscaleCard({ data }: { data: VpnData }) {
  const poll = usePoll(tailscale.status, 3000)
  const st = poll.samples[0]
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<unknown>()
  // set up while Tailscale was still downloading: log in once it's there
  const [pendingUp, setPendingUp] = useState<TsSettings>()
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true)
    try { await f(); setErr(undefined) } catch (e) { setErr(e) } finally { setBusy(false) }
  }
  useEffect(() => {
    if (pendingUp && st?.installed) { const s = pendingUp; setPendingUp(undefined); run(() => tailscale.up(s)) }
  }, [pendingUp, st?.installed])
  if (!st) return null
  const wired = !!tsNetwork(data.net)
  const settings: TsSettings = { routes: st.prefs?.routes.filter((r) => r !== '0.0.0.0/0' && r !== '::/0') ?? [], exit_node: !!st.prefs?.exit_node, accept_routes: !!st.prefs?.accept_routes,
    auto_update: st.prefs ? st.prefs.auto_update : true }
  const dl = st.installed ? undefined : (st.install?.state === 'error' ? 'error' : st.install?.state === 'downloading' || pendingUp ? 'downloading' : 'none') as Download
  const dlError = st.install?.state === 'error' ? st.install.message ?? 'download failed' : undefined
  // download first if needed; log in when it's there
  const start = async (s: TsSettings) => {
    if (st.installed) return tailscale.up(s)
    setPendingUp(s)
    await tailscale.install()
  }
  const state = !st.running ? 'off' : st.backend === 'Running' ? 'on' : st.auth_url ? 'login' : st.backend === 'NeedsMachineAuth' ? 'approve' : 'out'
  const badge = { off: <Badge>off</Badge>, on: <span title="Direct connections use UDP 41641 (opened on the WAN). Tailscale runs on the CPU (userspace WireGuard), not the hardware offload."><Badge status="good">connected</Badge></span>, login: <Badge status="warning">waiting for login</Badge>,
    approve: <Badge status="warning">waiting for approval</Badge>, out: <Badge>logged out</Badge> }[state]

  return (
    <Card title={<span class="row">Tailscale {data.staged.has('tailscale') && <Badge status="accent">unapplied</Badge>}</span>} actions={badge}>
      <div class="stack">
        {err != null && <ErrorBox error={err} />}
        {!wired ? <SetUp data={data} busy={busy} dl={dl} dlError={dlError} onSetUp={(reach) => run(async () => { await stageTailscale(data.net, data.fw, reach); await start(settings) })} />
          : dl ? <Download dl={dl} error={dlError} busy={busy} onStart={() => run(() => start(settings))} />
          : state === 'off' || state === 'out' ? (
            <div class="row">
              <span class="secondary">This router isn't on your tailnet.</span>
              <span style={{ flex: 1 }} />
              {state === 'off' && <Button variant="ghost" disabled={busy} title="Remove the tailscale network, its firewall zone, forwardings and WAN rule (staged)"
                onClick={() => run(() => unstageTailscale(data.net, data.fw))}>Remove network and zone</Button>}
              <Button variant="primary" disabled={busy} onClick={() => run(() => tailscale.up(settings))}>Log in</Button>
            </div>
          ) : state === 'login' ? (
            <div class="row">
              <span class="secondary">Log in with your Tailscale account to add this router.</span>
              <span style={{ flex: 1 }} />
              <a class="btn btn-primary" href={st.auth_url!} target="_blank" rel="noopener noreferrer">Open the login page</a>
            </div>
          ) : state === 'approve' ? (
            <div class="row"><span class="secondary">Logged in; an admin has to approve this device.</span><span style={{ flex: 1 }} /><a class="btn" href={ADMIN} target="_blank" rel="noopener noreferrer">Admin console</a></div>
          ) : <Connected st={st} data={data} settings={settings} busy={busy} run={run} />}
      </div>
    </Card>
  )
}

type Download = 'none' | 'downloading' | 'error'

/** Tailscale isn't on the router yet: the image doesn't carry it, the router downloads Tailscale's
 *  own build (about 36 MB) from pkgs.tailscale.com. */
function Download({ dl, error, busy, onStart }: { dl: Download; error?: string; busy: boolean; onStart: () => void }) {
  if (dl === 'downloading') return <div class="row"><Badge status="accent">downloading</Badge><span class="secondary">Downloading Tailscale from pkgs.tailscale.com (about 36 MB)…</span></div>
  return (
    <div class="row">
      {dl === 'error' ? <span class="warn-line">Couldn't download Tailscale: {error}</span> : <span class="secondary">Tailscale isn't on this router yet. It's downloaded from pkgs.tailscale.com (about 36 MB) and kept on the eMMC.</span>}
      <span style={{ flex: 1 }} />
      <Button variant="primary" disabled={busy} onClick={onStart}>{dl === 'error' ? 'Try again' : 'Download'}</Button>
    </div>
  )
}

function SetUp({ data, busy, dl, dlError, onSetUp }: { data: VpnData; busy: boolean; dl?: Download; dlError?: string; onSetUp: (reach: string[]) => void }) {
  const inside = zonesOf(data.fw).filter((z) => !z.masq && z.name !== 'tailscale')
  const [reach, setReach] = useState<string[]>(inside.some((z) => z.name === 'lan') ? ['lan'] : [])
  return (
    <div class="stack">
      <span class="secondary">Join this router to your tailnet: reach home from your other Tailscale devices, or use home as an exit node.</span>
      <div class="row" style={{ flexWrap: 'wrap' }}>
        <span class="muted small">Tailnet may reach</span>
        <MultiChips value={reach} onChange={setReach} label="Zones the tailnet may reach" options={inside.map((z) => ({ value: z.name, label: z.name, slot: z.slot }))} />
        <span style={{ flex: 1 }} />
        <Button variant="primary" disabled={busy || dl === 'downloading'} onClick={() => onSetUp(reach)}>Set up Tailscale</Button>
      </div>
      {dl === 'downloading' && <Download dl={dl} busy={busy} onStart={() => {}} />}
      {dl === 'error' && <span class="warn-line">Couldn't download Tailscale: {dlError}</span>}
      {dl === 'none' && <span class="muted small">Downloads Tailscale's own build (about 36 MB) onto the eMMC; it keeps itself up to date.</span>}
    </div>
  )
}

function Connected({ st, data, settings, busy, run }: { st: TsStatus; data: VpnData; settings: TsSettings; busy: boolean; run: (f: () => Promise<unknown>) => void }) {
  const self = st.self!
  // home networks to share: the static LAN subnets
  const subnets = Object.entries(interfaceSubnets(data.net)).filter(([n]) => !/^wan/.test(n) && n !== 'loopback' && data.net[n]?.proto === 'static' && n !== 'tailscale')
    .map(([n, s]) => ({ net: n, cidr: cidrStr(s) }))
  const save = (p: Partial<TsSettings>) => run(async () => {
    if (p.exit_node) await ensureExitForwarding(data.fw)
    await tailscale.up({ ...settings, ...p })
  })
  const [off, setOff] = useState(false)
  const [unwire, setUnwire] = useState(true)
  const waiting = [...settings.routes.filter((r) => !self.routes.includes(r)), ...(settings.exit_node && !self.exit_option ? ['exit node'] : [])]
  return (
    <div class="stack">
      <div class="kv">
        <span>This router</span>
        <span class="row"><b>{self.dns || self.name}</b> <span class="mono">{self.ips[0]}</span><CopyButton text={self.ips[0]} />{st.tailnet && <span class="muted small">on {st.tailnet}</span>}</span>
        <span>Share home networks</span>
        <span><MultiChips value={settings.routes} label="Subnet routes" onChange={(routes) => save({ routes })}
          options={subnets.map((s) => ({ value: s.cidr, label: <>{s.net} <span class="mono muted">{s.cidr}</span></> }))} /></span>
        <span>Exit node</span>
        <span class="row" title="Other devices can send their internet traffic through home"><Toggle on={settings.exit_node} label="Offer as exit node" onChange={(exit_node) => save({ exit_node })} /></span>
        <span>Use routes</span>
        <span class="row" title="Reach networks other nodes share"><Toggle on={settings.accept_routes} label="Use routes from other nodes" onChange={(accept_routes) => save({ accept_routes })} /></span>
        <span>Version</span>
        <span class="row">
          <span class="mono">{st.version ?? '–'}</span>
          {st.updating
            ? <span title={st.update_log ?? undefined}><Badge status="accent">updating…</Badge></span>
            : st.latest && <><Badge status="warning">{st.latest} available</Badge><Button disabled={busy} onClick={() => run(tailscale.update)}>Update now</Button></>}
        </span>
        <span>Update automatically</span>
        <span class="row" title="Tailscale installs new releases itself (it checks Tailscale's release signature) and restarts, which drops connections for a few seconds">
          <Toggle on={settings.auto_update} label="Update Tailscale automatically" onChange={(auto_update) => save({ auto_update })} />
        </span>
      </div>
      {waiting.length > 0 && (
        <div class="row warn-line">Waiting for approval in the admin console: {waiting.join(', ')} <a href={ADMIN} target="_blank" rel="noopener noreferrer">open</a></div>
      )}
      {(st.health ?? []).map((h) => <div class="warn-line">{h}</div>)}
      <Peers peers={st.peers ?? []} />
      <div class="row">
        <span style={{ flex: 1 }} />
        <Button disabled={busy} onClick={() => run(() => tailscale.logout())}>Log out</Button>
        <Button variant="ghost" disabled={busy} onClick={() => setOff(true)}>Log out and turn off</Button>
      </div>
      {off && (
        <Modal title="Turn off Tailscale?" onClose={() => setOff(false)} footer={<>
          <Button variant="ghost" onClick={() => setOff(false)}>Cancel</Button>
          <Button variant="primary" onClick={() => { setOff(false); run(async () => { await tailscale.logout(true); if (unwire) await unstageTailscale(data.net, data.fw) }) }}>Turn off</Button>
        </>}>
          <div class="stack">
            <p style={{ margin: 0 }}>This router leaves your tailnet and the service stops. Devices using it as an exit node or to reach home lose that.</p>
            <label class="row">
              <Toggle on={unwire} label="Also remove its network and firewall zone" onChange={setUnwire} />
              <span>Also remove the <span class="mono">tailscale</span> network, its firewall zone and forwardings, and the WAN rule for UDP 41641 (staged; apply from the top bar)</span>
            </label>
          </div>
        </Modal>
      )}
    </div>
  )
}

function Peers({ peers }: { peers: TsNode[] }) {
  if (!peers.length) return null
  return (
    <div class="table-wrap">
      <Table<TsNode> rows={peers} rowKey={(p) => p.dns || p.name} columns={[
        { key: 'name', label: 'Device', value: (p) => p.name, render: (p) => <span class="row nowrap">{p.online ? <Badge status="good">online</Badge> : <Badge>offline</Badge>}<b>{p.name}</b><span class="muted small">{p.os}</span></span> },
        { key: 'ip', label: 'Address', value: (p) => p.ips[0] ?? '', render: (p) => <span class="mono">{p.ips[0]}</span> },
        { key: 'via', label: 'Path', value: (p) => (p.direct ? 0 : 1), render: (p) => (p.online ? (p.direct ? 'direct' : <span class="muted">relay {p.relay}</span>) : <span class="muted">–</span>) },
        { key: 'routes', label: 'Shares', value: (p) => p.routes.join(','), render: (p) => <span class="mono small">{[...p.routes, ...(p.exit_option ? ['exit node'] : [])].join(', ') || '–'}</span> },
        { key: 'rx', label: 'Received', num: true, value: (p) => p.rx, render: (p) => (p.rx ? bytes(p.rx) : '–') },
      ]} />
    </div>
  )
}
