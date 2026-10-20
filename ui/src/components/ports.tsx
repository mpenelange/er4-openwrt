// The ER-4 ports as a row of tiles, the same look as the dashboard's: name, role, the networks
// the port carries (swatch + name; tagged ones say "VLAN n"), link state. Each port a button.
//   <PortPanel ports={ER4_PORTS.map((p) => ({ ...p, link: true, speed: '1000F', role: 'WAN' }))}
//              selected="eth0" onSelect={(name) => go('network', 'port', name)} />
// Swatch colours are network identities (series slots); the text always carries the meaning.
import { linkSpeed } from './format'
import './ports.css'

export const ER4_PORTS: { name: string; sfp?: boolean }[] = [
  { name: 'eth0' }, { name: 'eth1' }, { name: 'eth2' }, { name: 'eth3', sfp: true },
]

export interface PortView {
  name: string
  sfp?: boolean
  /** carrier; undefined = unknown */
  link?: boolean
  /** netifd speed, e.g. "1000F" */
  speed?: string
  /** short role, e.g. "WAN", "LAN", "Trunk", "Unused" */
  role?: string
  /** networks carried: untagged first, then tagged VLANs (vid set) */
  nets?: { slot: number; name: string; vid?: number; label: string }[]
  /** unused port, or not part of what's being shown: drawn dimmed */
  idle?: boolean
  /** has unapplied changes */
  unapplied?: boolean
}

export function PortPanel({ ports, selected, onSelect, compact }: {
  ports: PortView[]
  selected?: string
  onSelect?: (name: string) => void
  compact?: boolean
}) {
  return (
    <div class={`portpanel${compact ? ' compact' : ''}`}>
      <div class="ports">
        {ports.map((p) => {
          const Tag = onSelect ? 'button' : 'div'
          const link = p.link === undefined ? '' : p.link ? linkSpeed(p.speed) : 'no link'
          return (
            <Tag
              type={onSelect ? 'button' : undefined}
              class={`port${p.idle ? ' idle' : ''}${selected === p.name ? ' selected' : ''}${onSelect ? ' clickable' : ''}`}
              onClick={onSelect && (() => onSelect(p.name))}
              aria-pressed={onSelect ? selected === p.name : undefined}
              aria-label={`${p.name}${p.sfp ? ' (SFP)' : ''}: ${p.role ?? ''}, ${link}`}
            >
              <span class="pname">{p.name}</span>
              {p.role && <span class="role">{p.role}</span>}
              {!!p.nets?.length && (
                <span class="nets">
                  {p.nets.map((n) => (
                    <span class="net" title={n.label}>
                      <i class={`sw${n.vid !== undefined ? ' tagged' : ''}`} style={{ '--c': `var(--series-${n.slot})` }} />
                      {n.name}{n.vid !== undefined && <span class="muted"> VLAN {n.vid}</span>}
                    </span>
                  ))}
                </span>
              )}
              {link && <span class={`link${p.link ? ' up' : ''}`}><i class="dot" />{link}</span>}
              {p.unapplied && <span class="tag accent">unapplied</span>}
            </Tag>
          )
        })}
      </div>
    </div>
  )
}
