// Compact readouts for dense cards: meters, a two-part split bar, key/value lists and a tab
// strip for sub-routes. Styles in readouts.css (tokens only).
import type { ComponentChildren } from 'preact'
import type { Status } from './ui'
import './readouts.css'

/**
 * Ratio against a limit (a meter): accent fill on a lighter track of the same hue.
 * `status` switches fill + track to a status hue; pair it with a word (the caller's `children`).
 */
export function Meter({ value, status, label, children, thin }: {
  value: number; status?: Status; label?: string; children?: ComponentChildren; thin?: boolean
}) {
  const v = isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
  return (
    <div class={`meter${thin ? ' thin' : ''}${status ? ` ${status}` : ''}`}>
      <div class="meter-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)} aria-label={label}>
        <div class="meter-fill" style={{ width: `${v * 100}%` }} />
      </div>
      {children !== undefined && <span class="meter-text">{children}</span>}
    </div>
  )
}

/**
 * Part-to-whole of two parts: the part that matters in the accent, the rest in neutral, a
 * 2px surface gap between. Each part is labelled in ink beside a swatch (never colour alone).
 */
export function SplitBar({ parts }: { parts: { value: number; label: ComponentChildren; neutral?: boolean }[] }) {
  const total = parts.reduce((s, p) => s + (isFinite(p.value) ? p.value : 0), 0)
  return (
    <div class="splitbar">
      <div class="splitbar-bar">
        {total > 0
          ? parts.map((p) => p.value > 0 && <div class={`seg${p.neutral ? ' neutral' : ''}`} style={{ flexGrow: p.value / total }} />)
          : <div class="seg none" style={{ flexGrow: 1 }} />}
      </div>
      <div class="splitbar-legend">
        {parts.map((p) => (
          <span><i class={`sw${p.neutral ? ' neutral' : ''}`} />{p.label}</span>
        ))}
      </div>
    </div>
  )
}

/** Dense two-column key/value list. Rows: [key, value] or [key, value, title]. */
export function KV({ rows, wide }: { rows: ([ComponentChildren, ComponentChildren] | [ComponentChildren, ComponentChildren, string | undefined] | false | null | undefined)[]; wide?: boolean }) {
  return (
    <dl class={`kv${wide ? ' wide' : ''}`}>
      {rows.filter(Boolean).map((r) => {
        const [k, v, title] = r as [ComponentChildren, ComponentChildren, string?]
        return (
          <>
            <dt>{k}</dt>
            <dd title={title}>{v}</dd>
          </>
        )
      })}
    </dl>
  )
}

/** Tab strip for a page's sub-routes (links, so back/forward and deep links work). */
export function Tabs({ tabs, active }: { tabs: { id: string; label: ComponentChildren; href: string; badge?: ComponentChildren }[]; active: string }) {
  return (
    <nav class="tabs" role="tablist">
      {tabs.map((t) => (
        <a role="tab" aria-selected={t.id === active} class={t.id === active ? 'on' : ''} href={t.href}>
          {t.label}
          {t.badge}
        </a>
      ))}
    </nav>
  )
}
