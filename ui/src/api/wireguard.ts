// WireGuard: runtime status from the ER-4 plugin (er4.wg_instances, same reply as luci.wireguard), key
// generation (browser first, router fallback), address allocation and client config text.
// Config lives in UCI network: interface <wg> (proto wireguard) + sections 'wireguard_<wg>'.
import { api } from './client'
import { canGenerateLocally, generateKeyPairLocal } from './wgkeys'
import { cidr, ip4, ip4str, list, maskBits } from './ip4'
import type { UciConfig, UciSection } from './types'

/** One runtime peer as the UI uses it (parsed: numbers are numbers). */
export interface WgPeerRuntime {
  name?: string
  public_key: string
  endpoint?: string // "198.51.100.7:51820"; undefined when wg reports "(none)"
  allowed_ips: string[]
  latest_handshake: number // unix seconds, 0 = never
  transfer_rx: number
  transfer_tx: number
  persistent_keepalive?: number // undefined = off
}

export interface WgInstance {
  name: string
  public_key: string
  listen_port?: number
  fwmark?: string
  peers: Map<string, WgPeerRuntime> // by public key
}

// Raw reply of er4.wg_instances (the shape of luci-proto-wireguard's getWgInstances): per interface
// { name, public_key, listen_port, fwmark, peers: [...] }, every value a string from
// `wg show all dump` ("0" = never, "off", "(none)"). Parsed here, not in the pages.
type Raw = string | number | null | undefined
interface RawPeer { name?: Raw; public_key?: Raw; endpoint?: Raw; allowed_ips?: Raw | Raw[]; latest_handshake?: Raw; transfer_rx?: Raw; transfer_tx?: Raw; persistent_keepalive?: Raw }
interface RawInstance { name?: Raw; public_key?: Raw; listen_port?: Raw; fwmark?: Raw; peers?: RawPeer[] | Record<string, RawPeer> }

const num = (v: Raw) => {
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  return isFinite(n) ? n : undefined
}
const text = (v: Raw) => (v === undefined || v === null ? undefined : String(v))

function parseInstance(iface: string, r: RawInstance): WgInstance {
  const peers = new Map<string, WgPeerRuntime>()
  // An array on the real router; tolerate an object keyed by public key as well
  const raw = Array.isArray(r.peers) ? r.peers : Object.entries(r.peers ?? {}).map(([k, p]) => ({ public_key: k, ...p }))
  for (const p of raw) {
    const pub = text(p.public_key)
    if (!pub) continue
    const ep = text(p.endpoint)
    const ips = Array.isArray(p.allowed_ips) ? p.allowed_ips.map((x) => String(x ?? '')) : (text(p.allowed_ips) ?? '').split(/[\s,]+/)
    peers.set(pub, {
      name: text(p.name) || undefined,
      public_key: pub,
      endpoint: ep && ep !== '(none)' ? ep : undefined,
      allowed_ips: ips.filter((x) => x && x !== '(none)'),
      latest_handshake: num(p.latest_handshake) ?? 0,
      transfer_rx: num(p.transfer_rx) ?? 0,
      transfer_tx: num(p.transfer_tx) ?? 0,
      persistent_keepalive: num(p.persistent_keepalive) || undefined,
    })
  }
  const fw = text(r.fwmark)
  return { name: text(r.name) ?? iface, public_key: text(r.public_key) ?? '', listen_port: num(r.listen_port), fwmark: fw && fw !== 'off' ? fw : undefined, peers }
}

export const wg = {
  async instances(): Promise<Record<string, WgInstance>> {
    const r = await api.call<Record<string, RawInstance>>('er4', 'wg_instances')
    return Object.fromEntries(Object.entries(r ?? {}).map(([k, v]) => [k, parseInstance(k, v)]))
  },

  /** A fresh keypair; generated in this browser when possible (the private key then never leaves it). */
  async keyPair(): Promise<{ priv: string; pub: string; where: 'browser' | 'router' }> {
    if (canGenerateLocally()) {
      try {
        return { ...(await generateKeyPairLocal()), where: 'browser' }
      } catch { /* old browser without X25519: fall through */ }
    }
    const r = await api.call<{ keys: { priv: string; pub: string } }>('er4', 'wg_keypair')
    return { ...r.keys, where: 'router' }
  },
}

export const peerType = (iface: string) => `wireguard_${iface}`

export function wgInterfaces(net: UciConfig): UciSection[] {
  return Object.values(net).filter((s) => s['.type'] === 'interface' && s.proto === 'wireguard')
    .sort((a, b) => (a['.index'] ?? 0) - (b['.index'] ?? 0))
}

export function peerSections(net: UciConfig, iface: string): UciSection[] {
  return Object.values(net).filter((s) => s['.type'] === peerType(iface)).sort((a, b) => (a['.index'] ?? 0) - (b['.index'] ?? 0))
}

/** Next unused host address in the interface's subnet, as /32 ("10.200.0.4/32"). */
export function nextFreeAddress(ifaceAddrs: string[], peers: UciSection[]): string | undefined {
  const net = ifaceAddrs.map(cidr).find(Boolean)
  if (!net) return undefined
  const used = new Set<number>([net.addr])
  for (const p of peers) for (const a of list(p.allowed_ips)) {
    const c = cidr(a)
    if (c && c.prefix === 32) used.add(c.addr)
  }
  const size = 2 ** (32 - net.prefix)
  for (let i = 1; i < size - 1; i++) {
    const n = (net.network + i) >>> 0
    if (!used.has(n)) return `${ip4str(n)}/32`
  }
  return undefined
}

/** A /24 in 10.x that doesn't overlap any existing subnet, for the setup wizard. */
export function freeTunnelSubnet(existing: { network: number; prefix: number }[]): string {
  for (let third = 200; third < 256; third++) {
    const cand = ip4(`10.${third}.0.0`)!
    const clash = existing.some((e) => {
      const p = Math.min(e.prefix, 24)
      return ((cand & maskBits(p)) >>> 0) === ((e.network & maskBits(p)) >>> 0)
    })
    if (!clash) return `10.${third}.0.1/24`
  }
  return '10.200.0.1/24'
}

/** Handshake age -> peer state. WireGuard re-handshakes every 2 min while traffic flows. */
export function peerState(rt: WgPeerRuntime | undefined, now: number, enabled: boolean): { label: string; status?: 'good' | 'warning' | 'serious'; age?: number } {
  if (!enabled) return { label: 'disabled' }
  if (!rt) return { label: 'not applied' }
  if (!rt.latest_handshake) return { label: 'never', status: 'serious' }
  const age = Math.max(0, now - rt.latest_handshake)
  return age < 180 ? { label: 'online', status: 'good', age } : { label: 'stale', status: 'warning', age }
}

export function ago(sec: number): string {
  if (sec < 10) return 'just now'
  if (sec < 60) return `${Math.round(sec)} s ago`
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`
  if (sec < 86400) return `${Math.round(sec / 3600)} h ago`
  return `${Math.round(sec / 86400)} d ago`
}

export function clientConfig(o: {
  priv: string; address: string; dns?: string; serverPub: string; psk?: string; endpoint: string; allowedIps: string[]; keepalive?: number
}): string {
  return [
    '[Interface]',
    `PrivateKey = ${o.priv}`,
    `Address = ${o.address}`,
    ...(o.dns ? [`DNS = ${o.dns}`] : []),
    '',
    '[Peer]',
    `PublicKey = ${o.serverPub}`,
    ...(o.psk ? [`PresharedKey = ${o.psk}`] : []),
    `AllowedIPs = ${o.allowedIps.join(', ')}`,
    `Endpoint = ${o.endpoint}`,
    ...(o.keepalive ? [`PersistentKeepalive = ${o.keepalive}`] : []),
    '',
  ].join('\n')
}

/** First wgN not used by any network section. */
export function freeWgName(net: UciConfig): string {
  for (let i = 0; ; i++) if (!net[`wg${i}`]) return `wg${i}`
}

/** A random 32-byte preshared key (base64), made in the browser. */
export function randomPsk(): string {
  const b = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...b))
}

export const KEY_RE = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw480]=$/

export interface WgConf {
  iface: { privateKey?: string; addresses: string[]; listenPort?: string; dns: string[]; mtu?: string }
  peers: { publicKey?: string; presharedKey?: string; allowedIps: string[]; endpointHost?: string; endpointPort?: string; keepalive?: string }[]
  errors: string[]
}

/** Parse a wg-quick style .conf (what VPN providers and the other site hand out). */
export function parseConf(text: string): WgConf {
  const out: WgConf = { iface: { addresses: [], dns: [] }, peers: [], errors: [] }
  let sect: 'iface' | 'peer' | undefined
  const csv = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean)
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    if (/^\[interface\]$/i.test(line)) { sect = 'iface'; continue }
    if (/^\[peer\]$/i.test(line)) { sect = 'peer'; out.peers.push({ allowedIps: [] }); continue }
    const m = /^(\w+)\s*=\s*(.+)$/.exec(line)
    if (!m || !sect) { out.errors.push(`Line ${i + 1}: not understood`); continue }
    const k = m[1].toLowerCase(), v = m[2].trim()
    if (sect === 'iface') {
      if (k === 'privatekey') out.iface.privateKey = v
      else if (k === 'address') out.iface.addresses.push(...csv(v))
      else if (k === 'listenport') out.iface.listenPort = v
      else if (k === 'dns') out.iface.dns.push(...csv(v))
      else if (k === 'mtu') out.iface.mtu = v
      else out.errors.push(`Line ${i + 1}: ${m[1]} is not supported here`)
    } else {
      const p = out.peers[out.peers.length - 1]
      if (k === 'publickey') p.publicKey = v
      else if (k === 'presharedkey') p.presharedKey = v
      else if (k === 'allowedips') p.allowedIps.push(...csv(v))
      else if (k === 'persistentkeepalive') p.keepalive = v
      else if (k === 'endpoint') {
        const e = /^\[?([^\]]+?)\]?:(\d+)$/.exec(v)
        if (e) { p.endpointHost = e[1]; p.endpointPort = e[2] } else out.errors.push(`Line ${i + 1}: endpoint should be host:port`)
      } else out.errors.push(`Line ${i + 1}: ${m[1]} is not supported here`)
    }
  }
  if (out.iface.privateKey && !KEY_RE.test(out.iface.privateKey)) out.errors.push('PrivateKey is not a WireGuard key')
  if (!out.peers.length) out.errors.push('No [Peer] section')
  for (const p of out.peers) {
    if (!p.publicKey || !KEY_RE.test(p.publicKey)) out.errors.push('A peer has no valid PublicKey')
    if (p.presharedKey && !KEY_RE.test(p.presharedKey)) out.errors.push('A PresharedKey is not a WireGuard key')
  }
  return out
}
