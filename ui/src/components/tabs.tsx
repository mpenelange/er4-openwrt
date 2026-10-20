// Sub-route tabs for a page (#/firewall/zones, #/firewall/rules ...): plain links, so the
// browser's back button and deep links work.
import type { ComponentChildren } from 'preact'
import './extras.css'

export interface TabItem { id: string; label: ComponentChildren; href: string; count?: number }

export function Tabs({ items, active }: { items: TabItem[]; active: string }) {
  return (
    <nav class="tabs" role="tablist">
      {items.map((t) => (
        <a href={t.href} role="tab" aria-selected={t.id === active} class={t.id === active ? 'active' : ''}>
          {t.label}
          {t.count !== undefined && <span class="count">{t.count}</span>}
        </a>
      ))}
    </nav>
  )
}
