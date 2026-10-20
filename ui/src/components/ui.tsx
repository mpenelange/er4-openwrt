// The component kit. Pages build from these (and the classes in styles/base.css) so every
// screen has the same density and behaviour. Add to this file when a pattern repeats.
import { cloneElement, isValidElement, type ButtonHTMLAttributes, type ComponentChildren, type VNode } from 'preact'
import { useEffect, useId, useMemo, useRef, useState } from 'preact/hooks'
import { Icon, type IconName } from './icons'

export function Card({ title, actions, flush, children, class: cls = '' }: {
  title?: ComponentChildren; actions?: ComponentChildren; flush?: boolean; children: ComponentChildren; class?: string
}) {
  return (
    <section class={`card ${cls}`}>
      {(title || actions) && (
        <div class="card-head">
          {title && <h3>{title}</h3>}
          <span class="spacer" />
          {actions}
        </div>
      )}
      <div class={`card-body${flush ? ' flush' : ''}`}>{children}</div>
    </section>
  )
}

export function PageHead({ title, children }: { title: string; children?: ComponentChildren }) {
  return (
    <div class="page-head">
      <h1>{title}</h1>
      <span class="spacer" />
      {children}
    </div>
  )
}

export function Stat({ label, value, sub }: { label: string; value: ComponentChildren; sub?: ComponentChildren }) {
  return (
    <div class="stat">
      <span class="label">{label}</span>
      <span class="value">{value}</span>
      {sub !== undefined && <span class="sub">{sub}</span>}
    </div>
  )
}

export type Status = 'good' | 'warning' | 'serious' | 'critical'
/** Status always carries a word, never colour alone. */
export function Badge({ status, children }: { status?: Status | 'accent'; children: ComponentChildren }) {
  return (
    <span class={`badge ${status ?? ''}`}>
      {status && status !== 'accent' && <span class="dot" />}
      {children}
    </span>
  )
}

export function Button({ icon, variant, children, ...rest }: {
  icon?: IconName; variant?: 'primary' | 'danger' | 'ghost'; children?: ComponentChildren
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const iconOnly = icon && !children
  return (
    <button type="button" class={`btn ${variant ?? ''} ${iconOnly ? 'icon' : ''}`} {...rest}>
      {icon && <Icon name={icon} />}
      {children}
    </button>
  )
}

export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled}
      class={`toggle${on ? ' on' : ''}`} onClick={() => onChange(!on)} />
  )
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div class="segmented" role="radiogroup">
      {options.map((o) => (
        <button type="button" role="radio" aria-checked={o.value === value} class={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ComponentChildren }) {
  const id = useId()
  // A lone input/select/textarea gets linked to the label and to the hint/error line
  const control = isValidElement(children) && ['input', 'select', 'textarea'].includes((children as VNode).type as string)
  const props: Record<string, unknown> = control ? (children as VNode<Record<string, unknown>>).props : {}
  const cid = (props.id as string | undefined) ?? `${id}-c`
  return (
    <div class="field">
      <label for={control ? cid : undefined}>{label}</label>
      {control ? cloneElement(children as VNode, { id: cid, 'aria-describedby': error || hint ? `${id}-d` : undefined, 'aria-invalid': error ? true : undefined }) : children}
      {error ? <span class="error" id={`${id}-d`}>{error}</span> : hint && <span class="hint" id={`${id}-d`}>{hint}</span>}
    </div>
  )
}

export function Drawer({ title, onClose, footer, children }: { title: ComponentChildren; onClose: () => void; footer?: ComponentChildren; children: ComponentChildren }) {
  useEscape(onClose)
  const id = useId()
  const ref = useDialogFocus()
  return (
    <>
      <div class="backdrop" onClick={onClose} />
      <div class="drawer" role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} ref={ref}>
        <div class="drawer-head">
          <h2 id={id}>{title}</h2>
          <span class="spacer" />
          <Button icon="close" variant="ghost" aria-label="Close" onClick={onClose} />
        </div>
        <div class="drawer-body">{children}</div>
        {footer && <div class="drawer-foot">{footer}</div>}
      </div>
    </>
  )
}

export function Modal({ title, onClose, footer, children }: { title: ComponentChildren; onClose: () => void; footer?: ComponentChildren; children: ComponentChildren }) {
  useEscape(onClose)
  const id = useId()
  const ref = useDialogFocus()
  return (
    <>
      <div class="backdrop" onClick={onClose} />
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} ref={ref}>
        <div class="drawer-head"><h2 id={id}>{title}</h2><span class="spacer" /><Button icon="close" variant="ghost" aria-label="Close" onClick={onClose} /></div>
        <div class="drawer-body">{children}</div>
        {footer && <div class="drawer-foot">{footer}</div>}
      </div>
    </>
  )
}

export function Empty({ children }: { children: ComponentChildren }) {
  return <div class="empty">{children}</div>
}

export function ErrorBox({ error }: { error: unknown }) {
  return <div class="error-box">{error instanceof Error ? error.message : String(error)}</div>
}

/** Focus moves into a dialog when it opens (to its autoFocus field, else the dialog) and back
 *  to whatever had it when the dialog closes. Browsers honour the autofocus attribute only once
 *  per page load, so it is applied here. */
function useDialogFocus() {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    const el = ref.current
    if (el && !el.contains(document.activeElement)) (el.querySelector<HTMLElement>('[autofocus]') ?? el).focus()
    return () => { if (prev?.isConnected && prev !== document.body) prev.focus() }
  }, [])
  return ref
}

function useEscape(fn: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && fn()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [fn])
}

// ---- sortable dense table ------------------------------------------------------------
export interface Column<T> {
  key: string
  label: string
  render?: (row: T) => ComponentChildren
  /** Sort value; defaults to row[key]. Columns without a value aren't sortable. */
  value?: (row: T) => string | number
  num?: boolean
  width?: string
  /** what the column means, on hover over its header */
  tip?: string
}

export function Table<T>({ columns, rows, rowKey, onRowClick, rowClass, empty = 'Nothing here yet' }: {
  columns: Column<T>[]; rows: T[]; rowKey: (r: T) => string; onRowClick?: (r: T) => void
  rowClass?: (r: T) => string; empty?: ComponentChildren
}) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null)
  const sorted = useMemo(() => {
    if (!sort) return rows
    const col = columns.find((c) => c.key === sort.key)
    const val = col?.value ?? ((r: T) => (r as Record<string, unknown>)[sort.key] as string | number)
    return [...rows].sort((a, b) => {
      const x = val(a), y = val(b)
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir
    })
  }, [rows, sort, columns])
  if (!rows.length) return <Empty>{empty}</Empty>
  return (
    <table class="table">
      <thead>
        <tr>
          {columns.map((c) => (
            <th class={`${c.num ? 'num' : ''} sortable`} style={c.width ? { width: c.width } : undefined}
              onClick={() => setSort((s) => (s?.key === c.key ? (s.dir === 1 ? { key: c.key, dir: -1 } : null) : { key: c.key, dir: 1 }))}>
              {c.tip ? <span class="th-tip" title={c.tip}>{c.label}</span> : c.label}
              {sort?.key === c.key && <Icon name={sort.dir === 1 ? 'arrowUp' : 'arrowDown'} size={11} style={{ marginLeft: 4, verticalAlign: -1 }} />}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.map((r) => (
          <tr key={rowKey(r)} class={`${onRowClick ? 'clickable' : ''} ${rowClass?.(r) ?? ''}`} onClick={onRowClick && (() => onRowClick(r))}>
            {columns.map((c) => (
              <td class={c.num ? 'num' : ''}>{c.render ? c.render(r) : String((r as Record<string, unknown>)[c.key] ?? '')}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
