// "Import a tunnel": paste (or open) a WireGuard .conf from a VPN provider or the other site.
// Stages a new interface (its private key, address, listen port, MTU) with one peer section per
// [Peer], and puts the interface in a firewall zone. The router dials out (Endpoint), so no WAN
// rule is added. DNS from the file is shown, not applied (it would replace the LAN's resolver).
import { useMemo, useState } from 'preact/hooks'
import { uci } from '../../api/uci'
import { zones as zonesOf } from '../../api/firewall'
import { freeWgName, parseConf, peerType } from '../../api/wireguard'
import { Badge, Button, Drawer, ErrorBox, Field } from '../../components/ui'
import { Chips } from '../../components/chips'
import { Icon } from '../../components/icons'
import type { VpnData } from './shared'

export function ImportTunnel({ data, onClose, onDone }: { data: VpnData; onClose: () => void; onDone: (iface: string) => void }) {
  const [text, setText] = useState('')
  const [name, setName] = useState(() => freeWgName(data.net))
  const zones = zonesOf(data.fw)
  const [zone, setZone] = useState(zones.some((z) => z.name === 'vpn') ? 'vpn' : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  const conf = useMemo(() => (text.trim() ? parseConf(text) : undefined), [text])
  const nameErr = !/^[a-z][a-z0-9_]{0,9}$/.test(name) ? 'Lower-case letters, digits and _, up to 10' : data.net[name] ? `${name} already exists` : undefined
  const missing = conf && !conf.iface.privateKey ? 'The file has no PrivateKey: it must be the config for this side' : conf && !conf.iface.addresses.length ? 'The file has no Address' : undefined
  const fullTunnel = conf?.peers.some((p) => p.allowedIps.some((a) => a === '0.0.0.0/0' || a === '::/0'))
  const ok = conf && !conf.errors.length && !missing && !nameErr

  const load = async (f?: File) => { if (f) setText(await f.text()) }
  const save = async () => {
    if (!conf) return
    setBusy(true)
    try {
      const z = zones.find((x) => x.name === zone)
      // a new zone when none is picked: masqueraded, like an uplink (VPN providers expect that)
      if (z) await uci.set('firewall', z.section, { network: [...z.networks, name] })
      else await uci.add('firewall', 'zone', { name, network: [name], input: 'REJECT', output: 'ACCEPT', forward: 'REJECT', masq: '1', mtu_fix: '1' })
      for (const [i, p] of conf.peers.entries()) {
        await uci.add('network', peerType(name), {
          description: conf.peers.length > 1 ? `${name} peer ${i + 1}` : `${name} remote`,
          public_key: p.publicKey!, allowed_ips: p.allowedIps, route_allowed_ips: '1',
          ...(p.presharedKey ? { preshared_key: p.presharedKey } : {}),
          ...(p.endpointHost ? { endpoint_host: p.endpointHost, endpoint_port: p.endpointPort ?? '51820' } : {}),
          ...(p.keepalive ? { persistent_keepalive: p.keepalive } : {}),
        })
      }
      await uci.add('network', 'interface', {
        proto: 'wireguard', private_key: conf.iface.privateKey!, addresses: conf.iface.addresses,
        ...(conf.iface.listenPort ? { listen_port: conf.iface.listenPort } : {}), ...(conf.iface.mtu ? { mtu: conf.iface.mtu } : {}),
      }, name)
      onDone(name)
    } catch (e) {
      setError(e)
      setBusy(false)
    }
  }

  return (
    <Drawer title="Import a tunnel" onClose={onClose} footer={<>
      <span style={{ flex: 1 }} />
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" icon="check" disabled={busy || !ok} onClick={save}>Import</Button>
    </>}>
      <div class="stack" style={{ gap: 'var(--sp-3)' }}>
        {error ? <ErrorBox error={error} /> : null}
        <Field label="Config file" hint="From a VPN provider or the other site: the [Interface] for this router and its [Peer]">
          <div class="stack">
            <textarea class="input mono wg-conf" rows={10} spellcheck={false} aria-label="WireGuard config" value={text}
              placeholder={'[Interface]\nPrivateKey = …\nAddress = 10.64.0.2/32\n\n[Peer]\nPublicKey = …\nAllowedIPs = 0.0.0.0/0\nEndpoint = vpn.example.net:51820'}
              onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
            <label class="btn btn-ghost" style={{ alignSelf: 'flex-start' }}>
              <Icon name="upload" size={14} /> Open a .conf file
              <input type="file" accept=".conf,text/plain" hidden onChange={(e) => load((e.target as HTMLInputElement).files?.[0])} />
            </label>
          </div>
        </Field>
        {conf && (conf.errors.length || missing) ? (
          <div class="note warn" role="alert"><Icon name="warning" /> {[missing, ...conf.errors].filter(Boolean).join('. ')}.</div>
        ) : conf ? (
          <div class="preview-box">
            <span class="label">Preview</span>
            <span class="mono">{name} {conf.iface.addresses.join(', ')} → {conf.peers.map((p) => p.endpointHost ? `${p.endpointHost}:${p.endpointPort}` : 'peer dials in').join(', ')}</span>
            <span class="mono small">routes {conf.peers.flatMap((p) => p.allowedIps).join(', ')}</span>
            {fullTunnel && <div class="warn-line"><Icon name="warning" size={13} /> AllowedIPs covers the whole internet: once applied, the router's own default route goes through this tunnel.</div>}
            {conf.iface.dns.length > 0 && <div class="warn-line"><Icon name="info" size={13} /> DNS {conf.iface.dns.join(', ')} is not applied; set it on the DNS page if you want it.</div>}
          </div>
        ) : null}
        <Field label="Interface name" error={nameErr}>
          <input class={`input mono${nameErr ? ' invalid' : ''}`} style={{ width: 120 }} value={name} onInput={(e) => setName((e.target as HTMLInputElement).value.trim())} />
        </Field>
        <Field label="Firewall zone" hint={zone ? undefined : `A new zone ${name}, masqueraded like an uplink`}>
          <Chips value={zone} onChange={setZone} label="Firewall zone" options={[
            ...zones.filter((z) => !z.networks.includes('wan')).map((z) => ({ value: z.name, label: z.name, slot: z.slot })),
            { value: '', label: <>new zone <Badge>{name}</Badge></> },
          ]} />
        </Field>
      </div>
    </Drawer>
  )
}
