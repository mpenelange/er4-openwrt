// IPsec / IKEv2 with strongSwan. Config: UCI 'ipsec', which /etc/init.d/swanctl renders into
// swanctl.conf (OpenWrt's model: remote = a peer, tunnel = a child SA, crypto_proposal, pools,
// mschapv2_secrets = road-warrior users). Traffic runs over the netifd 'xfrm' interface
// 'ipsec' (if_id 42), so it has its own firewall zone and routes, and never looks like WAN.
//   er4.ipsec_status -> IpsecStatus      er4.ipsec_cert {name} -> {} | {error}
import { api } from './client'
import { uci } from './uci'
import { forwardings, zones as zonesOf } from './firewall'
import { list } from './ip4'
import type { UciConfig, UciSection } from './types'

export const IF_ID = '42'
export const RW = 'rw'            // the road-warrior remote
const RW_NET = 'rw_net', RW_POOL = 'rw_pool'
export const PROPOSALS = { ike: ['ike_modern', 'ike_compat'], esp: ['esp_modern', 'esp_compat'] }

export interface IpsecChild { name: string; state: string; local_ts: string[]; remote_ts: string[]; bytes_in: number; bytes_out: number; encr?: string }
export interface IpsecSa { name: string; state: string; remote_host: string; remote_id?: string; eap_id?: string; vips: string[]; established: number; encr?: string; dh?: string; children: IpsecChild[] }
export interface IpsecStatus {
  installed: boolean; running?: boolean; sas?: IpsecSa[]
  ca?: string | null; server?: { subject: string; san: string[]; not_after: string } | null
}

async function checked<T>(p: Promise<T | { error: string }>): Promise<T> {
  const r = await p
  if (r && typeof r === 'object' && 'error' in r) throw new Error(r.error)
  return r as T
}

export const ipsec = {
  status: () => api.call<IpsecStatus>('er4', 'ipsec_status'),
  /** strongSwan is off until the first remote exists (90-er4-ipsec); started now, so it reloads on apply */
  start: async () => { await api.call('rc', 'init', { name: 'swanctl', action: 'enable' }); await api.call('rc', 'init', { name: 'swanctl', action: 'start' }) },
  cert: (name: string) => checked(api.call<object | { error: string }>('er4', 'ipsec_cert', { name })),
}

export const ipsecNetwork = (net: UciConfig) => Object.values(net).find((s) => s['.type'] === 'interface' && s.proto === 'xfrm')
const ofType = (cfg: UciConfig, t: string) => Object.values(cfg).filter((s) => s['.type'] === t).sort((a, b) => (a['.index'] ?? 0) - (b['.index'] ?? 0))
export const remotes = (cfg: UciConfig) => ofType(cfg, 'remote')
export const siteRemotes = (cfg: UciConfig) => remotes(cfg).filter((r) => r['.name'] !== RW)
export const users = (cfg: UciConfig) => ofType(cfg, 'mschapv2_secrets')

/** Stage the plumbing once: xfrm network, zone + forwardings, WAN rules (IKE, NAT-T, ESP), proposals. */
export async function setupIpsec(net: UciConfig, fw: UciConfig, cfg: UciConfig, reach: string[]) {
  if (!ipsecNetwork(net)) await uci.add('network', 'interface', { proto: 'xfrm', ifid: IF_ID, tunlink: 'wan', mtu: '1400' }, 'ipsec')
  const zones = zonesOf(fw)
  const z = zones.find((x) => x.name === 'ipsec')
  if (!z) await uci.add('firewall', 'zone', { name: 'ipsec', network: ['ipsec'], input: 'ACCEPT', output: 'ACCEPT', forward: 'REJECT', mtu_fix: '1' })
  const have = forwardings(fw).filter((f) => f.src === 'ipsec').map((f) => f.dest)
  for (const d of reach) if (!have.includes(d)) await uci.add('firewall', 'forwarding', { src: 'ipsec', dest: d })
  const wan = zones.find((x) => x.name === 'wan') ?? zones.find((x) => x.masq)
  const has = (n: string) => Object.values(fw).some((s) => s['.type'] === 'rule' && s.name === n)
  if (wan && !has('Allow-IPsec-IKE')) await uci.add('firewall', 'rule', { name: 'Allow-IPsec-IKE', src: wan.name, proto: 'udp', dest_port: '500 4500', target: 'ACCEPT' })
  if (wan && !has('Allow-IPsec-ESP')) await uci.add('firewall', 'rule', { name: 'Allow-IPsec-ESP', src: wan.name, proto: 'esp', target: 'ACCEPT' })
  // modern first; compat for clients that can't do GCM/ECP (older Windows, some routers)
  const prop: Record<string, Record<string, string>> = {
    ike_modern: { encryption_algorithm: 'aes256gcm16', prf_algorithm: 'prfsha256', dh_group: 'ecp256' },
    ike_compat: { encryption_algorithm: 'aes256', hash_algorithm: 'sha256', dh_group: 'modp2048' },
    esp_modern: { encryption_algorithm: 'aes256gcm16', dh_group: 'ecp256' },
    esp_compat: { encryption_algorithm: 'aes256', hash_algorithm: 'sha256' },
  }
  for (const [n, v] of Object.entries(prop)) if (!cfg[n]) await uci.add('ipsec', 'crypto_proposal', v, n)
}

export interface RwSettings { host: string; pool: string; dns: string[]; full: boolean; lanSubnets: string[] }

/** The road-warrior server: EAP-MSCHAPv2 users, the router's certificate, an address pool. */
export async function saveRoadWarrior(cfg: UciConfig, net: UciConfig, s: RwSettings) {
  const remote = { enabled: '1', gateway: 'any', authentication_method: 'eap-mschapv2', local_identifier: s.host, local_cert: 'er4-server.pem',
    pools: [RW_POOL], tunnel: [RW_NET], crypto_proposal: PROPOSALS.ike, fragmentation: 'yes', mobike: '1', keyingtries: '%forever' }
  const child = { local_subnet: s.full ? ['0.0.0.0/0'] : s.lanSubnets, if_id: IF_ID, startaction: 'none', crypto_proposal: PROPOSALS.esp }
  const pool = { addrs: s.pool, ...(s.dns.length ? { dns: s.dns } : {}) }
  for (const [name, type, v] of [[RW, 'remote', remote], [RW_NET, 'tunnel', child], [RW_POOL, 'pools', pool]] as const) {
    if (cfg[name]) await uci.set('ipsec', name, v)
    else await uci.add('ipsec', type, v, name)
  }
  await ipsec.start()
  // replies to the pool go back over the xfrm interface
  const route = Object.values(net).find((r) => r['.type'] === 'route' && r.interface === 'ipsec' && r.er4_ipsec === RW_POOL)
  if (route) await uci.set('network', route['.name'], { target: s.pool })
  else await uci.add('network', 'route', { interface: 'ipsec', target: s.pool, er4_ipsec: RW_POOL })
}

export async function removeRoadWarrior(cfg: UciConfig, net: UciConfig) {
  for (const n of [RW, RW_NET, RW_POOL]) if (cfg[n]) await uci.remove('ipsec', n)
  for (const u of users(cfg)) await uci.remove('ipsec', u['.name'])
  for (const r of Object.values(net)) if (r['.type'] === 'route' && r.er4_ipsec === RW_POOL) await uci.remove('network', r['.name'])
}

export interface SiteSettings { name: string; gateway: string; psk: string; local: string[]; remote: string[]; remoteId?: string; localId?: string }

/** A site-to-site tunnel: PSK, both sides' subnets, started by the router and kept up. */
export async function saveSite(cfg: UciConfig, net: UciConfig, s: SiteSettings, existing?: UciSection) {
  const child = `${s.name}_net`
  const remote = { enabled: '1', gateway: s.gateway, authentication_method: 'psk', pre_shared_key: s.psk, tunnel: [child],
    crypto_proposal: PROPOSALS.ike, keyingtries: '%forever', ...(s.localId ? { local_identifier: s.localId } : {}), ...(s.remoteId ? { remote_identifier: s.remoteId } : {}) }
  const tun = { local_subnet: s.local, remote_subnet: s.remote, if_id: IF_ID, startaction: 'start', dpdaction: 'restart', closeaction: 'start', crypto_proposal: PROPOSALS.esp }
  if (existing) await uci.set('ipsec', existing['.name'], remote)
  else await uci.add('ipsec', 'remote', remote, s.name)
  await ipsec.start()
  if (cfg[child]) await uci.set('ipsec', child, tun)
  else await uci.add('ipsec', 'tunnel', tun, child)
  // routes to the other side over the xfrm interface (one per remote subnet)
  const mine = Object.values(net).filter((r) => r['.type'] === 'route' && r.er4_ipsec === s.name)
  for (const r of mine) if (!s.remote.includes(String(r.target))) await uci.remove('network', r['.name'])
  for (const t of s.remote) if (!mine.some((r) => r.target === t)) await uci.add('network', 'route', { interface: 'ipsec', target: t, er4_ipsec: s.name })
}

export async function removeSite(cfg: UciConfig, net: UciConfig, r: UciSection) {
  for (const t of list(r.tunnel)) if (cfg[t]) await uci.remove('ipsec', t)
  await uci.remove('ipsec', r['.name'])
  for (const x of Object.values(net)) if (x['.type'] === 'route' && x.er4_ipsec === r['.name']) await uci.remove('network', x['.name'])
}

/** A random 24-character password/PSK (no look-alike characters). */
export function randomSecret(n = 24) {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const b = crypto.getRandomValues(new Uint8Array(n))
  return [...b].map((x) => A[x % A.length]).join('')
}

const pemBody = (pem: string) => pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** An Apple configuration profile (iOS, iPadOS, macOS): the CA and an IKEv2 VPN with EAP. */
export function mobileconfig(o: { host: string; user: string; password?: string; ca: string; label: string }): string {
  const uuid = () => crypto.randomUUID().toUpperCase()
  const caId = uuid()
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>PayloadContent</key><array>
<dict>
<key>PayloadType</key><string>com.apple.security.root</string><key>PayloadVersion</key><integer>1</integer>
<key>PayloadIdentifier</key><string>er4.vpn.ca</string><key>PayloadUUID</key><string>${caId}</string>
<key>PayloadDisplayName</key><string>ER-4 VPN CA</string>
<key>PayloadContent</key><data>${pemBody(o.ca)}</data>
</dict>
<dict>
<key>PayloadType</key><string>com.apple.vpn.managed</string><key>PayloadVersion</key><integer>1</integer>
<key>PayloadIdentifier</key><string>er4.vpn.ikev2</string><key>PayloadUUID</key><string>${uuid()}</string>
<key>PayloadDisplayName</key><string>${esc(o.label)}</string><key>UserDefinedName</key><string>${esc(o.label)}</string>
<key>VPNType</key><string>IKEv2</string>
<key>IKEv2</key><dict>
<key>RemoteAddress</key><string>${esc(o.host)}</string><key>RemoteIdentifier</key><string>${esc(o.host)}</string>
<key>LocalIdentifier</key><string>${esc(o.user)}</string>
<key>AuthenticationMethod</key><string>None</string><key>ExtendedAuthEnabled</key><integer>1</integer>
<key>AuthName</key><string>${esc(o.user)}</string>${o.password ? `<key>AuthPassword</key><string>${esc(o.password)}</string>` : ''}
<key>ServerCertificateIssuerCommonName</key><string>ER-4 VPN CA</string><key>ServerCertificateCommonName</key><string>${esc(o.host)}</string>
<key>EnablePFS</key><integer>1</integer>
<key>IKESecurityAssociationParameters</key><dict><key>EncryptionAlgorithm</key><string>AES-256-GCM</string><key>IntegrityAlgorithm</key><string>SHA2-256</string><key>DiffieHellmanGroup</key><integer>19</integer></dict>
<key>ChildSecurityAssociationParameters</key><dict><key>EncryptionAlgorithm</key><string>AES-256-GCM</string><key>IntegrityAlgorithm</key><string>SHA2-256</string><key>DiffieHellmanGroup</key><integer>19</integer></dict>
</dict>
</dict>
</array>
<key>PayloadType</key><string>Configuration</string><key>PayloadVersion</key><integer>1</integer>
<key>PayloadIdentifier</key><string>er4.vpn</string><key>PayloadUUID</key><string>${uuid()}</string>
<key>PayloadDisplayName</key><string>${esc(o.label)}</string>
</dict></plist>
`
}
