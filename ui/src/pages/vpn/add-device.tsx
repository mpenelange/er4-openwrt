// "Add device": name -> full tunnel or home network only -> keys are generated (in this browser
// when it can; the private key then never leaves it) -> the peer is staged -> QR code + config
// file for the WireGuard app. The private key is shown only here and never stored.
import { useMemo, useState } from 'preact/hooks'
import { uci } from '../../api/uci'
import { forwardings, str, zones as zonesOf } from '../../api/firewall'
import { cidr, cidrStr, interfaceSubnets, list } from '../../api/ip4'
import { clientConfig, nextFreeAddress, peerSections, peerType, wg, type WgInstance } from '../../api/wireguard'
import { randomKey } from '../../api/wgkeys'
import type { UciSection } from '../../api/types'
import { Button, Drawer, ErrorBox, Field } from '../../components/ui'
import { Icon, type IconName } from '../../components/icons'
import { CopyButton, downloadText } from '../../components/copy'
import { QrCode } from '../../components/qr'
import { useServerPub, type VpnData } from './shared'

type Mode = 'full' | 'home'
const ENDPOINT_KEY = 'er4.wg.endpoint'

export function AddDevice({ iface, inst, data, onClose }: { iface: UciSection; inst?: WgInstance; data: VpnData; onClose: () => void }) {
  const serverPub = useServerPub(iface, inst)
  const peers = peerSections(data.net, iface['.name'])
  const tunnel = cidr(list(iface.addresses)[0] ?? '')
  const routerIp = list(iface.addresses)[0]?.split('/')[0]

  // Zones: which one holds the tunnel, where it may go, and whether it can reach the internet
  const zones = zonesOf(data.fw)
  const vpnZone = zones.find((z) => z.networks.includes(iface['.name']))
  const fwds = forwardings(data.fw).filter((f) => f.enabled && f.src === vpnZone?.name)
  const wanZone = zones.find((z) => z.masq) ?? zones.find((z) => z.name === 'wan')
  const internetOk = !!wanZone && fwds.some((f) => f.dest === wanZone.name)
  const homeSubnets = useMemo(() => {
    const subnets = interfaceSubnets(data.net)
    const nets = zones.filter((z) => !z.masq && fwds.some((f) => f.dest === z.name)).flatMap((z) => z.networks)
    const out = nets.map((n) => subnets[n]).filter(Boolean).map(cidrStr)
    if (tunnel) out.unshift(cidrStr(tunnel))
    return [...new Set(out)]
  }, [data])

  const [name, setName] = useState('')
  const [mode, setMode] = useState<Mode>('full')
  const [address, setAddress] = useState(() => nextFreeAddress(list(iface.addresses), peers) ?? '')
  const [dns, setDns] = useState(routerIp ?? '')
  const [endpoint, setEndpoint] = useState(() => localStorage.getItem(ENDPOINT_KEY) || data.wanAddr || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  const [done, setDone] = useState<{ conf: string; where: 'browser' | 'router'; addedWan: boolean } | null>(null)

  const port = str(iface.listen_port) || '51820'
  const nameErr = !name.trim() ? undefined : peers.some((p) => str(p.description) === name.trim()) ? 'A device with this name exists' : undefined
  const addrOk = !!cidr(address)
  const ready = name.trim() && !nameErr && addrOk && endpoint && serverPub

  const create = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const keys = await wg.keyPair()
      const psk = randomKey()
      const addr = address.includes('/') ? address : `${address}/32`
      await uci.add('network', peerType(iface['.name']), {
        description: name.trim(), public_key: keys.pub, preshared_key: psk, allowed_ips: [addr],
      })
      let addedWan = false
      if (mode === 'full' && !internetOk && vpnZone && wanZone) {
        await uci.add('firewall', 'forwarding', { src: vpnZone.name, dest: wanZone.name })
        addedWan = true
      }
      localStorage.setItem(ENDPOINT_KEY, endpoint)
      // "host" / "1.2.3.4" / "host:port" / "[v6]:port" / bare IPv6
      const colons = (endpoint.match(/:/g) ?? []).length
      const host = /^\[.*\]:\d+$/.test(endpoint) || (colons === 1 && /:\d+$/.test(endpoint)) ? endpoint
        : colons > 1 ? `[${endpoint.replace(/^\[|\]$/g, '')}]:${port}` : `${endpoint}:${port}`
      const conf = clientConfig({
        priv: keys.priv, address: addr, dns: dns || undefined, serverPub: serverPub!, psk,
        endpoint: host, allowedIps: mode === 'full' ? ['0.0.0.0/0', '::/0'] : homeSubnets, keepalive: 25,
      })
      setDone({ conf, where: keys.where, addedWan })
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    const file = `${name.trim().replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 15) || 'wireguard'}.conf`
    return (
      <Drawer title={`${name.trim()} is ready`} onClose={onClose} footer={<>
        <Button icon="download" onClick={() => downloadText(file, done.conf)}>Download {file}</Button>
        <span style={{ flex: 1 }} />
        <Button variant="primary" icon="check" onClick={onClose}>Done</Button>
      </>}>
        <div class="stack" style={{ gap: 'var(--sp-3)' }}>
          <ol class="vpn-steps">
            <li>Open the <b>WireGuard</b> app on the device, tap <b>+</b> and choose <b>Scan from QR code</b> (or import the file on a computer).</li>
            <li><b>Apply</b> the pending changes from the top bar so the router accepts the new device.</li>
          </ol>
          <div class="vpn-qr"><QrCode text={done.conf} size={264} label={`WireGuard config for ${name}`} /></div>
          <div class="vpn-secret">
            <Icon name="warning" size={14} />
            <span>This is the only time the device's private key is shown{done.where === 'browser' ? '; it was generated in this browser and never sent to the router' : ' (generated by the router, which does not keep it)'}. Close this and the QR code is gone; to re-provision, remove the device and add it again.</span>
          </div>
          <Field label="Config file">
            <div class="vpn-conf">
              <pre>{done.conf}</pre>
              <span class="copy"><CopyButton text={done.conf} label="Copy" /></span>
            </div>
          </Field>
          {done.addedWan && <p class="secondary" style={{ margin: 0, fontSize: 'var(--fs-sm)' }}><Icon name="info" size={13} style={{ verticalAlign: '-2px' }} /> Also staged: forwarding {vpnZone?.name} → {wanZone?.name}, so full-tunnel devices can reach the internet.</p>}
        </div>
      </Drawer>
    )
  }

  return (
    <Drawer title="Add device" onClose={onClose} footer={<>
      <span class="muted" style={{ fontSize: 'var(--fs-sm)', marginRight: 'auto' }}>{address && `Gets ${address}`}</span>
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" icon="check" disabled={busy || !ready} onClick={create}>{busy ? 'Generating keys…' : 'Create & show QR code'}</Button>
    </>}>
      <div class="stack" style={{ gap: 'var(--sp-4)' }}>
        {error ? <ErrorBox error={error} /> : null}
        <Field label="1. Name the device" error={nameErr}>
          <input class={`input${nameErr ? ' invalid' : ''}`} value={name} autoFocus placeholder="e.g. Anna's phone" maxLength={40} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="2. What should go through the VPN?">
          <div class="vpn-modes" role="radiogroup">
            <ModeCard on={mode === 'full'} onClick={() => setMode('full')} icon="globe" title="Everything (full tunnel)"
              text="All the device's traffic goes through home. Best on public Wi-Fi; uses your home upload speed." />
            <ModeCard on={mode === 'home'} onClick={() => setMode('home')} icon="home" title="Home network only"
              text={`Only reach devices at home (${homeSubnets.join(', ') || 'none'}); everything else uses the device's own connection.`} />
          </div>
          {mode === 'full' && !internetOk && (
            <span class="hint"><Icon name="info" size={12} style={{ verticalAlign: '-2px' }} /> VPN devices can't reach the internet yet; a {vpnZone?.name ?? 'vpn'} → {wanZone?.name ?? 'wan'} forwarding will be staged too.</span>
          )}
        </Field>
        <details class="disclosure">
          <summary><Icon name="chevronRight" size={14} /> Details (filled in for you)</summary>
          <div class="stack" style={{ gap: 'var(--sp-3)' }}>
            <Field label="Address in the tunnel" hint="Next free address" error={address && !addrOk ? 'e.g. 10.200.0.5/32' : undefined}>
              <input class="input mono" value={address} onInput={(e) => setAddress((e.target as HTMLInputElement).value.trim())} />
            </Field>
            <Field label="Router address to dial" hint={`Public IP or DNS name of this router; port ${port} is added. Defaults to the current WAN address.`}>
              <input class="input mono" value={endpoint} placeholder="home.example.net" onInput={(e) => setEndpoint((e.target as HTMLInputElement).value.trim())} />
            </Field>
            <Field label="DNS server for the device" hint="The router, so home names resolve">
              <input class="input mono" value={dns} onInput={(e) => setDns((e.target as HTMLInputElement).value.trim())} />
            </Field>
          </div>
        </details>
        {!serverPub && <div class="vpn-warn"><Icon name="warning" size={14} /> The router's public key is not known yet: apply the WireGuard setup first, then add devices.</div>}
        {!endpoint && <div class="vpn-warn"><Icon name="warning" size={14} /> No WAN address found: enter the router's public address under Details.</div>}
      </div>
    </Drawer>
  )
}

function ModeCard({ on, onClick, icon, title, text }: { on: boolean; onClick: () => void; icon: IconName; title: string; text: string }) {
  return (
    <button type="button" role="radio" aria-checked={on} class={`vpn-mode${on ? ' on' : ''}`} onClick={onClick}>
      <span class="head"><Icon name={icon} size={16} /> {title}</span>
      <span class="text">{text}</span>
    </button>
  )
}
