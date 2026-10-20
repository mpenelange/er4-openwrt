// IPsec / IKEv2 on the VPN page (strongSwan, UCI 'ipsec'; see api/ipsec.ts):
//   - set up once: the xfrm network 'ipsec', its zone, WAN rules for IKE/NAT-T/ESP, proposals
//   - phones and laptops: the built-in IKEv2 clients (iOS, macOS, Windows, Android 11+) with a
//     username and password; the router's own CA signs its server certificate
//   - site-to-site: another router or a cloud gateway, pre-shared key, both sides' subnets
import { useState } from 'preact/hooks'
import { uci } from '../../api/uci'
import { useAsync, usePoll } from '../../api/store'
import { stagedSections, zones as zonesOf } from '../../api/firewall'
import { cidr, cidrStr, interfaceSubnets, list } from '../../api/ip4'
import {
  RW, ipsec, ipsecNetwork, mobileconfig, randomSecret, removeRoadWarrior, removeSite, saveRoadWarrior, saveSite, setupIpsec, siteRemotes, users,
  type IpsecSa, type IpsecStatus, type SiteSettings,
} from '../../api/ipsec'
import type { UciConfig, UciSection } from '../../api/types'
import { bytes, duration } from '../../components/format'
import { Badge, Button, Card, Drawer, ErrorBox, Field, Toggle } from '../../components/ui'
import { MultiChips } from '../../components/chips'
import { CopyButton } from '../../components/copy'
import { Icon } from '../../components/icons'
import { go } from '../../app'
import type { VpnData } from './shared'

const save = (name: string, text: string, type: string) => {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type }))
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

export function IpsecCard({ data, sub, id }: { data: VpnData; sub?: string; id?: string }) {
  const st = usePoll(ipsec.status, 5000).samples[0]
  const cfg = useAsync(async () => {
    const [c, staged] = await Promise.all([uci.get('ipsec').catch(() => ({} as UciConfig)), stagedSections()])
    return { c, staged: staged.ipsec ?? new Set<string>() }
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<unknown>()
  if (!st?.installed || !cfg.data) return null
  const c = cfg.data.c
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true)
    try { await f(); setErr(undefined) } catch (e) { setErr(e) } finally { setBusy(false) }
  }
  const wired = !!ipsecNetwork(data.net)
  const lan = Object.entries(interfaceSubnets(data.net)).filter(([n]) => !/^wan/.test(n) && n !== 'loopback' && data.net[n]?.proto === 'static').map(([n, s]) => ({ net: n, cidr: cidrStr(s) }))
  const sites = siteRemotes(c)
  const editing = sub === 'ipsec' && id ? (id === 'new' ? 'new' : c[id]) : undefined
  return (
    <Card title={<span class="row">IPsec / IKEv2 {cfg.data.staged.size > 0 && <Badge status="accent">unapplied</Badge>}</span>}
      actions={wired ? <Badge status={st.running ? 'good' : 'warning'}>{st.running ? 'running' : 'not running'}</Badge> : null}>
      <div class="stack">
        {err != null && <ErrorBox error={err} />}
        {!wired ? <SetUp data={data} busy={busy} onSetUp={(reach) => run(() => setupIpsec(data.net, data.fw, c, reach))} /> : <>
          <RoadWarriors c={c} st={st} data={data} lan={lan} busy={busy} run={run} />
          <section>
            <h4 class="section-h">Site-to-site <span style={{ flex: 1 }} /><Button variant="ghost" icon="plus" onClick={() => go('vpn', 'ipsec', 'new')}>Add a site</Button></h4>
            {sites.length ? sites.map((r) => <SiteRow r={r} c={c} sa={st.sas?.find((x) => x.name === r['.name'])} />)
              : <p class="muted small" style={{ margin: 0 }}>none</p>}
          </section>
        </>}
      </div>
      {editing && <SiteDrawer c={c} data={data} lan={lan} site={editing === 'new' ? undefined : editing as UciSection} onClose={() => go('vpn')} />}
    </Card>
  )
}

function SetUp({ data, busy, onSetUp }: { data: VpnData; busy: boolean; onSetUp: (reach: string[]) => void }) {
  const inside = zonesOf(data.fw).filter((z) => !z.masq && !['ipsec', 'vpn', 'tailscale'].includes(z.name))
  const [reach, setReach] = useState<string[]>(inside.some((z) => z.name === 'lan') ? ['lan'] : [])
  return (
    <div class="stack">
      <span class="secondary">Built-in VPN of phones and laptops (no app), and tunnels to other routers or cloud networks.</span>
      <div class="row" style={{ flexWrap: 'wrap' }}>
        <span class="muted small">May reach</span>
        <MultiChips value={reach} onChange={setReach} label="Zones IPsec may reach" options={inside.map((z) => ({ value: z.name, label: z.name, slot: z.slot }))} />
        <span style={{ flex: 1 }} />
        <Button variant="primary" disabled={busy} onClick={() => onSetUp(reach)}>Set up IPsec</Button>
      </div>
    </div>
  )
}

// ---- phones and laptops ------------------------------------------------------------------------
function RoadWarriors({ c, st, data, lan, busy, run }: {
  c: UciConfig; st: IpsecStatus; data: VpnData; lan: { net: string; cidr: string }[]; busy: boolean; run: (f: () => Promise<unknown>) => void
}) {
  const rw = c[RW]
  const [host, setHost] = useState(st.server?.san[0] ?? data.wanAddr ?? '')
  const [full, setFull] = useState(true)
  const [shown, setShown] = useState<{ user: string; password: string } | null>(null)
  const [newUser, setNewUser] = useState('')
  const hostOk = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(host)
  const pool = '10.201.0.0/24'
  const router = data.net.lan?.ipaddr ? String(data.net.lan.ipaddr) : undefined
  const enable = () => run(async () => {
    await ipsec.cert(host)
    await saveRoadWarrior(c, data.net, { host, pool, dns: router ? [router] : [], full, lanSubnets: lan.map((l) => l.cidr) })
    if (full) {
      // full tunnel: ipsec -> wan, so the phone's internet goes through home
      const f = Object.values(data.fw).some((s) => s['.type'] === 'forwarding' && s.src === 'ipsec' && s.dest === 'wan')
      if (!f) await uci.add('firewall', 'forwarding', { src: 'ipsec', dest: 'wan' })
    }
  })
  const us = users(c)
  const userOk = /^[A-Za-z0-9._@-]{1,64}$/.test(newUser) && !us.some((u) => u.id === newUser)
  const addUser = () => run(async () => {
    const password = randomSecret(20)
    await uci.add('ipsec', 'mschapv2_secrets', { id: newUser, secret: password })
    setShown({ user: newUser, password })
    setNewUser('')
  })
  const serverName = String(rw?.local_identifier ?? '')
  const profile = (user: string, password?: string) => st.ca && save(`${user}-er4-vpn.mobileconfig`,
    mobileconfig({ host: serverName, user, password, ca: st.ca, label: `Home (${serverName})` }), 'application/x-apple-aspen-config')
  if (!rw) return (
    <section>
      <h4 class="section-h">Phones and laptops</h4>
      <div class="row" style={{ flexWrap: 'wrap' }}>
        <Field label="Clients connect to" hint="This router's public address or a DNS name pointing at it; it goes into the certificate" error={host && !hostOk ? 'A host name or IPv4 address' : undefined}>
          <input class={`input mono${host && !hostOk ? ' invalid' : ''}`} value={host} placeholder="vpn.example.net" onInput={(e) => setHost((e.target as HTMLInputElement).value.trim())} />
        </Field>
        <label class="row"><Toggle on={full} label="All internet traffic through home" onChange={setFull} /> All internet traffic through home</label>
        <span style={{ flex: 1 }} />
        <Button variant="primary" disabled={busy || !hostOk} onClick={enable}>Turn on</Button>
      </div>
    </section>
  )
  const sas = st.sas?.filter((s) => s.name === RW) ?? []
  return (
    <section>
      <h4 class="section-h">Phones and laptops <span class="muted small mono">{serverName}</span>
        {st.server && <span class="muted small">certificate until {st.server.not_after}</span>}
        <span style={{ flex: 1 }} />
        <Button variant="ghost" icon="power" aria-label="Turn off phones and laptops" title="Turn off phones and laptops (removes the users)" onClick={() => run(() => removeRoadWarrior(c, data.net))}>Turn off</Button>
      </h4>
      <div class="stack">
        {us.map((u) => {
          const on = sas.find((s) => s.eap_id === u.id)
          return (
            <div class="row ipsec-user">
              {on ? <Badge status="good">connected</Badge> : <Badge>offline</Badge>}
              <b>{String(u.id)}</b>
              {on && <span class="muted small mono">{on.vips.join(', ')} from {on.remote_host} · {bytes(on.children[0]?.bytes_out ?? 0)} sent</span>}
              <span style={{ flex: 1 }} />
              <Button variant="ghost" icon="download" disabled={!st.ca} title="Apple profile (iPhone, iPad, Mac): the CA and the VPN, without the password" onClick={() => profile(String(u.id))}>Profile</Button>
              <Button variant="ghost" icon="refresh" title="New password" onClick={() => run(async () => { const p = randomSecret(20); await uci.set('ipsec', u['.name'], { secret: p }); setShown({ user: String(u.id), password: p }) })}>Password</Button>
              <Button variant="ghost" icon="trash" aria-label={`Remove ${String(u.id)}`} onClick={() => run(() => uci.remove('ipsec', u['.name']))} />
            </div>
          )
        })}
        {shown && (
          <div class="note">
            <Icon name="info" /> <span><b>{shown.user}</b>'s password: <code class="mono">{shown.password}</code></span> <CopyButton text={shown.password} />
            <Button variant="ghost" icon="download" disabled={!st.ca} onClick={() => profile(shown.user, shown.password)}>Profile with password</Button>
            <span class="muted small">shown once</span>
          </div>
        )}
        <div class="row">
          <input class={`input mono${newUser && !userOk ? ' invalid' : ''}`} style={{ width: 180 }} placeholder="username" aria-label="New VPN user" value={newUser}
            onInput={(e) => setNewUser((e.target as HTMLInputElement).value.trim())} onKeyDown={(e) => e.key === 'Enter' && userOk && addUser()} />
          <Button icon="plus" disabled={busy || !userOk} onClick={addUser}>Add user</Button>
          <span style={{ flex: 1 }} />
          {st.ca && <Button variant="ghost" icon="download" onClick={() => save('er4-vpn-ca.crt', st.ca!, 'application/x-x509-ca-cert')}>CA certificate</Button>}
        </div>
      </div>
    </section>
  )
}

// ---- site-to-site ----------------------------------------------------------------------------------
function SiteRow({ r, c, sa }: { r: UciSection; c: UciConfig; sa?: IpsecSa }) {
  const t = c[list(r.tunnel)[0] ?? '']
  const up = sa?.state === 'ESTABLISHED' && sa.children.some((x) => x.state === 'INSTALLED')
  return (
    <div class="row ipsec-site clickable" onClick={() => go('vpn', 'ipsec', r['.name'])}>
      {up ? <Badge status="good">up</Badge> : <Badge status="warning">{sa?.state.toLowerCase() ?? 'down'}</Badge>}
      <b>{r['.name']}</b>
      <span class="mono small">{String(r.gateway)}</span>
      <span class="muted small mono">{list(t?.local_subnet).join(', ')} ⇄ {list(t?.remote_subnet).join(', ')}</span>
      <span style={{ flex: 1 }} />
      {up && sa && <span class="muted small">{duration(sa.established)} · {bytes(sa.children[0]?.bytes_in ?? 0)} in</span>}
    </div>
  )
}

function SiteDrawer({ c, data, lan, site, onClose }: { c: UciConfig; data: VpnData; lan: { net: string; cidr: string }[]; site?: UciSection; onClose: () => void }) {
  const t = site ? c[list(site.tunnel)[0] ?? ''] : undefined
  const [d, setD] = useState<SiteSettings>(() => ({
    name: site?.['.name'] ?? '', gateway: String(site?.gateway ?? ''), psk: String(site?.pre_shared_key ?? randomSecret(32)),
    local: t ? list(t.local_subnet) : lan.slice(0, 1).map((l) => l.cidr), remote: t ? list(t.remote_subnet) : [],
    remoteId: site?.remote_identifier ? String(site.remote_identifier) : '', localId: site?.local_identifier ? String(site.local_identifier) : '',
  }))
  const [remoteText, setRemoteText] = useState(d.remote.join(' '))
  const [err, setErr] = useState<unknown>()
  const up = (p: Partial<SiteSettings>) => setD((x) => ({ ...x, ...p }))
  const remote = remoteText.split(/[\s,]+/).filter(Boolean)
  const errs = {
    name: !/^[a-z][a-z0-9_]{0,14}$/.test(d.name) ? 'Lower-case letters, digits and _' : !site && c[d.name] ? 'Exists already' : undefined,
    gateway: !/^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/.test(d.gateway) ? 'The other side\'s public address or name' : undefined,
    psk: d.psk.length < 16 ? 'At least 16 characters' : /["\s]/.test(d.psk) ? 'No spaces or quotes' : undefined,
    remote: !remote.length || remote.some((x) => !cidr(x)) ? 'Their subnets, e.g. 10.0.0.0/24' : undefined,
    local: !d.local.length ? 'Pick at least one' : undefined,
  }
  const invalid = Object.values(errs).some(Boolean)
  const submit = async () => {
    try { await saveSite(c, data.net, { ...d, remote }, site); onClose() } catch (e) { setErr(e) }
  }
  return (
    <Drawer title={site ? `Site ${site['.name']}` : 'New site-to-site tunnel'} onClose={onClose} footer={<>
      {site && <Button variant="danger" icon="trash" onClick={() => removeSite(c, data.net, site).then(onClose, setErr)}>Delete</Button>}
      <span style={{ flex: 1 }} />
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" icon="check" disabled={invalid} onClick={submit}>{site ? 'Stage changes' : 'Add site'}</Button>
    </>}>
      <div class="stack" style={{ gap: 'var(--sp-3)' }}>
        {err != null && <ErrorBox error={err} />}
        {!site && <Field label="Name" error={d.name ? errs.name : undefined}><input class="input mono" style={{ width: 160 }} value={d.name} placeholder="office" onInput={(e) => up({ name: (e.target as HTMLInputElement).value.trim() })} /></Field>}
        <Field label="Other side" error={d.gateway ? errs.gateway : undefined}><input class="input mono" value={d.gateway} placeholder="203.0.113.50" onInput={(e) => up({ gateway: (e.target as HTMLInputElement).value.trim() })} /></Field>
        <Field label="Pre-shared key" hint="Both sides need the same" error={errs.psk}>
          <span class="row">
            <input class={`input mono${errs.psk ? ' invalid' : ''}`} style={{ flex: 1 }} value={d.psk} aria-label="Pre-shared key" onInput={(e) => up({ psk: (e.target as HTMLInputElement).value })} />
            <CopyButton text={d.psk} />
            <Button icon="refresh" onClick={() => up({ psk: randomSecret(32) })}>New</Button>
          </span>
        </Field>
        <Field label="Our networks" error={errs.local}>
          <MultiChips value={d.local} onChange={(local) => up({ local })} label="Our networks" options={lan.map((l) => ({ value: l.cidr, label: <>{l.net} <span class="mono muted">{l.cidr}</span></> }))} />
        </Field>
        <Field label="Their networks" error={remoteText ? errs.remote : undefined}>
          <input class={`input mono${remoteText && errs.remote ? ' invalid' : ''}`} value={remoteText} placeholder="10.0.0.0/24" aria-label="Their networks" onInput={(e) => setRemoteText((e.target as HTMLInputElement).value)} />
        </Field>
        <details class="disclosure" open={!!(d.remoteId || d.localId)}>
          <summary><Icon name="chevronRight" size={14} /> Identities</summary>
          <div class="stack">
            <Field label="Our ID" hint="Default: our address"><input class="input mono" value={d.localId} onInput={(e) => up({ localId: (e.target as HTMLInputElement).value.trim() })} /></Field>
            <Field label="Their ID" hint="Default: their address"><input class="input mono" value={d.remoteId} onInput={(e) => up({ remoteId: (e.target as HTMLInputElement).value.trim() })} /></Field>
          </div>
        </details>
        <p class="muted small" style={{ margin: 0 }}>IKEv2, AES-256-GCM with ECP-256 (or AES-256/SHA-256 with MODP-2048). The router starts the tunnel and keeps it up.</p>
      </div>
    </Drawer>
  )
}
