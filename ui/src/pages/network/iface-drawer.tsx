// Network drawer: everything about one logical network. Every control stages on its own
// (no form-wide save): pick a protocol, click a value to edit it, drag the DHCP pool, click a
// zone. Deleting stages the removal of everything the network brought with it.
import { useState } from 'preact/hooks'
import { go } from '../../app'
import { followIface, ifaceCtl } from '../../api/router'
import { uci } from '../../api/uci'
import {
  add6in4, addIpv6Uplink, deleteNetwork, ipToInt, tunnels6in4, deletePlan, inSubnet, ipv6Uplinks, list, pool, relayMaster, setDhcp, setNetZone, setV6Mode, str, suggestSubnet, usedVids,
  prefixToNetmask, v6Mode, type Net, type NetModel, type V6Mode,
} from '../../api/net'
import { PortPanel } from '../../components/ports'
import { LiveTraffic } from '../../components/traffic'
import { PoolBar } from '../../components/poolbar'
import { InlineEdit } from '../../components/inline'
import { Badge, Button, Drawer, Empty, ErrorBox, Modal, Segmented, Toggle } from '../../components/ui'
import { Icon } from '../../components/icons'
import type { UciSection } from '../../api/types'
import { duration } from '../../components/format'
import { liveState, netUnapplied, PROTO_LABEL, whereText, type NetData } from './data'
import { portViews, saveCidr, StatusBadge, Swatch, validateCidr } from './parts'

const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/
const LEASES = ['1h', '6h', '12h', '24h', '7d']

export function IfaceDrawer({ d, m, name, onClose }: { d: NetData; m: NetModel; name: string; onClose: () => void }) {
  const n = m.nets.find((x) => x.name === name)
  if (!n) {
    return (
      <Drawer title={name} onClose={onClose}>
        <Empty>No network called “{name}” (deleted, or not created yet).</Empty>
      </Drawer>
    )
  }
  const live = d.ifaces?.find((i) => i.interface === n.name)
  const plan = deletePlan(m, n)
  const del = async () => { await deleteNetwork(m, n); onClose() }
  const isWg = n.proto === 'wireguard'
  const virtual = n.where.kind === 'virtual'

  return (
    <Drawer title={<span class="row"><Swatch slot={n.slot} /> {n.name} <StatusBadge d={d} n={n} />{netUnapplied(d, n) && <Badge status="accent">unapplied</Badge>}</span>}
      onClose={onClose} footer={
        <>
          <Button variant="danger" icon="trash" onClick={del}>Delete network</Button>
          <span class="spacer" />
          <Button variant="primary" onClick={onClose}>Done</Button>
        </>
      }>
      <div class="stack gap3">
        <div class="kv">
          <span>Carried on</span><span>{whereText(n)} {n.device && <span class="mono muted">({n.device})</span>}</span>
          <span>Live address</span><span class="mono">{[...(live?.['ipv4-address'] ?? []), ...(live?.['ipv6-address'] ?? [])].map((a) => `${a.address}/${a.mask}`).join(', ') || '–'}</span>
          {live?.['dns-server']?.length ? <><span>Upstream DNS</span><span class="mono">{live['dns-server'].join(', ')}</span></> : null}
          {live?.up && live.uptime !== undefined ? <><span>Up for</span><span class="num">{duration(live.uptime)}</span></> : null}
          {live && <><span>Connection</span><span><IfaceControl d={d} n={n} /></span></>}
        </div>

        {!virtual && (
          <section>
            <h4 class="section-h">Where</h4>
            <PortPanel compact ports={portViews(d, m).map((p) => {
              const r = m.ports.find((x) => x.name === p.name)!
              const carried = r.untagged?.nets.includes(n) || r.tagged.some((t) => t.nets.includes(n))
              return { ...p, idle: !carried }
            })} onSelect={(p) => go('network', 'port', p)} />
            {n.where.kind === 'vlan' && <VlanId m={m} n={n} />}
            {n.where.kind === 'none' && <div class="note warn"><Icon name="warning" /> Not on any port. Click a port above and choose “Its own network”, or delete it.</div>}
          </section>
        )}

        {live?.up && (live.l3_device ?? n.device) && (
          <section>
            <h4 class="section-h">Traffic <span class="muted small mono">{live.l3_device ?? n.device}</span></h4>
            {/* rx on the router's side of the network = what the network sends */}
            <LiveTraffic device={(live.l3_device ?? n.device)!} slot={n.slot} inLabel={n.wan ? 'download' : `from ${n.name}`} outLabel={n.wan ? 'upload' : `to ${n.name}`} />
          </section>
        )}

        {isWg ? (
          <div class="note"><Icon name="info" /> WireGuard tunnel {n.ipaddr && <span class="mono">{n.ipaddr}/{n.prefix}</span>}. Peers and keys are on the <a href="#/vpn">VPN</a> page.</div>
        ) : n.proto === '6in4' ? (
          <Tunnel6in4 d={d} m={m} n={n} />
        ) : (
          <Addressing d={d} m={m} n={n} />
        )}

        {n.proto === 'dhcpv6' && <Dhcpv6Client d={d} n={n} />}
        {n.wan && n.proto !== 'dhcpv6' && !virtual && <Ipv6Uplink d={d} m={m} n={n} />}
        {n.proto === 'static' && !isWg && <DhcpServer d={d} m={m} n={n} />}
        {n.proto === 'static' && !n.wan && !isWg && <Lan6 d={d} m={m} n={n} />}

        <section>
          <h4 class="section-h">Firewall zone <a class="small" href="#/firewall">rules →</a></h4>
          <div class="chips">
            {m.zones.map((z) => {
              const zn = str(z.name)!
              return (
                <button type="button" class={`chip${zn === n.zoneName ? ' on' : ''}`} aria-pressed={zn === n.zoneName} onClick={() => zn !== n.zoneName && setNetZone(m, n, zn)}>
                  {zn}<span class="muted small">{list(z.network).filter((x) => x !== n.name).join(', ')}</span>
                </button>
              )
            })}
          </div>
          {n.zone ? <ZoneSummary m={m} zone={n.zoneName!} /> : <div class="note warn"><Icon name="warning" /> In no zone: the firewall drops its traffic. Pick one.</div>}
        </section>

        <section>
          <h4 class="section-h">Delete</h4>
          <p class="muted small" style={{ margin: 0 }}>Deleting stages the removal of:</p>
          <ul class="plan">{plan.map((p) => <li><span class="mono muted">{p.config}</span> {p.what}</li>)}</ul>
          {n.name === 'lan' && <div class="note warn"><Icon name="warning" /> This is probably how you reach the router; unconfirmed changes revert by themselves after 60 s.</div>}
        </section>
      </div>
    </Drawer>
  )
}

function IfaceControl({ d, n }: { d: NetData; n: Net }) {
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState<unknown>()
  const [confirm, setConfirm] = useState(false)
  const st = liveState(d, n)
  const stopped = st.kind === 'down' && st.reason === 'stopped'
  const run = (what: string, fn: () => Promise<unknown>) => async () => {
    setBusy(what)
    setErr(undefined)
    setConfirm(false)
    try { await fn() } catch (e) { setErr(e) }
    setBusy('')
    followIface()
  }
  const stop = run('stop', () => ifaceCtl.down(n.name))
  return (
    <span class="stack">
      <span class="row iface-ctl">
        {stopped
          ? <Button icon="power" disabled={!!busy} onClick={run('start', () => ifaceCtl.up(n.name))}>Start</Button>
          : <>
            <Button icon="refresh" disabled={!!busy} title={`Take ${n.name} down and up again${n.proto === 'pppoe' ? ' (redials)' : n.proto.startsWith('dhcp') ? ' (new DHCP exchange)' : ''}; unapplied changes stay unapplied`}
              onClick={run('restart', () => ifaceCtl.restart(n.name))}>Restart</Button>
            {['dhcp', 'dhcpv6'].includes(d.ifaces?.find((i) => i.interface === n.name)?.proto ?? n.proto) &&
              <Button disabled={!!busy} title="Ask the DHCP server to renew the lease" onClick={run('renew', () => ifaceCtl.renew(n.name))}>Renew</Button>}
            <Button icon="power" disabled={!!busy} onClick={n.wan ? stop : () => setConfirm(true)}>Stop</Button>
          </>}
        {busy && <span class="muted small">{busy === 'stop' ? 'stopping' : busy === 'start' ? 'starting' : `${busy}ing`}…</span>}
      </span>
      {err != null && <ErrorBox error={err} />}
      {confirm && (
        <Modal title={`Stop ${n.name}?`} onClose={() => setConfirm(false)} footer={<>
          <Button onClick={() => setConfirm(false)}>Cancel</Button>
          <Button variant="danger" icon="power" onClick={stop}>Stop {n.name}</Button>
        </>}>
          <p style={{ margin: 0 }}>{n.name} stays down until it's started again (or the router reboots). If this browser reaches the router through {n.name}, the connection drops and there's no way back from here: use another network, the console, or a reboot.</p>
        </Modal>
      )}
    </span>
  )
}

function VlanId({ m, n }: { m: NetModel; n: Net }) {
  const w = n.where as Extract<Net['where'], { kind: 'vlan' }>
  const save = async (v: string) => {
    const dev = `${w.parent}.${v}`
    if (w.section) await uci.set('network', w.section, { vid: v, name: dev })
    await uci.set('network', n.name, { device: dev })
  }
  return (
    <div class="kv" style={{ marginTop: 'var(--sp-2)' }}>
      <span>VLAN ID</span>
      <span><InlineEdit label="VLAN ID" value={String(w.vid)} width={80} onSave={save} validate={(v) => {
        const x = Number(v)
        if (!/^\d+$/.test(v) || x < 1 || x > 4094) return '1 to 4094'
        if (x !== w.vid && usedVids(m, w.parent).has(x)) return `VLAN ${x} already exists on ${w.parent}`
      }} /> <span class="muted small">tagged on {w.parent}{m.bridges.some((b) => b.name === w.parent) ? ' (every bridge port)' : ''}</span></span>
      {w.section && <>
        <span>Priority (PCP)</span>
        <span class="chips" title="802.1p priority on frames sent out tagged (egress_qos_mapping 0:N); some ISPs require it, e.g. 1 for PPPoE or 5 for IPTV">
          {['', '1', '2', '3', '4', '5', '6', '7'].map((p) => {
            const cur = /^0:([0-7])$/.exec(list(m.network[w.section!]?.egress_qos_mapping).join(' '))?.[1] ?? ''
            return <button type="button" class={`chip${cur === p ? ' on' : ''}`} aria-pressed={cur === p}
              onClick={() => (p ? uci.set('network', w.section!, { egress_qos_mapping: [`0:${p}`] }) : uci.remove('network', w.section!, ['egress_qos_mapping']))}>{p || 'none'}</button>
          })}
        </span>
      </>}
    </div>
  )
}

const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i
const IP6_CIDR_RE = /^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}\/\d{1,3}$/i

function Addressing({ d, m, n }: { d: NetData; m: NetModel; n: Net }) {
  const s = n.sec
  const setProto = async (p: string) => {
    // credentials don't outlive PPPoE
    if (n.proto === 'pppoe' && p !== 'pppoe') await uci.remove('network', n.name, ['username', 'password', 'service', 'ac'].filter((o) => s[o] !== undefined))
    if (p === 'static' && !n.ipaddr) {
      const ip = suggestSubnet(m, n.where.kind === 'vlan' ? n.where.vid : undefined)
      await uci.set('network', n.name, { proto: p, ipaddr: ip, netmask: prefixToNetmask(24) })
    } else await uci.set('network', n.name, { proto: p })
  }
  const setOpt = (opt: string, isList = false) => async (v: string) => {
    if (!v) await uci.remove('network', n.name, [opt])
    else await uci.set('network', n.name, { [opt]: isList ? v.split(/[\s,]+/).filter(Boolean) : v })
  }
  const devSec = Object.values(m.network).find((x) => x['.type'] === 'device' && x.name === n.device)
  const mtu = str(devSec?.mtu) ?? (n.proto === 'pppoe' ? undefined : str(s.mtu)) ?? ''
  // MTU and MAC belong on the device section (created when missing)
  const setDev = (opt: 'mtu' | 'mtu6' | 'macaddr') => async (v: string) => {
    if (devSec) await (v ? uci.set('network', devSec['.name'], { [opt]: v }) : uci.remove('network', devSec['.name'], [opt]))
    else if (v && n.device) await uci.add('network', 'device', { name: n.device, [opt]: v })
    // on a PPPoE network the interface's own mtu is the PPP MTU: leave it
    if (s[opt] !== undefined && !(opt === 'mtu' && n.proto === 'pppoe')) await uci.remove('network', n.name, [opt])
  }
  const setMtu = setDev('mtu')
  const mac = str(devSec?.macaddr) ?? str(s.macaddr) ?? ''
  const hwMac = n.device ? d.devs?.[n.device]?.macaddr : undefined
  const IP6_RE = /^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}$/i
  const ipList = (v: string) => v.split(/[\s,]+/).filter(Boolean).find((x) => !IP_RE.test(x) && !IP6_RE.test(x)) ? 'Space-separated IP addresses' : undefined
  // PPPoE dials out over this network's device: only where there is one (a port or a VLAN on one)
  const canPppoe = n.where.kind === 'port' || n.where.kind === 'vlan'
  const protos = n.proto === 'dhcpv6'
    ? [{ value: n.proto, label: PROTO_LABEL[n.proto] }]
    : [{ value: 'static', label: 'Static' }, { value: 'dhcp', label: 'DHCP client' }, ...(canPppoe || n.proto === 'pppoe' ? [{ value: 'pppoe', label: 'PPPoE' }] : []), { value: 'none', label: 'Unmanaged' }]
  return (
    <section>
      <h4 class="section-h">Addressing</h4>
      <div class="row" style={{ marginBottom: 'var(--sp-2)' }}>
        <Segmented value={n.proto} options={protos} onChange={setProto} />
      </div>
      <div class="kv">
        {n.proto === 'static' && (
          <>
            <span>Address</span>
            <span><InlineEdit mono label="Address" value={n.ipaddr ? `${n.ipaddr}/${n.prefix}` : ''} validate={(v) => validateCidr(v, m, n.name)} onSave={(v) => saveCidr(n, v)} />
              {n.subnet && <span class="muted small"> {n.subnet.size - 2} host addresses</span>}</span>
            <span>Gateway</span>
            <span><InlineEdit mono label="Gateway" placeholder="none (this router is the gateway)" value={str(s.gateway) ?? ''} validate={(v) => (v && !IP_RE.test(v) ? 'IPv4 address' : undefined)} onSave={setOpt('gateway')} /></span>
            <span>IPv6 address</span>
            <span><InlineEdit mono label="IPv6 address" placeholder="none" value={list(s.ip6addr).join(' ')} width={260} onSave={setOpt('ip6addr', true)}
              validate={(v) => (v.split(/[\s,]+/).filter(Boolean).find((x) => !IP6_CIDR_RE.test(x)) ? 'IPv6 address/prefix, e.g. 2001:db8::2/64' : undefined)} /></span>
            {(n.wan || s.ip6gw !== undefined || s.ip6prefix !== undefined) && <>
              <span>IPv6 gateway</span>
              <span><InlineEdit mono label="IPv6 gateway" placeholder="none" value={str(s.ip6gw) ?? ''} width={260} onSave={setOpt('ip6gw')}
                validate={(v) => (v && !IP6_RE.test(v) ? 'IPv6 address' : undefined)} /></span>
              <span>Routed prefix</span>
              <span title="ip6prefix: a prefix the ISP routes to you (static IPv6 business lines), handed out to the LANs like a delegated one">
                <InlineEdit mono label="Routed IPv6 prefix" placeholder="none" value={list(s.ip6prefix).join(' ')} width={260} onSave={setOpt('ip6prefix', true)}
                  validate={(v) => (v.split(/[\s,]+/).filter(Boolean).find((x) => !IP6_CIDR_RE.test(x)) ? 'IPv6 prefix, e.g. 2001:db8:100::/48' : undefined)} /></span>
            </>}
          </>
        )}
        {n.proto === 'pppoe' && (
          <>
            <span>Username</span>
            <span><InlineEdit mono label="PPPoE username" placeholder="required" value={str(s.username) ?? ''} onSave={setOpt('username')}
              validate={(v) => (/\s/.test(v) ? 'No spaces' : undefined)} />{!s.username && <> <Badge status="warning">needed to connect</Badge></>}</span>
            <span>Password</span>
            <span><InlineEdit mono label="PPPoE password" placeholder="required" value={str(s.password) ?? ''} secret onSave={setOpt('password')} /></span>
            <span>Service name</span>
            <span><InlineEdit mono label="PPPoE service name" placeholder="any" value={str(s.service) ?? ''} onSave={setOpt('service')} /></span>
            <span>IPv6</span>
            <span><Segmented value={str(s.ipv6) === '0' ? '0' : 'auto'} onChange={(v) => (v === 'auto' ? uci.remove('network', n.name, ['ipv6']) : uci.set('network', n.name, { ipv6: '0' }))}
              options={[{ value: 'auto', label: 'Ask the ISP' }, { value: '0', label: 'Off' }]} /></span>
            <span>Keepalive</span>
            <span title="LCP echo: hang up after this many unanswered echoes, sent every N seconds (keepalive 'failures interval'); 0 turns it off">
              <InlineEdit mono label="PPPoE keepalive" placeholder="5 failures, every 1 s" value={str(s.keepalive) ?? ''} width={110} onSave={setOpt('keepalive')}
                validate={(v) => (v && !/^\d{1,3}( \d{1,3})?$/.test(v) ? '"failures interval", e.g. 5 5' : undefined)} /></span>
            <span>PPP MTU</span>
            <span><InlineEdit label="PPP MTU" placeholder="1492" value={str(s.mtu) ?? ''} width={90} onSave={setOpt('mtu')}
              validate={(v) => (v && !(Number(v) >= 576 && Number(v) <= 1500) ? '576 to 1500' : undefined)} />
              <span class="muted small"> inside the tunnel; 1500 needs a port MTU of 1508 (RFC 4638)</span></span>
          </>
        )}
        {(n.proto === 'dhcp' || n.proto === 'pppoe') && (
          <>
            <span>Use upstream DNS</span>
            <span><Toggle label={`Use DNS servers from ${n.proto === 'pppoe' ? 'the ISP' : 'DHCP'}`} on={s.peerdns !== '0'} onChange={(on) => (on ? uci.remove('network', n.name, ['peerdns']) : uci.set('network', n.name, { peerdns: '0' }))} /></span>
          </>
        )}
        {n.proto === 'dhcp' && (
          <>
            <span>Hostname sent</span>
            <span><InlineEdit label="Hostname sent" placeholder="router's hostname" value={str(s.hostname) ?? ''} onSave={setOpt('hostname')} /></span>
          </>
        )}
        {(n.proto === 'dhcp' || n.proto === 'pppoe' || (n.proto === 'static' && s.gateway)) && (
          <>
            <span>Default route</span>
            <span title="defaultroute: use this uplink's gateway for the internet. Off for a second uplink used only by routes or rules">
              <Toggle label="Use as default route" on={s.defaultroute !== '0'} onChange={(on) => (on ? uci.remove('network', n.name, ['defaultroute']) : uci.set('network', n.name, { defaultroute: '0' }))} /></span>
            <span>Route metric</span>
            <span title="metric: with several uplinks, the lowest metric wins; the others are the fallback">
              <InlineEdit mono label="Route metric" placeholder="0" value={str(s.metric) ?? ''} width={80} onSave={setOpt('metric')}
                validate={(v) => (v && !/^\d{1,5}$/.test(v) ? 'A number' : undefined)} /></span>
          </>
        )}
        {n.proto !== 'none' && (
          <>
            <span>DNS servers</span>
            <span><InlineEdit mono label="DNS servers" placeholder={n.proto === 'dhcp' || n.proto === 'pppoe' ? 'from upstream' : 'none'} value={list(s.dns).join(' ')} validate={ipList} onSave={setOpt('dns', true)} /></span>
          </>
        )}
        <span>MTU</span>
        <span><InlineEdit label="MTU" placeholder={n.proto === 'pppoe' ? '1500 (PPPoE: 1492 inside)' : '1500 (default)'} value={mtu} width={90} onSave={setMtu}
          validate={(v) => (v && !(Number(v) >= 576 && Number(v) <= 9600) ? '576 to 9600' : undefined)} />
          {n.where.kind === 'vlan' && <span class="muted small"> set on {n.device}; the parent needs at least as much</span>}</span>
        {(devSec?.mtu6 !== undefined || n.wan) && n.device && <>
          <span>IPv6 MTU</span>
          <span><InlineEdit label="IPv6 MTU" placeholder="same as MTU" value={str(devSec?.mtu6) ?? ''} width={90} onSave={setDev('mtu6')}
            validate={(v) => (v && !(Number(v) >= 1280 && Number(v) <= 9600) ? '1280 to 9600' : undefined)} /></span>
        </>}
        {(n.where.kind === 'port' || n.where.kind === 'vlan') && <>
          <span>MAC address</span>
          <span><InlineEdit mono label="MAC address" placeholder={hwMac ? `${hwMac} (port's own)` : "port's own"} value={mac} width={170}
            validate={(v) => (v && !MAC_RE.test(v) ? 'aa:bb:cc:dd:ee:ff' : v && parseInt(v.slice(0, 2), 16) & 1 ? 'Not a multicast address' : undefined)}
            onSave={(v) => setDev('macaddr')(v.toLowerCase())} />{mac && <span class="muted small"> replaces {n.device}'s own{hwMac && hwMac !== mac ? ` (${hwMac})` : ''}</span>}</span>
        </>}
      </div>
    </section>
  )
}

function DhcpServer({ d, m, n }: { d: NetData; m: NetModel; n: Net }) {
  const p = pool(n)
  const hosts = Object.values(m.dhcp).filter((s) => s['.type'] === 'host' && str(s.ip) && inSubnet(n.subnet!, str(s.ip)!))
  const leases = (d.leases ?? []).filter((l) => l.expires >= 0 && n.subnet && inSubnet(n.subnet, l.ipaddr))
  const setPool = (start: number, limit: number) => uci.set('dhcp', n.dhcp!['.name'], { start: String(start), limit: String(limit) })
  return (
    <section>
      <h4 class="section-h">
        DHCP server
        <Toggle label={`DHCP server on ${n.name}`} on={n.dhcpOn} onChange={(on) => setDhcp(n, on)} />
        <a class="small" href="#/devices">devices →</a>
      </h4>
      {n.dhcpOn && n.subnet && n.dhcp ? (
        <div class="stack">
          <PoolBar subnet={n.subnet} router={n.ipaddr} start={p.start} limit={p.limit} onChange={setPool}
            leased={leases.map((l) => ({ ip: l.ipaddr, label: l.hostname ?? l.macaddr }))}
            reserved={hosts.map((h) => ({ ip: str(h.ip)!, label: str(h.name) ?? str(h.mac) ?? '' }))} />
          <div class="row">
            <span class="muted small">Options</span>
            <span class="dhcp-opts" title="dnsmasq dhcp_option, e.g. 3,<router> 6,<dns>,<dns> 42,<ntp> 66,<tftp server> 150,<tftp ip>; empty value (6,) sends none">
              <InlineEdit mono label="DHCP options" placeholder="none" value={list(n.dhcp.dhcp_option).join(' ')} onSave={(v) => setDhcpOptions(n, v)}
                validate={(v) => v.split(/\s+/).filter(Boolean).find((o) => !DHCP_OPT_RE.test(o)) ? 'Space-separated, each <code or option:name>,<value>' : undefined} />
            </span>
          </div>
          <label class="row" title="dynamicdhcp=0: devices without a reservation get no address">
            <Toggle label="Only reserved devices" on={str(n.dhcp.dynamicdhcp) === '0'}
              onChange={(v) => (v ? uci.set('dhcp', n.dhcp!['.name'], { dynamicdhcp: '0' }) : uci.remove('dhcp', n.dhcp!['.name'], ['dynamicdhcp']))} />
            <span class="small">Only reserved devices get an address</span>
          </label>
          <div class="row">
            <span class="muted small">Lease time</span>
            <div class="chips">
              {LEASES.map((t) => <button type="button" class={`chip${p.leasetime === t ? ' on' : ''}`} onClick={() => uci.set('dhcp', n.dhcp!['.name'], { leasetime: t })}>{t}</button>)}
              {!LEASES.includes(p.leasetime) && <span class="chip on">{p.leasetime}</span>}
            </div>
          </div>
        </div>
      ) : <p class="muted small" style={{ margin: 0 }}>Off: clients need static addresses{n.dhcpOn ? '' : ' (or another DHCP server)'}.</p>}
    </section>
  )
}

// ---- IPv6 ------------------------------------------------------------------------------------
const PREFIXES = ['auto', '48', '56', '60', '64'] as const

/** A WAN network's IPv6: the DHCPv6 client riding on it, or a way to add one. */
function Ipv6Uplink({ d, m, n }: { d: NetData; m: NetModel; n: Net }) {
  const ups = ipv6Uplinks(m, n)
  const tunnels = tunnels6in4(m)
  const auto = n.proto === 'pppoe' && str(n.sec.ipv6) !== '0' // netifd adds <name>_6 by itself
  const tunnelRows = tunnels.map((t) => {
    const l = d.ifaces?.find((i) => i.interface === t.name)
    return <>
      <span>Tunnel</span>
      <span><a href={`#/network/iface/${t.name}`}>{t.name}</a> <span class="muted small">6in4</span>{' '}
        {list(t.sec.ip6prefix).length ? <span class="mono">{list(t.sec.ip6prefix).join(', ')}</span> : null}{' '}
        <span class="muted small">{l?.up ? 'up' : l ? 'down' : 'not applied yet'}</span></span>
    </>
  })
  const addTunnel = <Button icon="plus" onClick={async () => go('network', 'iface', await add6in4(m))}>Add 6in4 tunnel</Button>
  return (
    <section>
      <h4 class="section-h">IPv6</h4>
      {ups.length > 0 || tunnels.length > 0 ? (
        <div class="kv">
          {tunnelRows}
          {ups.map((u) => {
            const l = d.ifaces?.find((i) => i.interface === u.name)
            const pfx = l?.['ipv6-prefix']?.[0]
            return <>
              <span>Via</span>
              <span><a href={`#/network/iface/${u.name}`}>{u.name}</a> <span class="muted small">DHCPv6</span>{' '}
                {pfx ? <span class="mono">{pfx.address}/{pfx.mask}</span> : <span class="muted small">{l?.up ? 'no prefix' : l ? 'down' : 'not applied yet'}</span>}</span>
            </>
          })}
        </div>
      ) : auto ? (
        <p class="muted small" style={{ margin: 0 }}>Over the PPPoE session: netifd starts a DHCPv6 client ({n.name}_6) once it's up.</p>
      ) : (
        <div class="row">
          <span class="muted small">None</span>
          <span class="spacer" />
          <Button icon="plus" onClick={async () => go('network', 'iface', await addIpv6Uplink(m, n))}>Add DHCPv6 client</Button>
        </div>
      )}
      {/* no IPv6 from the ISP (or none wanted from it): a tunnel broker */}
      {!tunnels.length && <div class="row" style={{ marginTop: 'var(--sp-2)' }}><span class="spacer" />{addTunnel}</div>}
    </section>
  )
}

/** private (RFC 1918) or carrier-grade NAT (100.64/10) IPv4: a tunnel broker can't reach it */
const behindNat = (ip?: string) => {
  const v = ip ? ipToInt(ip) : undefined
  if (v === undefined) return false
  const inNet = (net: string, bits: number) => (v >>> (32 - bits)) === (ipToInt(net)! >>> (32 - bits))
  return inNet('10.0.0.0', 8) || inNet('172.16.0.0', 12) || inNet('192.168.0.0', 16) || inNet('100.64.0.0', 10)
}

/** A 6in4 tunnel (proto 6in4): the broker's endpoint and the addresses it assigned. With the
 *  tunnel ID and update key, netifd tells Hurricane Electric the WAN address whenever it changes. */
function Tunnel6in4({ d, m, n }: { d: NetData; m: NetModel; n: Net }) {
  const s = n.sec
  const setOpt = (opt: string, isList = false) => (v: string) => (v
    ? uci.set('network', n.name, { [opt]: isList ? v.split(/[\s,]+/).filter(Boolean) : v })
    : uci.remove('network', n.name, [opt]))
  const wanAddr = m.nets.filter((x) => x.wan && x.proto !== '6in4').map((x) => d.ifaces?.find((i) => i.interface === x.name)?.['ipv4-address']?.[0]?.address).find(Boolean)
  const l = d.ifaces?.find((i) => i.interface === n.name)
  const errs = (l as { errors?: { code: string }[] } | undefined)?.errors?.map((e) => e.code) ?? []
  return (
    <section>
      <h4 class="section-h">6in4 tunnel</h4>
      {behindNat(wanAddr) && (
        <div class="note warn"><Icon name="warning" /> The WAN address {wanAddr} is private: the router in front must pass IP protocol 41 to it (often called DMZ), and the broker must be given the public address.</div>
      )}
      {errs.length > 0 && <div class="note warn"><Icon name="warning" /> netifd: {errs.join(', ')}</div>}
      <div class="kv">
        <span>Tunnel server</span>
        <span><InlineEdit mono label="Tunnel server IPv4" placeholder="e.g. 192.0.2.26" value={str(s.peeraddr) ?? ''} width={200} onSave={setOpt('peeraddr')}
          validate={(v) => (v && ipToInt(v) === undefined ? 'The broker server\'s IPv4 address' : undefined)} /></span>
        <span>Your tunnel address</span>
        <span title="Client IPv6 address (the router's end of the tunnel)">
          <InlineEdit mono label="Tunnel IPv6 address" placeholder="e.g. 2001:db8:1f0a:12::2/64" value={str(s.ip6addr) ?? ''} width={280} onSave={setOpt('ip6addr')}
            validate={(v) => (v && !IP6_CIDR_RE.test(v) ? 'IPv6 address/prefix' : undefined)} /></span>
        <span>Routed prefix</span>
        <span title="The /64 or /48 the broker routes to you: handed out to the LANs like an ISP's delegated prefix">
          <InlineEdit mono label="Routed IPv6 prefix" placeholder="e.g. 2001:db8:1f0b:12::/64" value={list(s.ip6prefix).join(' ')} width={280} onSave={setOpt('ip6prefix', true)}
            validate={(v) => (v.split(/[\s,]+/).filter(Boolean).find((x) => !IP6_CIDR_RE.test(x)) ? 'IPv6 prefix, e.g. 2001:db8:1f0b:12::/64' : undefined)} /></span>
        <span>MTU</span>
        <span><InlineEdit label="Tunnel MTU" placeholder="1280" value={str(s.mtu) ?? ''} width={90} onSave={setOpt('mtu')}
          validate={(v) => (v && !(/^\d+$/.test(v) && +v >= 1280 && +v <= 1480) ? '1280 to 1480' : undefined)} /></span>
        <span>Tunnel ID</span>
        <span title="Hurricane Electric: with the username and update key, the router updates the tunnel's IPv4 endpoint itself">
          <InlineEdit mono label="Tunnel ID" placeholder="none" value={str(s.tunnelid) ?? ''} width={120} onSave={setOpt('tunnelid')}
            validate={(v) => (v && !/^\d+$/.test(v) ? 'A number' : undefined)} /></span>
        <span>Username</span>
        <span><InlineEdit label="Tunnel broker username" placeholder="none" value={str(s.username) ?? ''} width={200} onSave={setOpt('username')} /></span>
        <span>Update key</span>
        <span><InlineEdit mono label="Tunnel update key" placeholder="none" value={str(s.password) ?? ''} width={240} onSave={setOpt('password')}
          display={str(s.password) ? <span class="mono">••••••••</span> : undefined} /></span>
        {l?.up && <><span>Gateway</span><span class="mono">{l.route?.find((r) => r.mask === 0 && r.target === '::')?.nexthop ?? <span class="muted">–</span>}</span></>}
      </div>
    </section>
  )
}

/** DHCPv6 client (wan6): what the ISP gave, and what to ask for. */
function Dhcpv6Client({ d, n }: { d: NetData; n: Net }) {
  const setOpt = (opt: string) => (v: string) => (v ? uci.set('network', n.name, { [opt]: v.replace(/:/g, '').toLowerCase() }) : uci.remove('network', n.name, [opt]))
  const l = d.ifaces?.find((i) => i.interface === n.name)
  const s = n.sec
  const pfx = l?.['ipv6-prefix'] ?? []
  const gw = l?.route?.find((r) => r.mask === 0 && r.target === '::')?.nexthop
  const reqaddr = str(s.reqaddress) ?? 'try'
  const reqprefix = str(s.reqprefix) ?? 'auto'
  const set = (opt: string, def: string) => (v: string) => (v === def ? uci.remove('network', n.name, [opt]) : uci.set('network', n.name, { [opt]: v }))
  return (
    <section>
      <h4 class="section-h">IPv6 from the ISP</h4>
      <div class="kv">
        <span>Delegated prefix</span><span class="mono">{pfx.length ? pfx.map((p) => `${p.address}/${p.mask}`).join(', ') : <span class="muted">–</span>}</span>
        <span>Gateway</span><span class="mono">{gw ?? <span class="muted">–</span>}</span>
        <span>Ask for an address</span>
        <span><Segmented value={reqaddr} onChange={set('reqaddress', 'try')}
          options={[{ value: 'try', label: 'Try' }, { value: 'force', label: 'Require' }, { value: 'none', label: "Don't ask" }]} /></span>
        <span>Prefix size</span>
        <span class="chips">
          {PREFIXES.map((p) => <button type="button" class={`chip${reqprefix === p ? ' on' : ''}`} aria-pressed={reqprefix === p}
            title={p === 'auto' ? 'whatever the ISP offers' : `ask for a /${p}`} onClick={() => set('reqprefix', 'auto')(p)}>{p === 'auto' ? 'auto' : `/${p}`}</button>)}
          <button type="button" class={`chip${reqprefix === 'no' ? ' on' : ''}`} aria-pressed={reqprefix === 'no'} onClick={() => set('reqprefix', 'auto')('no')}>none</button>
          {!(PREFIXES as readonly string[]).includes(reqprefix) && reqprefix !== 'no' && <span class="chip on">/{reqprefix}</span>}
        </span>
        <span>Keep prefix on restart</span>
        <span title="Don't release the lease when wan6 goes down (norelease), so LANs keep their addresses across a restart">
          <Toggle label="Keep prefix on restart" on={s.norelease === '1'} onChange={(v) => (v ? uci.set('network', n.name, { norelease: '1' }) : uci.remove('network', n.name, ['norelease']))} /></span>
        <span>Share WAN /64</span>
        <span title="For ISPs that give one /64 on the WAN and no delegated prefix: hand it on to the LANs (extendprefix)">
          <Toggle label="Share WAN /64" on={s.extendprefix === '1'} onChange={(v) => (v ? uci.set('network', n.name, { extendprefix: '1' }) : uci.remove('network', n.name, ['extendprefix']))} /></span>
        <span>Client ID</span>
        <span><InlineEdit mono label="DHCPv6 client ID" placeholder="router's DUID" value={str(s.clientid) ?? ''} width={260} onSave={setOpt('clientid')}
          validate={(v) => (v && !/^([0-9a-f]{2}){4,130}$/i.test(v.replace(/:/g, '')) ? 'A DUID in hex' : undefined)} /></span>
      </div>
    </section>
  )
}

const ASSIGN = ['64', '60'] as const
const V6_MODES: { value: Exclude<V6Mode, 'other'>; label: string }[] = [
  { value: 'off', label: 'Off' }, { value: 'slaac', label: 'SLAAC' }, { value: 'dhcpv6', label: 'SLAAC + DHCPv6' }, { value: 'stateful', label: 'DHCPv6 only' }, { value: 'relay', label: 'Relay' },
]

/** IPv6 on a LAN: its slice of the delegated prefix (ip6assign) and how clients get addresses. */
function Lan6({ d, m, n }: { d: NetData; m: NetModel; n: Net }) {
  const l = d.ifaces?.find((i) => i.interface === n.name)
  const size = str(n.sec.ip6assign)
  const asg = l?.['ipv6-prefix-assignment'] ?? []
  const mode = v6Mode(n.dhcp)
  const setSize = (v?: string) => (v ? uci.set('network', n.name, { ip6assign: v }) : uci.remove('network', n.name, ['ip6assign']))
  return (
    <section>
      <h4 class="section-h">IPv6</h4>
      <div class="kv">
        <span>Prefix</span>
        <span class="chips">
          <button type="button" class={`chip${!size ? ' on' : ''}`} aria-pressed={!size} onClick={() => setSize()}>off</button>
          {ASSIGN.map((p) => <button type="button" class={`chip${size === p ? ' on' : ''}`} aria-pressed={size === p}
            title={`a /${p} from the delegated prefix`} onClick={() => setSize(p)}>/{p}</button>)}
          {size && !(ASSIGN as readonly string[]).includes(size) && <span class="chip on">/{size}</span>}
        </span>
        {size && <>
          <span>Subnet ID</span>
          <span title="ip6hint: which /64 of the delegated prefix this network gets, so its addresses stay put (e.g. 10 → …:10::/64)">
            <InlineEdit mono label="Subnet ID" placeholder="auto" value={str(n.sec.ip6hint) ?? ''} width={110}
              validate={(v) => (v && !/^[0-9a-f]{1,4}$/i.test(v) ? 'Hex, up to 4 digits' : undefined)}
              onSave={(v) => (v ? uci.set('network', n.name, { ip6hint: v.toLowerCase() }) : uci.remove('network', n.name, ['ip6hint']))} /></span>
          <span>Assigned</span>
          <span class="mono">{asg.length ? asg.map((a) => `${a.address}/${a.mask}`).join(', ') : <span class="muted">{l ? 'none yet (no delegated prefix)' : '–'}</span>}</span>
        </>}
        <>
          <span>Clients</span>
          <span>{mode === 'other'
            ? <span class="muted">{str(n.dhcp?.ra)} / {str(n.dhcp?.dhcpv6)} (set elsewhere)</span>
            : <Segmented value={mode} options={V6_MODES} onChange={(v) => setV6Mode(n, v, m)} />}</span>
          {['slaac', 'dhcpv6', 'stateful'].includes(mode) && n.dhcp && <RaOptions n={n} dhcp={n.dhcp} />}
          {mode === 'relay' && <><span /><span class="muted small">The ISP's RA and DHCPv6 pass through from {relayMaster(m)?.name ?? 'the WAN'} (odhcpd relay); no prefix of our own.</span></>}
        </>
      </div>
    </section>
  )
}

/** Router advertisement details for a LAN (odhcpd): default router, priority, announced DNS and domain. */
function RaOptions({ n, dhcp }: { n: Net; dhcp: UciSection }) {
  const sec = dhcp['.name']
  const set = (opt: string, def: string) => (v: string) => (v === def ? uci.remove('dhcp', sec, [opt]) : uci.set('dhcp', sec, { [opt]: v }))
  const setList = (opt: string) => (v: string) => {
    const l = v.split(/[\s,]+/).filter(Boolean)
    return l.length ? uci.set('dhcp', sec, { [opt]: l }) : uci.remove('dhcp', sec, [opt])
  }
  return <>
    <span>Default router</span>
    <span title="ra_default: announce the router as default gateway even when it has no IPv6 internet route (e.g. ULA-only)">
      <Segmented value={str(dhcp.ra_default) === '1' || str(dhcp.ra_default) === '2' ? '1' : '0'} onChange={set('ra_default', '0')}
        options={[{ value: '0', label: 'With an uplink' }, { value: '1', label: 'Always' }]} /></span>
    <span>Priority</span>
    <span title="ra_preference: which router clients prefer when there are several on this network">
      <Segmented value={str(dhcp.ra_preference) ?? 'medium'} onChange={set('ra_preference', 'medium')}
        options={[{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]} /></span>
    <span>DNS servers</span>
    <span><InlineEdit mono label={`IPv6 DNS announced on ${n.name}`} placeholder="this router" value={list(dhcp.dns).join(' ')} width={260}
      validate={(v) => (v.split(/[\s,]+/).filter(Boolean).find((a) => !/^[0-9a-f:]+$/i.test(a) || !a.includes(':')) ? 'IPv6 addresses' : undefined)}
      onSave={setList('dns')} /></span>
    <span>Search domain</span>
    <span><InlineEdit mono label={`Search domain announced on ${n.name}`} placeholder="the local domain" value={list(dhcp.domain).join(' ')} width={260}
      validate={(v) => (v.split(/[\s,]+/).filter(Boolean).find((x) => !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(x)) ? 'Domain names' : undefined)}
      onSave={setList('domain')} /></span>
  </>
}

const DHCP_OPT_RE = /^(tag:[\w-]+,)?(force:)?(\d{1,3}|option6?:[a-z0-9-]+),\S*$/i
const setDhcpOptions = (n: Net, v: string) => {
  const opts = v.split(/\s+/).filter(Boolean)
  return opts.length ? uci.set('dhcp', n.dhcp!['.name'], { dhcp_option: opts }) : uci.remove('dhcp', n.dhcp!['.name'], ['dhcp_option'])
}

function ZoneSummary({ m, zone }: { m: NetModel; zone: string }) {
  const z = m.zones.find((x) => x.name === zone)!
  const fw = Object.values(m.firewall).filter((s) => s['.type'] === 'forwarding')
  const out = fw.filter((f) => f.src === zone).map((f) => str(f.dest))
  const inn = fw.filter((f) => f.dest === zone).map((f) => str(f.src))
  return (
    <div class="kv small" style={{ marginTop: 'var(--sp-2)' }}>
      <span>To the router</span><span>{z.input === 'ACCEPT' ? 'allowed' : 'blocked (except explicit rules)'}</span>
      <span>Can reach</span><span>{out.length ? out.map((x) => (x === m.wanZone ? 'internet' : x)).join(', ') : 'nothing else'}</span>
      <span>Reachable from</span><span>{inn.length ? inn.join(', ') : 'nobody'}</span>
    </div>
  )
}
