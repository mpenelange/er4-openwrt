// Which staged changes could cut this browser off from the router: LAN addressing and ports,
// firewall input from inside networks, the web server, SSH. Only those are applied with the
// rollback countdown ("Keep" within ROLLBACK_SECONDS); everything else applies in one step.
import { isExternal, zones } from './firewall'
import type { UciChanges, UciConfig } from './types'

/** Configs that are how you reach the router. */
const ALWAYS: Record<string, string> = { uhttpd: 'the web server', dropbear: 'SSH', rpcd: 'logins and access rights' }
/** Interface protocols with no LAN address on them: tunnels, and Tailscale's unmanaged network. */
const TUNNEL = new Set(['wireguard', 'none', '6in4', 'gre', 'gretap', 'vxlan'])
const NET_SAFE = (t: string) => t.startsWith('wireguard_') || ['route', 'route6', 'rule', 'rule6'].includes(t)
const FW_SAFE = new Set(['redirect', 'forwarding', 'ipset', 'include', 'nat'])

/** Why these changes could lock you out (empty: they can't). `staged` is the staged view of
 *  network and firewall; a section removed there has no type left to judge by, so it counts. */
export function lockoutRisks(ch: UciChanges, staged: { network?: UciConfig; firewall?: UciConfig }): string[] {
  const out: string[] = []
  for (const [cfg, list] of Object.entries(ch)) {
    if (ALWAYS[cfg]) { out.push(ALWAYS[cfg]); continue }
    const names = [...new Set(list.map((c) => c[1]))]
    if (cfg === 'network') {
      const net = staged.network ?? {}
      const risky = names.some((n) => {
        const s = net[n]
        if (!s) return true
        const t = s['.type']
        return !(NET_SAFE(t) || (t === 'interface' && TUNNEL.has(String(s.proto ?? ''))))
      })
      if (risky) out.push('network addresses or ports')
    }
    if (cfg === 'firewall') {
      const fw = staged.firewall ?? {}
      const outside = new Set(zones(fw).filter(isExternal).map((z) => z.name))
      const risky = names.some((n) => {
        const s = fw[n]
        if (!s) return true
        const t = s['.type']
        if (FW_SAFE.has(t)) return false
        // a rule matters only for traffic into the router (no dest) from an inside zone
        if (t === 'rule') return !s.dest && !outside.has(String(s.src ?? ''))
        return true
      })
      if (risky) out.push('firewall zones or rules for the router itself')
    }
  }
  return out
}
