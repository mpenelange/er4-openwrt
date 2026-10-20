// Tailscale on the router (er4 plugin over the tailscale CLI):
//   er4.tailscale_status                         -> TsStatus
//   er4.tailscale_install                        -> {}  (downloads Tailscale's own build onto the eMMC; progress in status.install)
//   er4.tailscale_update                         -> {} | {error}  (`tailscale update --yes` in the background)
//   er4.tailscale_up {routes, exit_node, accept_routes, auto_update} -> {} | {error}  (login in the background, or `tailscale set`)
//   er4.tailscale_logout {stop}                  -> {}
// The firewall side (network 'tailscale' on tailscale0, zone, WAN UDP rule) is plain UCI, staged.
import { api } from './client'
import { uci } from './uci'
import { forwardings, zones as zonesOf } from './firewall'
import type { UciConfig } from './types'

export interface TsNode {
  name: string; dns: string; ips: string[]; os?: string; online: boolean; last_seen?: string
  exit_node: boolean; exit_option: boolean; relay?: string; direct: boolean; rx: number; tx: number; routes: string[]
}
export interface TsStatus {
  installed: boolean; enabled?: boolean; running?: boolean
  /** the download of Tailscale's build (null before the first) */
  install?: { state: 'downloading' | 'ok' | 'error'; message?: string | null } | null
  version?: string | null
  /** newer release available (null when current, or unknown) */
  latest?: string | null
  updating?: boolean; update_log?: string | null
  backend?: 'NeedsLogin' | 'NeedsMachineAuth' | 'Starting' | 'Running' | 'Stopped' | 'NoState'
  auth_url?: string | null; tailnet?: string; health?: string[]
  self?: TsNode | null; peers?: TsNode[]
  prefs?: { routes: string[]; exit_node: boolean; accept_routes: boolean; use_exit_node: string | null; auto_update: boolean } | null
}
export interface TsSettings { routes: string[]; exit_node: boolean; accept_routes: boolean; auto_update: boolean }

async function checked<T>(p: Promise<T | { error: string }>): Promise<T> {
  const r = await p
  if (r && typeof r === 'object' && 'error' in r) throw new Error(r.error)
  return r as T
}

export const tailscale = {
  status: () => api.call<TsStatus>('er4', 'tailscale_status'),
  /** exit_node advertises 0.0.0.0/0 and ::/0; routes are the subnet routes only */
  up: (s: TsSettings) => checked(api.call<object | { error: string }>('er4', 'tailscale_up', { routes: s.routes, exit_node: s.exit_node, accept_routes: s.accept_routes, auto_update: s.auto_update })),
  install: () => api.call('er4', 'tailscale_install'),
  update: () => checked(api.call<object | { error: string }>('er4', 'tailscale_update')),
  logout: (stop = false) => api.call('er4', 'tailscale_logout', { stop }),
}

/** Is tailscale0 wired into the firewall (its own network section in a zone)? */
export const tsNetwork = (net: UciConfig) => Object.values(net).find((s) => s['.type'] === 'interface' && s.device === 'tailscale0')

/** Stage: network 'tailscale' (unmanaged, on tailscale0), zone 'tailscale' (the router itself
 *  reachable from the tailnet, forwards to `reach`), a rule for direct connections on UDP 41641. */
export async function stageTailscale(net: UciConfig, fw: UciConfig, reach: string[]) {
  if (!tsNetwork(net)) await uci.add('network', 'interface', { proto: 'none', device: 'tailscale0' }, 'tailscale')
  const zones = zonesOf(fw)
  const z = zones.find((x) => x.name === 'tailscale')
  if (z) { if (!z.networks.includes('tailscale')) await uci.set('firewall', z.section, { network: [...z.networks, 'tailscale'] }) }
  else await uci.add('firewall', 'zone', { name: 'tailscale', network: ['tailscale'], input: 'ACCEPT', output: 'ACCEPT', forward: 'REJECT' })
  const have = forwardings(fw).filter((f) => f.src === 'tailscale').map((f) => f.dest)
  for (const d of reach) if (!have.includes(d)) await uci.add('firewall', 'forwarding', { src: 'tailscale', dest: d })
  const wan = zones.find((x) => x.name === 'wan') ?? zones.find((x) => x.masq)
  const rule = Object.values(fw).find((s) => s['.type'] === 'rule' && s.name === 'Allow-Tailscale')
  if (wan && !rule) await uci.add('firewall', 'rule', { name: 'Allow-Tailscale', src: wan.name, proto: 'udp', dest_port: '41641', target: 'ACCEPT' })
}

/** Stage the reverse of stageTailscale: the network on tailscale0, the 'tailscale' zone (or just
 *  that network, if the zone also holds others), its forwardings and the WAN rule for UDP 41641. */
export async function unstageTailscale(net: UciConfig, fw: UciConfig) {
  const ts = tsNetwork(net)
  const name = ts?.['.name'] ?? 'tailscale'
  if (ts) await uci.remove('network', ts['.name'])
  const z = zonesOf(fw).find((x) => x.name === 'tailscale')
  const others = z ? z.networks.filter((n) => n !== name) : []
  if (z && !others.length) {
    await uci.remove('firewall', z.section)
    for (const f of forwardings(fw)) if (f.src === 'tailscale' || f.dest === 'tailscale') await uci.remove('firewall', f.section)
  } else if (z) await uci.set('firewall', z.section, { network: others })
  const rule = Object.values(fw).find((s) => s['.type'] === 'rule' && s.name === 'Allow-Tailscale')
  if (rule) await uci.remove('firewall', rule['.name'])
}

/** An exit node forwards the tailnet's internet traffic: tailscale -> wan must be allowed. */
export async function ensureExitForwarding(fw: UciConfig) {
  const zones = zonesOf(fw)
  const wan = zones.find((x) => x.name === 'wan') ?? zones.find((x) => x.masq)
  if (wan && !forwardings(fw).some((f) => f.src === 'tailscale' && f.dest === wan.name)) await uci.add('firewall', 'forwarding', { src: 'tailscale', dest: wan.name })
}
