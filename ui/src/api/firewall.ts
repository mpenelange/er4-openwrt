// UCI firewall (fw4) model for the UI: typed views of zones/forwardings/rules/redirects, the
// readable-sentence renderer for rules and port forwards, and the hardware-offload slow-path
// check. All reads go through uci.get('firewall'); writes are staged with uci.set/add/remove/order.
import type { UciConfig, UciSection, UciValue } from './types'
import { uci, orderWithin } from './uci'
import { list } from './ip4'
import { api } from './client'

export type Policy = 'ACCEPT' | 'REJECT' | 'DROP'
export const POLICIES: Policy[] = ['ACCEPT', 'REJECT', 'DROP']

export const byIndex = (a: UciSection, b: UciSection) => (a['.index'] ?? 0) - (b['.index'] ?? 0)
export const ofType = (cfg: UciConfig, type: string) => Object.values(cfg).filter((s) => s['.type'] === type).sort(byIndex)
export const str = (v: UciSection[string]) => (typeof v === 'string' ? v : Array.isArray(v) ? v.join(' ') : '')
export const isEnabled = (s: UciSection) => s.enabled !== '0' && s.enabled !== 'false' && s.enabled !== 'off'

export interface Zone {
  section: string
  name: string
  networks: string[]
  input: Policy
  output: Policy
  forward: Policy
  masq: boolean
  mtuFix: boolean
  /** 1-8, categorical colour slot: fixed by the zone's position in the config, never by value */
  slot: number
}

export function zones(cfg: UciConfig): Zone[] {
  return ofType(cfg, 'zone').map((s, i) => ({
    section: s['.name'],
    name: str(s.name) || s['.name'],
    networks: list(s.network),
    input: (str(s.input) || 'REJECT') as Policy,
    output: (str(s.output) || 'ACCEPT') as Policy,
    forward: (str(s.forward) || 'REJECT') as Policy,
    masq: s.masq === '1',
    mtuFix: s.mtu_fix === '1',
    slot: (i % 8) + 1,
  }))
}

export interface Forwarding { section: string; src: string; dest: string; enabled: boolean }
export const forwardings = (cfg: UciConfig): Forwarding[] =>
  ofType(cfg, 'forwarding').map((s) => ({ section: s['.name'], src: str(s.src), dest: str(s.dest), enabled: isEnabled(s) }))

/** Zone is the internet side: masqueraded or carries the wan network. */
export const isExternal = (z: Zone) => z.masq || z.networks.some((n) => /^wan/.test(n))

// ---- staged writes ------------------------------------------------------------------------
/** Set non-empty values, delete empty ones (uci.set can't delete). */
export async function setOptions(config: string, section: string, values: Record<string, UciValue | undefined>, current?: UciSection) {
  const set: Record<string, UciValue> = {}
  const del: string[] = []
  for (const [k, v] of Object.entries(values)) {
    const empty = v === undefined || v === '' || (Array.isArray(v) && !v.length)
    if (empty) { if (!current || current[k] !== undefined) del.push(k) }
    else if (!current || JSON.stringify(current[k]) !== JSON.stringify(v)) set[k] = v as UciValue
  }
  if (Object.keys(set).length) await uci.set(config, section, set)
  if (del.length) await uci.remove(config, section, del)
}

export async function setEnabled(config: string, s: UciSection, on: boolean) {
  if (on) await uci.remove(config, s['.name'], ['enabled'])
  else await uci.set(config, s['.name'], { enabled: '0' })
}

/** Reorder sections of one type (rules): stage uci.order with the full config order. */
export async function reorder(config: string, all: UciConfig, sectionsInNewOrder: string[]) {
  await uci.order(config, orderWithin(all, sectionsInNewOrder))
}

/** Sections touched by staged changes, per config: drives the "unapplied" marks. */
export async function stagedSections(): Promise<Record<string, Set<string>>> {
  const ch = await uci.changes()
  return Object.fromEntries(Object.entries(ch).map(([cfg, l]) => [cfg, new Set(l.map((c) => c[1]))]))
}

// ---- hardware offload ---------------------------------------------------------------------
// The ER-4 flow offload forwards established flows in hardware, past the nftables rules. Rules
// that must see every packet (rate limits, logging, raw matches like quota/string, helpers,
// packet marks) can't be honoured there, so fw4 keeps their traffic on the CPU.
const SLOW: Record<string, string> = {
  limit: 'rate limit',
  limit_burst: 'rate limit',
  log: 'logging',
  log_limit: 'logging',
  extra: 'raw match (quota, string ...)',
  helper: 'conntrack helper',
  set_helper: 'conntrack helper',
  set_mark: 'packet mark',
  set_xmark: 'packet mark',
  set_dscp: 'DSCP rewrite',
}

export function slowPathReasons(s: UciSection): string[] {
  const r = new Set<string>()
  for (const [k, why] of Object.entries(SLOW)) {
    const v = s[k]
    if (v === undefined || v === '' || (k === 'log' && v === '0')) continue
    r.add(why)
  }
  if (['MARK', 'DSCP', 'HELPER'].includes(str(s.target))) r.add('packet rewrite target')
  return [...r]
}

// ---- readable sentences -------------------------------------------------------------------
export type Part =
  | { k: 'verb'; target: string }
  | { k: 'text'; v: string; title?: string }
  | { k: 'zone'; v: string }
  | { k: 'router' }
  | { k: 'any' }
  | { k: 'addr'; v: string }

export const VERB: Record<string, string> = {
  ACCEPT: 'Allow', REJECT: 'Reject', DROP: 'Drop', NOTRACK: "Don't track", MARK: 'Mark', HELPER: 'Assign helper', DSCP: 'Set DSCP on',
  // NAT rules (UCI 'nat' sections); keyed apart from ACCEPT, which means "no NAT" there
  'nat:MASQUERADE': 'Masquerade', 'nat:SNAT': 'Rewrite source of', 'nat:ACCEPT': "Don't NAT",
}

const ICMP_NAMES: Record<string, string> = {
  'echo-request': 'ping', 'echo-reply': 'ping replies', 'destination-unreachable': 'unreachable', 'time-exceeded': 'time-exceeded',
  'packet-too-big': 'packet-too-big', 'neighbour-solicitation': 'neighbour solicitation', 'neighbour-advertisement': 'neighbour advertisement',
  'router-solicitation': 'router solicitation', 'router-advertisement': 'router advertisement',
}

export function protoLabel(proto: string[]) {
  const p = proto.length ? proto : ['tcp', 'udp']
  if (p.some((x) => x === 'all' || x === 'any' || x === '*')) return 'all traffic'
  return p.map((x) => (x === 'icmpv6' || x === 'ipv6-icmp' ? 'ICMPv6' : x.toUpperCase())).join('/')
}

export function portsLabel(ports: string[]) {
  return ports.map((p) => p.replace(/[-:]/, '–')).join(', ')
}

/** What the rule matches: "TCP/UDP 53, 67", "ping", "all traffic", "UDP" */
export function matchLabel(s: UciSection) {
  const proto = list(s.proto)
  const ports = list(s.dest_port)
  const icmp = list(s.icmp_type)
  const isIcmp = proto.length > 0 && proto.every((p) => /icmp/.test(p))
  if (isIcmp) return icmp.length ? icmp.map((t) => ICMP_NAMES[t] ?? t).join(', ') : `all ${protoLabel(proto)}`
  const pl = protoLabel(proto)
  if (pl === 'all traffic') return pl
  return ports.length ? `${pl} ${portsLabel(ports)}` : `all ${pl}`
}

// ---- schedules (fw4 weekdays / start_time / stop_time / start_date / stop_date) ----------------
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const
/** fw4 accepts any prefix of the English day name; normalise to Mon..Sun */
export const weekdays = (v: UciSection[string]) =>
  list(v).map((d) => WEEKDAYS.find((w) => w.toLowerCase() === d.slice(0, 3).toLowerCase())).filter((d): d is (typeof WEEKDAYS)[number] => !!d)
const hm = (t: string) => t.replace(/^(\d):/, '0$1:').replace(/^(\d\d:\d\d):00$/, '$1')

/** "on weekdays from 22:00 to 07:00", "until 2026-12-31": empty when the rule always applies */
export function scheduleLabel(s: UciSection): string {
  const days = weekdays(s.weekdays)
  const out: string[] = []
  if (days.length && days.length < 7) {
    const key = days.join(' ')
    out.push(key === 'Mon Tue Wed Thu Fri' ? 'on weekdays' : key === 'Sat Sun' ? 'at weekends' : `on ${days.join(', ')}`)
  }
  const t1 = str(s.start_time), t2 = str(s.stop_time)
  if (t1 && t2) out.push(`from ${hm(t1)} to ${hm(t2)}`)
  else if (t1) out.push(`after ${hm(t1)}`)
  else if (t2) out.push(`until ${hm(t2)}`)
  const d1 = str(s.start_date), d2 = str(s.stop_date)
  if (d1 && d2) out.push(`between ${d1} and ${d2}`)
  else if (d1) out.push(`starting ${d1}`)
  else if (d2) out.push(`until ${d2}`)
  return out.join(' ')
}

/** A rule as a sentence. `direction: false` leaves out "from <zone> … to <zone>" (shown by the
 *  group the rule sits in) but keeps addresses and ports. */
export function ruleParts(s: UciSection, { direction = true } = {}): Part[] {
  const src = str(s.src), dest = str(s.dest)
  const zone = (z: string): Part => (z === '*' ? { k: 'any' } : z ? { k: 'zone', v: z } : { k: 'router' })
  const icmp = list(s.icmp_type)
  // a long ICMP type list (fw4's ICMPv6 defaults name nine) reads as a count; the names on hover
  const what: Part = icmp.length > 3 && list(s.proto).every((p) => /icmp/.test(p))
    ? { k: 'text', v: `${icmp.length} ${/6/.test(str(s.family)) || list(s.proto).includes('icmpv6') ? 'ICMPv6' : 'ICMP'} types`, title: icmp.map((t) => ICMP_NAMES[t] ?? t).join(', ') }
    : { k: 'text', v: matchLabel(s) }
  const parts: Part[] = [{ k: 'verb', target: str(s.target) || 'ACCEPT' }, what]
  const from: Part[] = [...list(s.src_ip), ...list(s.src_mac)].map((v) => ({ k: 'addr', v }))
  if (direction) parts.push({ k: 'text', v: 'from' }, zone(src), ...from)
  else if (from.length) parts.push({ k: 'text', v: 'from' }, ...from)
  if (list(s.src_port).length) parts.push({ k: 'text', v: `port ${portsLabel(list(s.src_port))}` })
  const to: Part[] = list(s.dest_ip).map((v) => ({ k: 'addr', v }))
  if (direction) parts.push({ k: 'text', v: 'to' }, !src && !dest ? { k: 'any' } : zone(dest), ...to)
  else if (to.length) parts.push({ k: 'text', v: 'to' }, ...to)
  if (s.limit) parts.push({ k: 'text', v: `at most ${str(s.limit)}${s.limit_burst ? ` (burst ${str(s.limit_burst)})` : ''}` })
  if (s.log && s.log !== '0') parts.push({ k: 'text', v: 'and log it' })
  const when = scheduleLabel(s)
  if (when) parts.push({ k: 'text', v: when })
  return parts
}

/** The path a rule guards: fw4 files rules into one chain per source zone and direction (input,
 *  forward, output), so order only matters among rules with the same src and dest. */
export const ruleDirection = (s: UciSection) => `${str(s.src)}>${str(s.dest)}`

export function partsText(parts: Part[]): string {
  return parts.map((p) => {
    switch (p.k) {
      case 'verb': return VERB[p.target] ?? p.target
      case 'zone': return p.v.toUpperCase().length <= 4 ? p.v.toUpperCase() : p.v
      case 'router': return 'this router'
      case 'any': return 'anywhere'
      default: return p.v
    }
  }).join(' ')
}

export const ruleText = (s: UciSection) => partsText(ruleParts(s))

// ---- source NAT rules (UCI 'nat': MASQUERADE / SNAT / ACCEPT = exempt) ------------------------
// `src` is the zone the traffic leaves through (fw4 puts the rule in srcnat_<zone>).
export const natTarget = (s: UciSection) => (str(s.target).toUpperCase() || 'MASQUERADE') as 'MASQUERADE' | 'SNAT' | 'ACCEPT'

export function natParts(s: UciSection): Part[] {
  const t = natTarget(s)
  const proto = list(s.proto)
  const parts: Part[] = [{ k: 'verb', target: `nat:${t}` }]
  const p = protoLabel(proto.length ? proto : ['all'])
  const dports = list(s.dest_port)
  parts.push({ k: 'text', v: p === 'all traffic' ? 'traffic' : dports.length ? `${p} ${portsLabel(dports)}` : p })
  parts.push({ k: 'text', v: 'from' })
  const src = list(s.src_ip)
  if (src.length) for (const a of src) parts.push({ k: 'addr', v: a })
  else parts.push({ k: 'any' })
  const dst = list(s.dest_ip)
  if (dst.length) { parts.push({ k: 'text', v: 'to' }); for (const a of dst) parts.push({ k: 'addr', v: a }) }
  parts.push({ k: 'text', v: 'leaving through' })
  if (str(s.src)) parts.push({ k: 'zone', v: str(s.src) })
  if (str(s.device)) parts.push({ k: 'addr', v: str(s.device) })
  if (!str(s.src) && !str(s.device)) parts.push({ k: 'any' })
  if (t === 'SNAT') {
    const ip = str(s.snat_ip), port = str(s.snat_port)
    parts.push({ k: 'text', v: 'as' })
    parts.push({ k: 'addr', v: `${ip || 'the same address'}${port ? `:${port}` : ''}` })
  }
  const when = scheduleLabel(s)
  if (when) parts.push({ k: 'text', v: when })
  return parts
}

// ---- what fw4 actually loaded (er4.firewall_status) ------------------------------------------
export interface FwStatus { ruleset: string; counters: Record<string, { packets: number; bytes: number }> }
export const firewallStatus = () => api.call<FwStatus>('er4', 'firewall_status')
