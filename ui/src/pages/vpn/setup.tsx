// "Set up WireGuard" (no WireGuard interface yet). Stages, in one go:
//   network:  interface wg0 (proto wireguard, private key, listen port, tunnel address)
//   firewall: zone 'vpn' (or wg0 added to an existing one), forwardings vpn -> chosen zones
//             (+ vpn -> wan for full-tunnel devices), rule "Allow-WireGuard" on wan UDP port
import { useState } from 'preact/hooks'
import { uci } from '../../api/uci'
import { forwardings, zones as zonesOf } from '../../api/firewall'
import { cidr, cidrStr, interfaceSubnets } from '../../api/ip4'
import { freeTunnelSubnet, freeWgName, wg, wgInterfaces } from '../../api/wireguard'
import { Button, Card, ErrorBox, Field, Toggle } from '../../components/ui'
import { Icon } from '../../components/icons'
import { MultiChips } from '../../components/chips'
import type { VpnData } from './shared'

export function Setup({ data, onDone }: { data: VpnData; onDone?: (iface: string) => void }) {
  const zones = zonesOf(data.fw)
  const inside = zones.filter((z) => !z.masq && z.name !== 'vpn')
  const wan = zones.find((z) => z.masq) ?? zones.find((z) => z.name === 'wan')
  const subnets = interfaceSubnets(data.net)
  // a second road-warrior tunnel needs its own port
  const usedPorts = wgInterfaces(data.net).map((s) => String(s.listen_port ?? ''))
  const [port, setPort] = useState(() => { let p = 51820; while (usedPorts.includes(String(p))) p++; return String(p) })
  const [address, setAddress] = useState(() => freeTunnelSubnet(Object.values(subnets)))
  const [reach, setReach] = useState<string[]>(inside.some((z) => z.name === 'lan') ? ['lan'] : inside.slice(0, 1).map((z) => z.name))
  const [internet, setInternet] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()

  const portOk = /^\d{1,5}$/.test(port) && +port > 0 && +port < 65536
  const c = cidr(address)
  const addrOk = !!c && c.prefix <= 30 && c.addr !== c.network
  const clash = c && Object.entries(subnets).find(([, s]) => cidrStr(s) === cidrStr(c))
  const name = freeWgName(data.net)
  const portClash = usedPorts.includes(port)

  const create = async () => {
    setBusy(true)
    try {
      const keys = await wg.keyPair()
      // firewall first: staging the interface switches this page to the device list, so an
      // error after that would have nowhere to show
      const existing = zones.find((z) => z.name === 'vpn')
      if (existing) await uci.set('firewall', existing.section, { network: [...existing.networks, name] })
      else await uci.add('firewall', 'zone', { name: 'vpn', network: [name], input: 'ACCEPT', output: 'ACCEPT', forward: 'REJECT' })
      const have = forwardings(data.fw).filter((f) => f.src === 'vpn').map((f) => f.dest)
      for (const z of [...reach, ...(internet && wan ? [wan.name] : [])]) if (!have.includes(z)) await uci.add('firewall', 'forwarding', { src: 'vpn', dest: z })
      if (wan) await uci.add('firewall', 'rule', { name: name === 'wg0' ? 'Allow-WireGuard' : `Allow-WireGuard-${name}`, src: wan.name, proto: 'udp', dest_port: port, target: 'ACCEPT' })
      await uci.add('network', 'interface', { proto: 'wireguard', private_key: keys.priv, listen_port: port, addresses: [address] }, name)
      onDone?.(name)
    } catch (e) {
      setError(e)
      setBusy(false)
    }
  }

  return (
    <div class="vpn-setup">
      <Card>
        <div class="vpn-setup-head">
          <span class="vpn-setup-icon"><Icon name="vpn" size={22} /></span>
          <div>
            <h2>Reach home from anywhere with WireGuard</h2>
            <p class="secondary">Phones and laptops connect to this router over an encrypted tunnel, then use your home network (and, if you like, your home internet) as if they were here. Defaults below work for most homes.</p>
          </div>
        </div>
        {error ? <ErrorBox error={error} /> : null}
        <div class="vpn-setup-grid">
          <Field label="Port (UDP)" hint="Opened on the internet side" error={!portOk ? '1-65535' : portClash ? 'Another tunnel listens there' : undefined}>
            <input class={`input mono${portOk && !portClash ? '' : ' invalid'}`} value={port} onInput={(e) => setPort((e.target as HTMLInputElement).value.trim())} />
          </Field>
          <Field label="Tunnel network" hint={clash ? `Overlaps ${clash[0]}` : 'Router address / size; devices get the next free addresses'} error={addrOk && !clash ? undefined : clash ? `Same subnet as ${clash[0]}` : 'e.g. 10.200.0.1/24'}>
            <input class={`input mono${addrOk && !clash ? '' : ' invalid'}`} value={address} onInput={(e) => setAddress((e.target as HTMLInputElement).value.trim())} />
          </Field>
          <Field label="VPN devices may reach" hint="Click to choose; change any time on the Firewall zone map">
            <MultiChips value={reach} onChange={setReach} label="Reachable zones" options={inside.map((z) => ({ value: z.name, label: z.name, slot: z.slot }))} />
          </Field>
          <label class="row" style={{ cursor: 'pointer', alignSelf: 'center' }}>
            <Toggle on={internet} label="Allow internet through home" onChange={setInternet} /> Let VPN devices use this internet connection (needed for "full tunnel")
          </label>
        </div>
        <div class="vpn-setup-foot">
          <span class="muted">Stages interface {name}, firewall zone <b>vpn</b>, {reach.length + (internet ? 1 : 0)} forwarding{reach.length + (internet ? 1 : 0) === 1 ? '' : 's'} and a rule allowing UDP {port} from {wan?.name ?? 'wan'}. Nothing is live until you apply.</span>
          <Button variant="primary" icon="check" disabled={busy || !portOk || portClash || !addrOk || !!clash} onClick={create}>{busy ? 'Generating keys…' : 'Set up WireGuard'}</Button>
        </div>
      </Card>
    </div>
  )
}
