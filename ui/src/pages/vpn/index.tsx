// VPN (WireGuard). Config: UCI network interface (proto wireguard) + 'wireguard_<iface>' peer
// sections; runtime: er4 wg_instances (polled). Every tunnel gets its own card and device list.
// #/vpn/add[/<iface>] opens "Add device", #/vpn/peer/<section> a peer's editor, #/vpn/new a
// further road-warrior tunnel, #/vpn/import a tunnel from a .conf. None yet -> setup wizard.
import { useState } from 'preact/hooks'
import type { PageProps } from '../../app'
import { go } from '../../app'
import { uci } from '../../api/uci'
import { router, routerClock } from '../../api/router'
import { useAsync, useEvent, usePoll } from '../../api/store'
import { stagedSections, setOptions, str } from '../../api/firewall'
import { list } from '../../api/ip4'
import { KEY_RE, ago, peerSections, peerState, randomPsk, wg, wgInterfaces, type WgInstance } from '../../api/wireguard'
import type { UciSection } from '../../api/types'
import { bytes } from '../../components/format'
import { Badge, Button, Card, Drawer, ErrorBox, Field, PageHead, Table, Toggle } from '../../components/ui'
import { Icon } from '../../components/icons'
import { CopyButton } from '../../components/copy'
import { Tip } from '../../components/tooltip'
import { AddDevice } from './add-device'
import { Setup } from './setup'
import { ImportTunnel } from './import'
import { TailscaleCard } from './tailscale'
import { IpsecCard } from './ipsec'
import { useServerPub, type VpnData } from './shared'
import './vpn.css'

const cleanPath = (path: string[]) => path.map((p) => p.replace(/\?.*$/, '')).filter(Boolean)

export default function Vpn({ path }: PageProps) {
  const [sub, id] = cleanPath(path)
  const cfg = useAsync<VpnData>(async () => {
    const [net, fw, staged, ifaces] = await Promise.all([
      uci.get('network'), uci.get('firewall').catch(() => ({})), stagedSections(), router.interfaces().catch(() => []),
    ])
    const wan = ifaces.find((i) => i.interface === 'wan')
    return { net, fw, staged: staged.network ?? new Set(), wanAddr: wan?.['ipv4-address']?.[0]?.address }
  })
  const rt = usePoll(wg.instances, 5000)
  const d = cfg.data

  if (!d) {
    return (
      <div class="page">
        <PageHead title="VPN" />
        {cfg.error ? <div class="row"><ErrorBox error={`Couldn't read the network configuration: ${cfg.error.message}`} /><Button icon="undo" onClick={cfg.reload}>Retry</Button></div>
          : <div class="vpn-skeleton" aria-busy="true"><div /><div /></div>}
      </div>
    )
  }

  const ifaces = wgInterfaces(d.net).sort((a, b) => +(b['.name'] === 'wg0') - +(a['.name'] === 'wg0'))
  const importing = sub === 'import' && <ImportTunnel data={d} onClose={() => go('vpn')} onDone={() => go('vpn')} />
  if (!ifaces.length) {
    return (
      <div class="page">
        <PageHead title="VPN"><Button icon="upload" onClick={() => go('vpn', 'import')}>Import config</Button></PageHead>
        <Setup data={d} />
        <TailscaleCard data={d} />
        <IpsecCard data={d} sub={sub} id={id} />
        {importing}
      </div>
    )
  }
  const instOf = (n: string) => rt.samples[0]?.[n]
  const statusKnown = !rt.error && rt.samples.length > 0
  const tunnel = sub === 'tunnel' ? ifaces.find((x) => x['.name'] === id) : undefined
  const addTo = (sub === 'add' && ifaces.find((x) => x['.name'] === id)) || ifaces[0]
  const peer = sub === 'peer' && id ? d.net[id] : undefined
  return (
    <div class="page">
      <PageHead title="VPN">
        <Button icon="upload" onClick={() => go('vpn', 'import')}>Import config</Button>
        <Button icon="plus" onClick={() => go('vpn', 'new')}>New tunnel</Button>
      </PageHead>
      {rt.error && (
        <div class="vpn-warn"><Icon name="warning" size={14} /> Live status unavailable ({rt.error.message}). The configuration below is still editable.</div>
      )}
      {ifaces.map((iface) => <TunnelCard iface={iface} inst={instOf(iface['.name'])} data={d} statusKnown={statusKnown} />)}
      <TailscaleCard data={d} />
      <IpsecCard data={d} sub={sub} id={id} />
      {sub === 'add' && <AddDevice iface={addTo} inst={instOf(addTo['.name'])} data={d} onClose={() => go('vpn')} />}
      {peer && <PeerDrawer peer={peer} inst={instOf(peer['.type'].replace(/^wireguard_/, ''))} onClose={() => go('vpn')} />}
      {tunnel && <TunnelDrawer iface={tunnel} inst={instOf(tunnel['.name'])} data={d} onClose={() => go('vpn')} />}
      {sub === 'new' && (
        <Drawer title="New tunnel" onClose={() => go('vpn')}><Setup data={d} onDone={() => go('vpn')} /></Drawer>
      )}
      {importing}
    </div>
  )
}

interface PeerRow { s: UciSection; enabled: boolean; state: ReturnType<typeof peerState>; rt?: ReturnType<WgInstance['peers']['get']> }

/** "10.200.0.2/32" reads as the device's address; networks behind it keep their prefix */
const addrs = (s: UciSection) => list(s.allowed_ips).map((a) => a.replace(/\/(32|128)$/, '')).join(', ')

/** One tunnel: its facts on one line, settings in a drawer (#/vpn/tunnel/<iface>), its devices. */
function TunnelCard({ iface, inst, data, statusKnown }: { iface: UciSection; inst?: WgInstance; data: VpnData; statusKnown: boolean }) {
  const [error, setError] = useState<unknown>()
  const pub = useServerPub(iface, inst)
  const name = iface['.name']
  useEvent('clock')
  const now = routerClock.now()
  const rows: PeerRow[] = peerSections(data.net, name).map((s) => {
    const enabled = s.disabled !== '1'
    const rt = inst?.peers.get(str(s.public_key))
    return { s, enabled, rt, state: statusKnown ? peerState(rt, now, enabled) : { label: enabled ? 'unknown' : 'disabled' } }
  })
  const enabled = rows.filter((r) => r.enabled)
  const online = enabled.filter((r) => r.state.status === 'good').length
  const rank = (r: PeerRow) => ({ good: 0, warning: 1, serious: 2 } as Record<string, number>)[r.state.status ?? ''] ?? (r.enabled ? 3 : 4)
  const run = (p: Promise<unknown>) => p.then(() => setError(undefined), setError)
  const running = !!inst

  return (
    <Card flush title={<span class="row">{name}{data.staged.has(name) && <Badge status="accent">unapplied</Badge>}</span>} actions={<>
      {statusKnown && <Badge status={running ? 'good' : 'warning'}>{running ? 'running' : 'not running'}</Badge>}
      <Button variant="ghost" icon="system" aria-label={`Settings of ${name}`} title="Tunnel settings" onClick={() => go('vpn', 'tunnel', name)} />
      <Button variant="primary" icon="plus" aria-label={`Add device to ${name}`} onClick={() => go('vpn', 'add', name)}>Add device</Button>
    </>}>
      <div class="wg-facts">
        <span class="mono">UDP {str(iface.listen_port) || '–'}</span>
        <span class="mono">{list(iface.addresses).join(', ') || '–'}</span>
        <span class="row wg-pub">
          <span class="muted">key</span>
          {pub ? <><code class="wg-key" title={pub}>{pub}</code><CopyButton text={pub} /></> : <span class="muted">once applied</span>}
        </span>
        <span class="spacer" />
        {statusKnown && rows.length > 0 && <span class="muted">{online} of {enabled.length} online</span>}
      </div>
      {error ? <div style={{ padding: 'var(--sp-2)' }}><ErrorBox error={error} /></div> : null}
      {!rows.length ? <div class="empty">No devices yet</div> : (
        <Table<PeerRow> rows={rows} rowKey={(r) => r.s['.name']} onRowClick={(r) => go('vpn', 'peer', r.s['.name'])} rowClass={(r) => (r.enabled ? '' : 'disabled')} columns={[
          { key: 'status', label: 'Status', value: (r) => rank(r) * 1e10 - (r.rt?.latest_handshake || 0), render: (r) => (
            <span class="row nowrap"><PeerStatus r={r} />{r.rt?.latest_handshake
              ? <span class="muted small" title={`last handshake ${new Date(r.rt.latest_handshake * 1000).toLocaleString()}`}>{ago(Math.max(0, now - r.rt.latest_handshake))}</span> : null}</span>
          ) },
          { key: 'name', label: 'Name', value: (r) => str(r.s.description) || r.s['.name'], render: (r) => (
            <span class="row"><b>{str(r.s.description) || <span class="muted">{r.s['.name']}</span>}</b>{data.staged.has(r.s['.name']) && <Badge status="accent">unapplied</Badge>}</span>
          ) },
          { key: 'ips', label: 'Address', value: (r) => addrs(r.s), render: (r) => {
            const a = addrs(r.s).split(', ').filter(Boolean)
            return a.length ? <span class="mono nowrap" title={a.length > 1 ? a.join(', ') : undefined}>{a[0]}{a.length > 1 && <span class="muted"> +{a.length - 1}</span>}</span> : <span class="muted">–</span>
          } },
          { key: 'rx', label: '↓ / ↑', num: true, value: (r) => (r.rt?.transfer_rx ?? 0) + (r.rt?.transfer_tx ?? 0), render: (r) => (
            r.rt && (r.rt.transfer_rx || r.rt.transfer_tx) ? <span class="nowrap" title="received from the device / sent to it">{bytes(r.rt.transfer_rx)} <span class="muted">/</span> {bytes(r.rt.transfer_tx)}</span> : <span class="muted">–</span>
          ) },
          { key: 'on', label: 'On', value: (r) => +r.enabled, width: '56px', render: (r) => (
            // the row opens the peer drawer: keep the switch's click to itself
            <span onClick={(e) => e.stopPropagation()}>
              <Toggle on={r.enabled} label={`${r.enabled ? 'Disable' : 'Enable'} ${str(r.s.description)}`}
                onChange={(v) => run(v ? uci.remove('network', r.s['.name'], ['disabled']) : uci.set('network', r.s['.name'], { disabled: '1' }))} />
            </span>
          ) },
        ]} />
      )}
    </Card>
  )
}

/** The settings you change once: listen port (the WAN rule follows), MTU, the public key to share. */
function TunnelDrawer({ iface, inst, data, onClose }: { iface: UciSection; inst?: WgInstance; data: VpnData; onClose: () => void }) {
  const pub = useServerPub(iface, inst)
  const [port, setPort] = useState(str(iface.listen_port))
  const [mtu, setMtu] = useState(str(iface.mtu))
  const [error, setError] = useState<unknown>()
  const portOk = /^\d{1,5}$/.test(port) && +port >= 1 && +port <= 65535
  const mtuOk = !mtu || (/^\d+$/.test(mtu) && +mtu >= 1280 && +mtu <= 1500)
  const save = async () => {
    try {
      const old = str(iface.listen_port)
      if (port !== old) {
        await uci.set('network', iface['.name'], { listen_port: port })
        // keep the WAN rule that lets the tunnel in pointing at the new port
        for (const r of Object.values(data.fw)) {
          if (r['.type'] === 'rule' && str(r.src) === 'wan' && /udp/.test(str(r.proto)) && str(r.dest_port) === old) await uci.set('firewall', r['.name'], { dest_port: port })
        }
      }
      if (mtu !== str(iface.mtu)) await (mtu ? uci.set('network', iface['.name'], { mtu }) : uci.remove('network', iface['.name'], ['mtu']))
      onClose()
    } catch (e) { setError(e) }
  }
  return (
    <Drawer title={`Tunnel ${iface['.name']}`} onClose={onClose} footer={<>
      <span style={{ flex: 1 }} />
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" icon="check" disabled={!portOk || !mtuOk} onClick={save}>Stage changes</Button>
    </>}>
      <div class="stack" style={{ gap: 'var(--sp-3)' }}>
        {error ? <ErrorBox error={error} /> : null}
        <Field label="Public key">
          <span class="row">{pub ? <><code class="wg-key">{pub}</code><CopyButton text={pub} /></> : <span class="muted">available once applied</span>}</span>
        </Field>
        <div class="vpn-2col">
          <Field label="Listen port (UDP)" hint="The WAN rule follows" error={portOk ? undefined : '1 to 65535'}>
            <input class={`input mono${portOk ? '' : ' invalid'}`} value={port} aria-label="Listen port" onInput={(e) => setPort((e.target as HTMLInputElement).value.trim())} />
          </Field>
          <Field label="MTU" hint="1412 over PPPoE, 1280 for mobile" error={mtuOk ? undefined : '1280 to 1500'}>
            <input class={`input mono${mtuOk ? '' : ' invalid'}`} value={mtu} placeholder="1420" aria-label={`MTU of ${iface['.name']}`} onInput={(e) => setMtu((e.target as HTMLInputElement).value.trim())} />
          </Field>
        </div>
        <Field label="Address"><span class="mono">{list(iface.addresses).join(', ') || '–'}</span></Field>
      </div>
    </Drawer>
  )
}

function PeerStatus({ r }: { r: PeerRow }) {
  const tip: Record<string, string> = {
    online: 'Handshake in the last 3 minutes: connected.',
    stale: 'No handshake for over 3 minutes: the device is asleep, offline or out of range. It reconnects by itself when it has traffic.',
    never: 'This device has never completed a handshake: the config was not imported yet, or the endpoint / port is unreachable.',
    'not applied': 'Configured but not running: apply the pending changes.',
    disabled: 'Disabled: the router ignores this device.',
    unknown: 'Live status unavailable.',
  }
  return (
    <Tip text={tip[r.state.label] ?? r.state.label}>
      <span tabIndex={0}><Badge status={r.state.status}>{r.state.label}</Badge></span>
    </Tip>
  )
}

function PeerDrawer({ peer, inst, onClose }: { peer: UciSection; inst?: WgInstance; onClose: () => void }) {
  const [d, setD] = useState({
    description: str(peer.description),
    allowed_ips: list(peer.allowed_ips).join(' '),
    persistent_keepalive: str(peer.persistent_keepalive),
    endpoint_host: str(peer.endpoint_host),
    endpoint_port: str(peer.endpoint_port),
    route_allowed_ips: peer.route_allowed_ips === '1',
    preshared_key: str(peer.preshared_key),
  })
  const [error, setError] = useState<unknown>()
  const up = (p: Partial<typeof d>) => setD((x) => ({ ...x, ...p }))
  const rt = inst?.peers.get(str(peer.public_key))
  const ipsOk = list(d.allowed_ips).every((a) => /^[0-9a-fA-F:.]+\/\d{1,3}$/.test(a))
  const kaOk = !d.persistent_keepalive || /^\d{1,5}$/.test(d.persistent_keepalive)
  const pskOk = !d.preshared_key || KEY_RE.test(d.preshared_key)
  const [showPsk, setShowPsk] = useState(false)
  const pskChanged = d.preshared_key !== str(peer.preshared_key)
  const save = async () => {
    try {
      await setOptions('network', peer['.name'], {
        description: d.description, allowed_ips: list(d.allowed_ips), persistent_keepalive: d.persistent_keepalive,
        endpoint_host: d.endpoint_host, endpoint_port: d.endpoint_port, route_allowed_ips: d.route_allowed_ips ? '1' : '',
        preshared_key: d.preshared_key,
      }, peer)
      onClose()
    } catch (e) { setError(e) }
  }
  return (
    <Drawer title={`Device ${str(peer.description) || peer['.name']}`} onClose={onClose} footer={<>
      <Button variant="danger" icon="trash" onClick={() => uci.remove('network', peer['.name']).then(onClose, setError)}>Remove device</Button>
      <span style={{ flex: 1 }} />
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" icon="check" disabled={!ipsOk || !kaOk || !pskOk} onClick={save}>Stage changes</Button>
    </>}>
      <div class="stack" style={{ gap: 'var(--sp-3)' }}>
        {error ? <ErrorBox error={error} /> : null}
        <Field label="Name"><input class="input" value={d.description} onInput={(e) => up({ description: (e.target as HTMLInputElement).value })} /></Field>
        <Field label="Public key">
          <span class="row"><code class="wg-key">{str(peer.public_key)}</code><CopyButton text={str(peer.public_key)} /></span>
        </Field>
        <Field label="Allowed IPs" hint="Addresses this device may use inside the tunnel (its /32, plus networks behind it)" error={ipsOk ? undefined : 'CIDR notation, space separated: 10.200.0.2/32'}>
          <input class={`input mono${ipsOk ? '' : ' invalid'}`} value={d.allowed_ips} onInput={(e) => up({ allowed_ips: (e.target as HTMLInputElement).value })} />
        </Field>
        <label class="row" style={{ cursor: 'pointer' }}><Toggle on={d.route_allowed_ips} label="Route allowed IPs" onChange={(v) => up({ route_allowed_ips: v })} /> Add routes for networks behind this device</label>
        <div class="vpn-2col">
          <Field label="Endpoint host" hint="Only for site-to-site: the router dials out"><input class="input mono" value={d.endpoint_host} placeholder="none (device dials in)" onInput={(e) => up({ endpoint_host: (e.target as HTMLInputElement).value.trim() })} /></Field>
          <Field label="Endpoint port"><input class="input mono" value={d.endpoint_port} placeholder="51820" onInput={(e) => up({ endpoint_port: (e.target as HTMLInputElement).value.trim() })} /></Field>
        </div>
        <Field label="Preshared key" hint="Optional extra key; the device's config must carry the same one" error={pskOk ? undefined : 'A WireGuard key (44 characters, base64)'}>
          <div class="stack">
            <span class="row">
              <input class={`input mono${pskOk ? '' : ' invalid'}`} style={{ flex: 1 }} value={d.preshared_key} placeholder="none" aria-label="Preshared key"
                type={(showPsk ? 'text' : 'password') as 'password' /* preact's input typing rejects a union */} autocomplete="off" onFocus={() => setShowPsk(true)}
                onInput={(e) => up({ preshared_key: (e.target as HTMLInputElement).value.trim() })} />
              <Button icon="refresh" onClick={() => { up({ preshared_key: randomPsk() }); setShowPsk(true) }}>New</Button>
              {showPsk && d.preshared_key && <CopyButton text={d.preshared_key} />}
              {d.preshared_key && <Button variant="ghost" icon="trash" aria-label="Remove preshared key" onClick={() => up({ preshared_key: '' })} />}
            </span>
            {pskChanged && <span class="warn-line"><Icon name="warning" size={13} /> The device stops connecting until its config has {d.preshared_key ? 'this key' : 'no preshared key'} too.</span>}
          </div>
        </Field>
        <Field label="Keepalive (seconds)" hint="Router-side keepalive; usually only needed when the router dials out" error={kaOk ? undefined : 'A number of seconds'}>
          <input class="input mono" style={{ width: '120px' }} value={d.persistent_keepalive} placeholder="off" onInput={(e) => up({ persistent_keepalive: (e.target as HTMLInputElement).value.trim() })} />
        </Field>
        {rt && (
          <p class="secondary" style={{ margin: 0, fontSize: 'var(--fs-sm)' }}>
            Live: endpoint {rt.endpoint ?? 'unknown'}, last handshake {rt.latest_handshake ? ago(routerClock.now() - rt.latest_handshake) : 'never'}, {bytes(rt.transfer_rx)} received, {bytes(rt.transfer_tx)} sent.
          </p>
        )}
        <p class="muted" style={{ margin: 0, fontSize: 'var(--fs-sm)' }}>The device's private key is not stored on the router, so its config can't be shown again. To re-provision, remove it and add it again.</p>
      </div>
    </Drawer>
  )
}
