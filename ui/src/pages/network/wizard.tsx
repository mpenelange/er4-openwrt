// "New network" wizard: name -> where -> addressing (served here, DHCP client, PPPoE, unmanaged)
// -> DHCP -> firewall -> review. Every step
// starts from a sensible default (free VLAN id, free 192.168.X.0/24, DHCP on, a zone of its
// own with internet access), so the fast path is Next, Next, ..., Create. Creating stages the
// device, interface, dhcp section, zone and forwardings in one go.
import { useMemo, useState } from 'preact/hooks'
import { go } from '../../app'
import {
  NAME_RE, createNetwork, isPort, prefixToNetmask, str, subnet, suggestSubnet, suggestVid, usedVids,
  type NetModel, type NewNetwork, type NewProto, type PortName,
} from '../../api/net'
import { PortPanel } from '../../components/ports'
import { PoolBar } from '../../components/poolbar'
import { Badge, Button, Drawer, ErrorBox, Field, Segmented, Toggle } from '../../components/ui'
import { Icon, type IconName } from '../../components/icons'
import { validateCidr } from './parts'
import type { NetData } from './data'
import { portViews } from './parts'

type WhereKind = 'bridge' | 'portvlan' | 'port'
type Fw = NewNetwork['fw']

const PRESETS: { name: string; label: string; fw: Omit<Fw, 'zone'>; lease: string; hint: string }[] = [
  { name: 'guest', label: 'Guest', fw: { internet: true, toLan: false, fromLan: false, routerAccess: false }, lease: '2h', hint: 'internet only' },
  { name: 'iot', label: 'IoT', fw: { internet: true, toLan: false, fromLan: true, routerAccess: false }, lease: '24h', hint: 'isolated, LAN can manage' },
  { name: 'cams', label: 'Cameras', fw: { internet: false, toLan: false, fromLan: true, routerAccess: false }, lease: '7d', hint: 'no internet' },
  { name: 'servers', label: 'Servers', fw: { internet: true, toLan: false, fromLan: true, routerAccess: true }, lease: '12h', hint: 'DMZ-style' },
  { name: 'lab', label: 'Lab', fw: { internet: true, toLan: true, fromLan: true, routerAccess: true }, lease: '12h', hint: 'trusted' },
]
const LEASES = ['1h', '2h', '12h', '24h', '7d']
const STEPS = ['Name', 'Where', 'Addressing', 'DHCP', 'Firewall', 'Review'] as const

export function Wizard({ d, m, preset, onClose }: { d: NetData; m: NetModel; preset: string[]; onClose: () => void }) {
  const lanBridge = m.bridges[0]?.name
  const initWhere: WhereKind = preset[0] === 'port' ? 'port' : preset[0] === 'vlan' && preset[1] && isPort(preset[1]) ? 'portvlan' : lanBridge ? 'bridge' : 'portvlan'
  const initPort = (isPort(preset[1]) ? preset[1] : m.ports.find((p) => p.role === 'unused')?.name ?? 'eth3') as PortName

  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [where, setWhere] = useState<WhereKind>(initWhere)
  const [port, setPort] = useState<PortName>(initPort)
  const parent = where === 'bridge' ? (preset[0] === 'vlan' && preset[1] && !isPort(preset[1]) ? preset[1] : lanBridge!) : port
  const [vidRaw, setVid] = useState<string>()
  const vid = vidRaw ?? String(suggestVid(m, parent))
  const [cidrRaw, setCidr] = useState<string>()
  const cidr = cidrRaw ?? `${suggestSubnet(m, where === 'port' ? undefined : Number(vid))}/24`
  const [proto, setProtoRaw] = useState<NewProto>('static')
  const [user, setUser] = useState('')
  const [pass, setPass] = useState('')
  const [dhcpOn, setDhcpOn] = useState(true)
  const [poolSel, setPool] = useState<{ start: number; limit: number }>()
  const [lease, setLease] = useState('12h')
  const [zone, setZone] = useState<'new' | string>('new')
  const [fw, setFw] = useState<Omit<Fw, 'zone'>>({ internet: true, toLan: false, fromLan: true, routerAccess: false })
  // an uplink (DHCP client, PPPoE) usually joins the WAN zone; a served network gets its own
  const setProto = (p: NewProto) => {
    setProtoRaw(p)
    setZone(p === 'dhcp' || p === 'pppoe' ? m.wanZone : 'new')
  }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()

  const [ip, prefix] = cidr.split('/')
  const sn = subnet(ip, Number(prefix))
  const maxHost = sn ? sn.size - 2 : 254
  const smallStart = Math.ceil(maxHost / 4) + 1
  const pool = poolSel ?? (maxHost >= 254 ? { start: 100, limit: Math.min(150, maxHost - 99) } : { start: smallStart, limit: maxHost - smallStart + 1 })

  const nameErr = !name ? 'Required' : !NAME_RE.test(name) ? 'Lowercase letters, digits, _; starts with a letter; max 11'
    : m.nets.some((n) => n.name === name) || name === 'loopback' ? `A network called ${name} exists`
    : m.zones.some((z) => z.name === name) && zone === 'new' ? `A firewall zone called ${name} exists` : undefined
  const vidN = Number(vid)
  const vidErr = where === 'port' ? undefined : !/^\d+$/.test(vid) || vidN < 1 || vidN > 4094 ? '1 to 4094' : usedVids(m, parent).has(vidN) ? `VLAN ${vid} is already on ${parent}` : undefined
  const cidrErr = validateCidr(cidr, m)
  const portRole = m.ports.find((p) => p.name === port)!
  const portWarn = where === 'port' && portRole.role !== 'unused'
    ? portRole.role === 'wan' ? `${port} is the WAN port: the router loses its internet uplink.`
      : portRole.role === 'lan' ? `${port} leaves ${portRole.untagged?.kind === 'bridge' ? portRole.untagged.bridge : 'the bridge'}; devices plugged into it move to the new network.`
      : portRole.role === 'net' ? `${port} is ${portRole.label}'s port; ${portRole.label} loses it.` : undefined
    : undefined
  const addrOk = proto === 'static' ? !cidrErr : proto === 'pppoe' ? !!user.trim() && !/\s/.test(user.trim()) : true
  const valid = [!nameErr, !vidErr, addrOk, true, true, true]

  const spec: NewNetwork = {
    name,
    where: where === 'port' ? { kind: 'port', port } : { kind: 'vlan', parent, vid: vidN },
    proto, ...(proto === 'pppoe' && { pppoe: { username: user.trim(), password: pass } }),
    ipaddr: ip, prefix: Number(prefix),
    dhcp: { on: dhcpOn, start: pool.start, limit: pool.limit, leasetime: lease },
    fw: { zone, ...fw },
  }

  const applyPreset = (p: (typeof PRESETS)[number]) => {
    if (!m.nets.some((n) => n.name === p.name)) setName(p.name)
    setFw(p.fw)
    setLease(p.lease)
  }

  const create = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await createNetwork(m, spec)
      go('network', 'iface', name)
    } catch (e) {
      setError(e)
      setBusy(false)
    }
  }

  const summary = useMemo(() => reviewLines(m, spec), [m, JSON.stringify(spec)])
  const last = step === STEPS.length - 1

  return (
    <Drawer title="New network" onClose={onClose} footer={
      <>
        <span class="muted small">Nothing is live until you apply the staged changes.</span>
        <span class="spacer" />
        {step > 0 && <Button onClick={() => setStep(step - 1)}>Back</Button>}
        {!last && <Button variant="primary" disabled={!valid[step]} onClick={() => setStep(step + 1)}>Next <Icon name="arrowRight" size={14} /></Button>}
        {last && <Button variant="primary" icon="check" disabled={busy || !valid.every(Boolean)} onClick={create}>Create network</Button>}
      </>
    }>
      <ol class="stepper">
        {STEPS.map((s, i) => (
          <li class={i === step ? 'on' : i < step ? 'done' : ''}>
            <button type="button" disabled={i > step && !valid.slice(0, i).every(Boolean)} onClick={() => setStep(i)}>
              <span class="n">{i < step ? <Icon name="check" size={12} /> : i + 1}</span>{s}
            </button>
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div class="stack gap3">
          <Field label="Name" error={name ? nameErr : undefined} hint="Used for the interface and its firewall zone. Lowercase, max 11 characters.">
            <input class={`input mono${name && nameErr ? ' invalid' : ''}`} value={name} placeholder="e.g. guest" autoFocus
              onInput={(e) => setName((e.target as HTMLInputElement).value.toLowerCase())} onKeyDown={(e) => e.key === 'Enter' && !nameErr && setStep(1)} />
          </Field>
          <div>
            <div class="muted small" style={{ marginBottom: 'var(--sp-1)' }}>Start from a template (sets sensible firewall and lease defaults):</div>
            <div class="chips">
              {PRESETS.map((p) => (
                <button type="button" class={`chip${name === p.name ? ' on' : ''}`} onClick={() => applyPreset(p)}>
                  {p.label}<span class="muted small">{p.hint}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {step === 1 && (
        <div class="stack gap3">
          <div class="choice-grid three">
            {([
              ['bridge', 'network', `VLAN on ${lanBridge ?? 'the bridge'}`, `Tagged on every LAN port (${m.bridges[0]?.ports.join(', ') ?? '–'}). For VLAN-aware switches and access points.`],
              ['portvlan', 'arrowRight', 'VLAN on one port', 'Tagged on a single port, e.g. a trunk to a switch.'],
              ['port', 'bolt', 'A dedicated port', 'The whole port, untagged. Plug a device or switch straight in.'],
            ] as [WhereKind, IconName, string, string][]).filter(([k]) => k !== 'bridge' || lanBridge).map(([k, icon, t, desc]) => (
              <button type="button" class={`choice${where === k ? ' on' : ''}`} aria-pressed={where === k} onClick={() => { setWhere(k); setVid(undefined) }}>
                <span class="choice-title"><Icon name={icon} /> {t}</span>
                <span class="choice-desc">{desc}</span>
              </button>
            ))}
          </div>
          {where !== 'bridge' && (
            <div>
              <div class="muted small" style={{ marginBottom: 'var(--sp-1)' }}>Click the port:</div>
              <PortPanel compact ports={portViews(d, m)} selected={port} onSelect={(p) => { setPort(p as PortName); setVid(undefined) }} />
            </div>
          )}
          {where !== 'port' && (
            <Field label="VLAN ID" error={vidErr} hint={`Suggested: the first free multiple of 10 on ${parent}. Tagged switch ports must use the same ID.`}>
              <input class={`input num${vidErr ? ' invalid' : ''}`} style={{ width: 100 }} value={vid} inputMode="numeric" onInput={(e) => setVid((e.target as HTMLInputElement).value.trim())} />
            </Field>
          )}
          {portWarn && <div class="note warn"><Icon name="warning" /> {portWarn}</div>}
          <div class="note"><Icon name="bolt" /> Routed traffic between this network and the others (VLANs included) is hardware-offloaded.</div>
          <div class="kv"><span>Device</span><span class="mono">{where === 'port' ? port : `${parent}.${vid}`}</span></div>
        </div>
      )}

      {step === 2 && (
        <div class="stack gap3">
          <Segmented value={proto} onChange={setProto} options={[
            { value: 'static', label: 'This router serves it' }, { value: 'dhcp', label: 'DHCP client' }, { value: 'pppoe', label: 'PPPoE' }, { value: 'none', label: 'Unmanaged' },
          ]} />
          {proto === 'dhcp' && <div class="note"><Icon name="info" /> {name || 'The network'} gets its address from a DHCP server on the other side (a second uplink, a modem's LAN).</div>}
          {proto === 'none' && <div class="note"><Icon name="info" /> Just the device: no address, no DHCP. For bridging or a later setup.</div>}
          {proto === 'pppoe' && <>
            <Field label="PPPoE username" error={user && /\s/.test(user.trim()) ? 'No spaces' : undefined}>
              <input class="input mono" value={user} autocomplete="off" spellcheck={false} onInput={(e) => setUser((e.target as HTMLInputElement).value)} />
            </Field>
            <Field label="PPPoE password">
              <input class="input mono" type="password" value={pass} autocomplete="new-password" onInput={(e) => setPass((e.target as HTMLInputElement).value)} />
            </Field>
          </>}
          {proto === 'static' && <>
          <Field label="Router address and prefix" error={cidrErr} hint="The router's address on this network; clients get the rest of the subnet.">
            <input class={`input mono${cidrErr ? ' invalid' : ''}`} style={{ width: 200 }} value={cidr} onInput={(e) => { setCidr((e.target as HTMLInputElement).value.trim()); setPool(undefined) }} />
          </Field>
          <div class="chips">
            {[24, 25, 26, 27, 28].map((p) => (
              <button type="button" class={`chip${prefix === String(p) ? ' on' : ''}`} onClick={() => { setCidr(`${ip}/${p}`); setPool(undefined) }}>/{p}<span class="muted small">{2 ** (32 - p) - 2}</span></button>
            ))}
          </div>
          {sn && !cidrErr && (
            <div class="kv">
              <span>Subnet</span><span class="mono">{prefixToNetmask(sn.prefix)} · {sn.size - 2} hosts</span>
              <span>Clients</span><span class="mono">{intRange(sn, ip)}</span>
            </div>
          )}
          </>}
        </div>
      )}

      {step === 3 && proto !== 'static' && (
        <div class="note"><Icon name="info" /> No DHCP server: {proto === 'none' ? 'the network has no address' : `${name} is a client of the network on the other side`}.</div>
      )}
      {step === 3 && proto === 'static' && (
        <div class="stack gap3">
          <label class="row"><Toggle label="DHCP server" on={dhcpOn} onChange={setDhcpOn} /> Hand out addresses automatically (DHCP server)</label>
          {dhcpOn && sn && (
            <>
              <div class="muted small">Drag the handles to size the pool. Addresses outside it are free for static use and reservations.</div>
              <PoolBar subnet={sn} router={ip} start={pool.start} limit={pool.limit} leased={[]} reserved={[]} onChange={(start, limit) => setPool({ start, limit })} />
              <div class="row">
                <span class="muted small">Lease time</span>
                <div class="chips">{LEASES.map((t) => <button type="button" class={`chip${lease === t ? ' on' : ''}`} onClick={() => setLease(t)}>{t}</button>)}</div>
              </div>
            </>
          )}
        </div>
      )}

      {step === 4 && (
        <div class="stack gap3">
          <div class="chips">
            <button type="button" class={`chip${zone === 'new' ? ' on' : ''}`} onClick={() => setZone('new')}><Icon name="plus" size={12} /> New zone “{name}”</button>
            {m.zones.filter((z) => z.name !== m.wanZone || proto === 'dhcp' || proto === 'pppoe').map((z) => (
              <button type="button" class={`chip${zone === z.name ? ' on' : ''}`} onClick={() => setZone(str(z.name)!)}>join {str(z.name)}</button>
            ))}
          </div>
          {zone === 'new' ? (
            <div class="fw-grid">
              <FwToggle on={fw.internet} set={(v) => setFw({ ...fw, internet: v })} title="Internet access" desc={`${name} → ${m.wanZone}`} />
              <FwToggle on={fw.toLan} set={(v) => setFw({ ...fw, toLan: v })} title="Can reach LAN" desc={`${name} → lan`} />
              <FwToggle on={fw.fromLan} set={(v) => setFw({ ...fw, fromLan: v })} title="LAN can reach it" desc={`lan → ${name}`} />
              <FwToggle on={fw.routerAccess} set={(v) => setFw({ ...fw, routerAccess: v })} title="Router access"
                desc={fw.routerAccess ? 'web UI, SSH, all services' : 'DHCP and DNS only'} />
            </div>
          ) : (
            <div class="note"><Icon name="info" /> {name} joins zone {zone} and gets exactly its policies and forwardings.</div>
          )}
        </div>
      )}

      {step === 5 && (
        <div class="stack gap3">
          <div class="kv">
            <span>Network</span><span><strong>{name}</strong> · <span class="mono">{spec.where.kind === 'port' ? port : `${parent}.${vid}`}</span></span>
            <span>Address</span><span class="mono">{proto === 'static' ? cidr : proto === 'dhcp' ? 'from DHCP' : proto === 'pppoe' ? `PPPoE as ${user.trim()}` : 'none'}</span>
            <span>DHCP</span><span>{proto === 'static' && dhcpOn && sn ? `${intRange(sn, ip, pool.start, pool.limit)} · ${lease}` : 'off'}</span>
            <span>Firewall</span><span>{zone === 'new' ? `zone ${name}: ${[fw.internet && 'internet', fw.toLan && 'reaches lan', fw.fromLan && 'reachable from lan', fw.routerAccess ? 'router access' : 'DHCP/DNS only'].filter(Boolean).join(', ')}` : `joins ${zone}`}</span>
          </div>
          <div>
            <div class="muted small" style={{ marginBottom: 'var(--sp-1)' }}>Stages these UCI changes:</div>
            <ul class="plan">{summary.map((l) => <li><Badge>{l.config}</Badge> {l.text}</li>)}</ul>
          </div>
          {portWarn && <div class="note warn"><Icon name="warning" /> {portWarn}</div>}
          {error ? <ErrorBox error={error} /> : null}
        </div>
      )}
    </Drawer>
  )
}

function FwToggle({ on, set, title, desc }: { on: boolean; set: (v: boolean) => void; title: string; desc: string }) {
  return (
    <label class={`fw-toggle${on ? ' on' : ''}`}>
      <Toggle on={on} onChange={set} label={title} />
      <span class="stack" style={{ gap: 0 }}><strong>{title}</strong><span class="muted small mono">{desc}</span></span>
    </label>
  )
}

function intRange(sn: NonNullable<ReturnType<typeof subnet>>, router: string, start?: number, limit?: number) {
  const a = sn.network + (start ?? 1), b = start !== undefined ? sn.network + start + (limit ?? 1) - 1 : sn.broadcast - 1
  const f = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
  return `${f(a)} – ${f(b)}${start === undefined ? ` (router ${router})` : ''}`
}

function reviewLines(m: NetModel, s: NewNetwork) {
  const out: { config: string; text: string }[] = []
  if (s.where.kind === 'vlan') out.push({ config: 'network', text: `device ${s.where.parent}.${s.where.vid} (802.1Q, VLAN ${s.where.vid} on ${s.where.parent})` })
  else {
    const r = m.ports.find((p) => p.name === (s.where as { port: string }).port)!
    if (r.untagged?.kind === 'bridge') out.push({ config: 'network', text: `remove ${r.name} from ${r.untagged.bridge}` })
    if (r.untagged?.kind === 'net') out.push({ config: 'network', text: `detach ${r.untagged.nets.map((n) => n.name).join(', ')} from ${r.name}` })
  }
  out.push({ config: 'network', text: `interface ${s.name}: ${s.proto === 'static' ? `static ${s.ipaddr}/${s.prefix}` : s.proto === 'dhcp' ? 'DHCP client' : s.proto === 'pppoe' ? `PPPoE (${s.pppoe?.username})` : 'unmanaged'}` })
  if (s.proto === 'static') out.push({ config: 'dhcp', text: s.dhcp.on ? `dhcp ${s.name}: start ${s.dhcp.start}, limit ${s.dhcp.limit}, lease ${s.dhcp.leasetime}` : `dhcp ${s.name}: disabled` })
  if (s.fw.zone === 'new') {
    out.push({ config: 'firewall', text: `zone ${s.name}: input ${s.fw.routerAccess ? 'ACCEPT' : 'REJECT'}, forward REJECT` })
    if (!s.fw.routerAccess) out.push({ config: 'firewall', text: `rule ${s.name}-DHCP-DNS: allow udp/tcp 53, 67 to the router` })
    if (s.fw.internet) out.push({ config: 'firewall', text: `forwarding ${s.name} → ${m.wanZone}` })
    if (s.fw.toLan) out.push({ config: 'firewall', text: `forwarding ${s.name} → lan` })
    if (s.fw.fromLan) out.push({ config: 'firewall', text: `forwarding lan → ${s.name}` })
  } else out.push({ config: 'firewall', text: `zone ${s.fw.zone}: add network ${s.name}` })
  return out
}
