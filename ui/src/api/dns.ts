// DNS = dnsmasq, configured in UCI 'dhcp' (the same file as the DHCP pools):
//   config domain   name 'printer'  ip '192.168.1.50'      hostname → address (A / AAAA)
//   config cname    cname 'files'   target 'nas'            alias → another local name
//   dnsmasq.server  '/corp.example/10.8.0.1'                forward a domain to a server
//                   '1.1.1.1'                               upstream resolver
//   dnsmasq.noresolv '1'                                    ignore the ISP's servers (WAN DHCP)
//   dnsmasq.domain 'lan' + local '/lan/'                    the local domain
//   dnsmasq.address '/home.example/192.168.1.20'            a domain and all its subdomains → address
//                   '/ads.example/'                         blocked: answered locally only (NXDOMAIN)
//   dnsmasq.rebind_protection, rebind_domain, logqueries   (protection and logging, see DnsModel)
// Names without a dot also answer as <name>.<domain> (expandhosts), so they're shown that way.
// Lookup order: local names (these, DHCP leases, reservations) → domain forwards → upstream.
import { uci } from './uci'
import { ip4, list } from './ip4'
import type { UciConfig, UciSection } from './types'

export type RecordKind = 'host' | 'cname' | 'forward' | 'address' | 'dhcp'

export interface DnsRecord {
  kind: RecordKind
  /** UCI section ('host'/'cname'), server or address entry ('forward'/'address'), or 'dhcp:<ip>' */
  id: string
  /** as configured */
  name: string
  /** fully qualified as answered: 'printer' → 'printer.lan' */
  fqdn: string
  value: string
  from: 'manual' | 'reservation' | 'lease'
}

export interface DnsModel {
  /** the dnsmasq section (anonymous on stock OpenWrt) */
  section: string
  domain: string
  /** names under the domain that aren't local get "no such name" (dnsmasq local=/<domain>/,
   *  OpenWrt's default); false: they're asked upstream (a domain that also has public records) */
  localOnly: boolean
  upstream: string[]
  useIsp: boolean
  records: DnsRecord[]
  /** server entries we don't model (e.g. '/local.only/'), kept as they are */
  otherServers: string[]
  /** address entries we don't model (several domains in one entry), kept as they are */
  otherAddresses: string[]
  /** drop upstream answers that point into private ranges (DNS rebinding); OpenWrt's default is on */
  rebind: boolean
  /** domains allowed to answer with private addresses anyway */
  rebindAllow: string[]
  logQueries: boolean
}

export interface DhcpName { name?: string; ip: string; reserved: boolean }

const SERVER_RE = /^\/([^/]+)\/(.+)$/

export function dnsModel(dhcp: UciConfig, dhcpNames: DhcpName[]): DnsModel {
  const secs = Object.values(dhcp)
  const dm = secs.find((s) => s['.type'] === 'dnsmasq') as UciSection | undefined
  const domain = String(dm?.domain ?? 'lan')
  const fq = (n: string) => (n.includes('.') ? n : `${n}.${domain}`)
  const records: DnsRecord[] = []
  for (const s of secs) {
    if (s['.type'] === 'domain' && s.name && s.ip) records.push({ kind: 'host', id: s['.name'], name: String(s.name), fqdn: fq(String(s.name)), value: String(s.ip), from: 'manual' })
    if (s['.type'] === 'cname' && s.cname && s.target) records.push({ kind: 'cname', id: s['.name'], name: String(s.cname), fqdn: fq(String(s.cname)), value: String(s.target), from: 'manual' })
  }
  const upstream: string[] = []
  const otherServers: string[] = []
  for (const e of list(dm?.server)) {
    const m = SERVER_RE.exec(e)
    if (!m) upstream.push(e)
    else if (m[2] && m[2] !== '#') records.push({ kind: 'forward', id: e, name: m[1], fqdn: m[1], value: m[2], from: 'manual' })
    else otherServers.push(e)
  }
  const otherAddresses: string[] = []
  for (const e of list(dm?.address)) {
    const m = /^\/([^/]+)\/([^/]*)$/.exec(e)
    if (m) records.push({ kind: 'address', id: e, name: m[1], fqdn: m[1], value: m[2], from: 'manual' })
    else otherAddresses.push(e)
  }
  for (const d of dhcpNames) {
    if (d.name) records.push({ kind: 'dhcp', id: `dhcp:${d.ip}`, name: d.name, fqdn: fq(d.name), value: d.ip, from: d.reserved ? 'reservation' : 'lease' })
  }
  return {
    section: dm?.['.name'] ?? '', domain, localOnly: list(dm?.local).includes(`/${domain}/`), upstream, useIsp: String(dm?.noresolv ?? '0') !== '1', records, otherServers, otherAddresses,
    rebind: String(dm?.rebind_protection ?? '1') !== '0', rebindAllow: list(dm?.rebind_domain), logQueries: String(dm?.logqueries ?? '0') === '1',
  }
}

/** Follow a CNAME to an address through local names: ['nas.lan', '192.168.1.20'], or undefined. */
export function resolveChain(m: DnsModel, name: string): string[] | undefined {
  const chain: string[] = []
  let cur = name
  for (let i = 0; i < 8; i++) {
    const r = m.records.find((x) => x.kind !== 'forward' && x.kind !== 'address' && (x.fqdn === cur || x.name === cur || x.fqdn === `${cur}.${m.domain}`))
    if (!r) return undefined
    chain.push(r.fqdn)
    if (r.kind !== 'cname') return [...chain, r.value]
    cur = r.value
  }
  return undefined
}

// ---- validation -------------------------------------------------------------------------
const LABEL = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
const NAME_RE = new RegExp(`^${LABEL}(\\.${LABEL})*$`, 'i')
const IP6_RE = /^[0-9a-f:]+(%\w+)?$/i

export const isIp6 = (v: string) => v.includes(':') && IP6_RE.test(v) && v.split('::').length <= 2
export const isIp = (v: string) => ip4(v) !== undefined || isIp6(v)

export function nameError(v: string): string | undefined {
  if (!v) return 'Required'
  if (v.length > 253 || !NAME_RE.test(v)) return 'Letters, digits and hyphens, dot-separated (e.g. nas or files.home)'
  return undefined
}

/** A server: IPv4/IPv6, optional #port. */
export function serverError(v: string): string | undefined {
  if (!v) return 'Required'
  const [host, port] = v.split('#')
  if (!isIp(host)) return 'An IPv4 or IPv6 address, optionally #port (e.g. 10.8.0.1#5353)'
  if (port !== undefined && !(/^\d+$/.test(port) && +port >= 1 && +port <= 65535)) return 'Port 1-65535'
  return undefined
}

/** The servers dnsmasq forwards to: the ISP's (what the WAN got by DHCP/PPP, unless noresolv)
 *  and your own. With both, dnsmasq uses all of them, not yours first. */
export function resolvers(m: Pick<DnsModel, 'useIsp' | 'upstream'>, ispDns: string[]): { s: string; isp: boolean }[] {
  return [...(m.useIsp ? ispDns.map((s) => ({ s, isp: true })) : []), ...m.upstream.map((s) => ({ s, isp: false }))]
}

/** Names already answered locally (manual, DHCP) other than `self`. */
export function nameClash(m: DnsModel, name: string, selfId?: string): DnsRecord | undefined {
  const fq = name.includes('.') ? name : `${name}.${m.domain}`
  return m.records.find((r) => r.id !== selfId && r.kind !== 'forward' && r.kind !== 'address' && r.fqdn.toLowerCase() === fq.toLowerCase())
}

// ---- changes (all staged) ---------------------------------------------------------------
export const dns = {
  addHost: (name: string, ip: string) => uci.add('dhcp', 'domain', { name, ip }),
  addCname: (cname: string, target: string) => uci.add('dhcp', 'cname', { cname, target }),
  update: (id: string, values: Record<string, string>) => uci.set('dhcp', id, values),
  remove: (id: string) => uci.remove('dhcp', id),
  /** Rewrite the server list from forwards + upstream, keeping entries we don't model. */
  setServers: (m: DnsModel, forwards: { domain: string; server: string }[], upstream: string[]) =>
    uci.set('dhcp', m.section, { server: [...m.otherServers, ...forwards.map((f) => `/${f.domain}/${f.server}`), ...upstream] }),
  forwardsOf: (m: DnsModel) => m.records.filter((r) => r.kind === 'forward').map((r) => ({ domain: r.name, server: r.value })),
  setUseIsp: (m: DnsModel, on: boolean) => (on ? uci.remove('dhcp', m.section, ['noresolv']) : uci.set('dhcp', m.section, { noresolv: '1' })),
  setDomain: async (m: DnsModel, d: string, localOnly: boolean) => {
    await uci.set('dhcp', m.section, { domain: d })
    return localOnly ? uci.set('dhcp', m.section, { local: `/${d}/` }) : uci.remove('dhcp', m.section, ['local'])
  },
  addressesOf: (m: DnsModel) => m.records.filter((r) => r.kind === 'address').map((r) => ({ domain: r.name, ip: r.value })),
  /** Rewrite the address list (wildcards and blocks), keeping entries we don't model. rpcd rejects an empty list: delete it. */
  setAddresses: (m: DnsModel, a: { domain: string; ip: string }[]) => {
    const v = [...m.otherAddresses, ...a.map((x) => `/${x.domain}/${x.ip}`)]
    return v.length ? uci.set('dhcp', m.section, { address: v }) : uci.remove('dhcp', m.section, ['address'])
  },
  setRebind: (m: DnsModel, on: boolean) => (on ? uci.remove('dhcp', m.section, ['rebind_protection']) : uci.set('dhcp', m.section, { rebind_protection: '0' })),
  setRebindAllow: (m: DnsModel, l: string[]) => (l.length ? uci.set('dhcp', m.section, { rebind_domain: l }) : uci.remove('dhcp', m.section, ['rebind_domain'])),
  setLogQueries: (m: DnsModel, on: boolean) => (on ? uci.set('dhcp', m.section, { logqueries: '1' }) : uci.remove('dhcp', m.section, ['logqueries'])),
}
