// Small pieces shared by the firewall views: zone pills, the rule/forward sentence renderer,
// "unapplied" and "slow path" badges, and the page-wide data context.
import { createContext } from 'preact'
import { useContext } from 'preact/hooks'
import type { UciConfig, UciSection } from '../../api/types'
import { VERB, isEnabled, slowPathReasons, str, type Part, type Zone } from '../../api/firewall'
import { bytes, count } from '../../components/format'
import { Badge } from '../../components/ui'
import { Icon, type IconName } from '../../components/icons'
import { Tip } from '../../components/tooltip'

export interface FwData {
  fw: UciConfig
  net: UciConfig
  zones: Zone[]
  /** firewall sections with unapplied changes */
  staged: Set<string>
  /** fw4's counters per rule name (er4.firewall_status); undefined while loading or on error */
  hits?: Record<string, { packets: number; bytes: number }>
}

export const FwCtx = createContext<FwData>({ fw: {}, net: {}, zones: [], staged: new Set() })
export const useFw = () => useContext(FwCtx)

export function zoneIcon(z: Zone | undefined, net: UciConfig): IconName {
  if (!z) return 'network'
  if (z.networks.some((n) => net[n]?.proto === 'wireguard') || z.name === 'vpn') return 'vpn'
  if (z.masq || z.networks.some((n) => /^wan/.test(n))) return 'globe'
  return 'network'
}

export function ZonePill({ name }: { name: string }) {
  const { zones, net } = useFw()
  const z = zones.find((x) => x.name === name)
  return (
    <span class={`zone-pill${z ? '' : ' missing'}`} title={z ? `zone ${z.name}: ${z.networks.join(', ') || 'no networks'}` : `zone ${name} does not exist`}>
      <span class="swatch" style={{ background: z ? `var(--series-${z.slot})` : 'var(--text-muted)' }} />
      <Icon name={zoneIcon(z, net)} size={12} />
      {name}
    </span>
  )
}

export function RouterPill() {
  return <span class="zone-pill router" title="The router itself (input / output traffic)"><Icon name="chip" size={12} />this router</span>
}

const VERB_STATUS: Record<string, 'good' | 'serious' | 'critical' | undefined> = { ACCEPT: 'good', REJECT: 'serious', DROP: 'critical' }
const VERB_TIP: Record<string, string> = {
  ACCEPT: 'Allow: let the traffic through.',
  REJECT: 'Reject: block and tell the sender (TCP reset / ICMP unreachable), so apps fail fast.',
  DROP: 'Drop: block silently; the sender just times out.',
  'nat:MASQUERADE': "Masquerade: rewrite the source to the outgoing port's own address.",
  'nat:SNAT': 'Source NAT: rewrite the source to a fixed address (and port).',
  'nat:ACCEPT': 'No NAT: send this traffic out with its original source address, even through a masqueraded zone.',
}

export function Verb({ target }: { target: string }) {
  return (
    <Tip text={VERB_TIP[target] ?? target}>
      <Badge status={VERB_STATUS[target]}>{VERB[target] ?? target}</Badge>
    </Tip>
  )
}

export function Sentence({ parts }: { parts: Part[] }) {
  return (
    <span class="sentence">
      {parts.map((p) => {
        switch (p.k) {
          case 'verb': return <Verb target={p.target} />
          case 'zone': return <ZonePill name={p.v} />
          case 'router': return <RouterPill />
          case 'any': return <span class="zone-pill any">anywhere</span>
          case 'addr': return <code class="addr">{p.v}</code>
          default: return <span title={p.title} class={p.title ? 'has-tip' : undefined}>{p.v}</span>
        }
      })}
    </span>
  )
}

/** How often fw4's rule for this section matched since the firewall was last loaded. */
export function Hits({ s }: { s: UciSection }) {
  const { hits, staged } = useFw()
  const c = hits?.[str(s.name) || s['.name']]
  if (!hits || !isEnabled(s) || staged.has(s['.name'])) return null
  const title = c ? `${c.packets} packets (${bytes(c.bytes)}) matched since the firewall was last loaded. Rules see the first packets of a connection, so this is roughly connections.` : 'Not in the loaded firewall'
  return <span class={`hits num${c?.packets ? '' : ' none'}`} title={title}>{c ? (c.packets ? `${count(c.packets)} hits` : 'no hits') : '–'}</span>
}

export function Unapplied() {
  return <Tip text="Staged, not live yet. Review and apply from the top bar."><Badge status="accent">unapplied</Badge></Tip>
}

/** A rule on forwarded traffic (zone to zone), the only kind offload could take */
export const isForwardRule = (s: UciSection) => !!str(s.src) && !!str(s.dest)

export function SlowPath({ s }: { s: UciSection }) {
  const why = slowPathReasons(s)
  // traffic to or from the router itself is the CPU's anyway: only forwarded traffic loses offload
  if (!why.length || !isForwardRule(s)) return null
  return (
    <Tip text={<>
      <strong>CPU slow path.</strong> This rule uses {why.join(', ')}, which the hardware flow offload can't do, so matching
      traffic is handled by the CPU on every packet instead of being offloaded (much lower throughput, more CPU load).
    </>}>
      <span class="slow-badge" tabIndex={0}><Icon name="warning" size={12} />slow path</span>
    </Tip>
  )
}
