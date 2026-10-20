// Choice chips: every option visible, one click to pick (single) or toggle (multi). Use instead
// of a <select> when there are a handful of options (zones, protocols, presets).
import type { ComponentChildren } from 'preact'
import { Icon, type IconName } from './icons'
import './extras.css'

export interface ChipOption<T extends string> {
  value: T
  label: ComponentChildren
  icon?: IconName
  /** categorical colour slot (1-8) for a swatch; the label still carries the identity */
  slot?: number
  hint?: string
  title?: string
  disabled?: boolean
}

export function Chips<T extends string>({ options, value, onChange, label }: {
  options: ChipOption<T>[]; value: T; onChange: (v: T) => void; label?: string
}) {
  return (
    <div class="chips" role="radiogroup" aria-label={label}>
      {options.map((o) => <Chip o={o} on={o.value === value} role="radio" onClick={() => onChange(o.value)} />)}
    </div>
  )
}

export function MultiChips<T extends string>({ options, value, onChange, label }: {
  options: ChipOption<T>[]; value: T[]; onChange: (v: T[]) => void; label?: string
}) {
  return (
    <div class="chips" role="group" aria-label={label}>
      {options.map((o) => {
        const on = value.includes(o.value)
        return <Chip o={o} on={on} role="checkbox" onClick={() => onChange(on ? value.filter((v) => v !== o.value) : [...value, o.value])} />
      })}
    </div>
  )
}

function Chip<T extends string>({ o, on, role, onClick }: { o: ChipOption<T>; on: boolean; role: 'radio' | 'checkbox'; onClick: () => void }) {
  return (
    <button type="button" role={role} aria-checked={on} class={`chip${on ? ' on' : ''}`} title={o.title} disabled={o.disabled} onClick={onClick}>
      {o.slot && <span class="swatch" style={{ background: `var(--series-${o.slot})` }} />}
      {o.icon && <Icon name={o.icon} size={13} />}
      {o.label}
      {o.hint && <span class="chip-hint">{o.hint}</span>}
    </button>
  )
}
