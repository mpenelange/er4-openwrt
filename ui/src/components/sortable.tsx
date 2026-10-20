// Drag-to-reorder for lists. The list re-renders live in the dragged order (rows snap into
// place as the pointer passes their midpoints); dropping calls onReorder with the new key
// order. Keyboard: focus the handle, Alt+ArrowUp/ArrowDown (or plain arrows) moves one step.
//
//   const s = useSortable(rules, (r) => r.id, (keys) => save(keys))
//   <div ref={s.listRef}>{s.items.map((r) => <div {...s.itemProps(r)}><DragHandle {...s.handleProps(r)} /> ...</div>)}</div>
import { useRef, useState } from 'preact/hooks'
import { Icon } from './icons'
import './extras.css'

export function useSortable<T>(items: T[], key: (t: T) => string, onReorder: (keys: string[]) => void, disabled = false) {
  const listRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ key: string; from: number; to: number } | null>(null)

  const ordered = (() => {
    if (!drag || drag.from === drag.to) return items
    const out = [...items]
    const [m] = out.splice(drag.from, 1)
    out.splice(drag.to, 0, m)
    return out
  })()

  const commit = (from: number, to: number) => {
    if (from === to) return
    const keys = items.map(key)
    const [m] = keys.splice(from, 1)
    keys.splice(to, 0, m)
    onReorder(keys)
  }

  const onPointerDown = (k: string) => (e: PointerEvent) => {
    if (disabled || e.button !== 0) return
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-sort-key]') ?? [])]
    const mids = rows.map((r) => { const b = r.getBoundingClientRect(); return b.top + b.height / 2 })
    const from = items.findIndex((t) => key(t) === k)
    if (from < 0) return
    e.preventDefault()
    document.body.classList.add('sorting')
    let to = from
    setDrag({ key: k, from, to })
    const move = (ev: PointerEvent) => {
      const n = mids.filter((m, i) => i !== from && m < ev.clientY).length
      if (n !== to) { to = n; setDrag({ key: k, from, to }) }
    }
    const up = () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      removeEventListener('pointercancel', up)
      document.body.classList.remove('sorting')
      setDrag(null)
      commit(from, to)
    }
    // on window: the handle's row moves in the DOM while dragging
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    addEventListener('pointercancel', up)
  }

  const onKeyDown = (k: string) => (e: KeyboardEvent) => {
    if (disabled || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
    e.preventDefault()
    const from = items.findIndex((t) => key(t) === k)
    const to = Math.min(items.length - 1, Math.max(0, from + (e.key === 'ArrowUp' ? -1 : 1)))
    commit(from, to)
  }

  return {
    listRef,
    items: ordered,
    dragging: drag?.key,
    itemProps: (t: T) => ({ 'data-sort-key': key(t), class: `sort-item${drag?.key === key(t) ? ' dragging' : ''}` }),
    handleProps: (t: T) => ({ onPointerDown: onPointerDown(key(t)), onKeyDown: onKeyDown(key(t)), disabled }),
  }
}

export function DragHandle({ onPointerDown, onKeyDown, disabled, label = 'Drag to reorder' }: {
  onPointerDown: (e: PointerEvent) => void; onKeyDown: (e: KeyboardEvent) => void; disabled?: boolean; label?: string
}) {
  return (
    <button type="button" class="drag-handle" aria-label={`${label} (arrow keys move)`} title={disabled ? 'Clear the filter to reorder' : label}
      disabled={disabled} onPointerDown={onPointerDown} onKeyDown={onKeyDown}>
      <Icon name="drag" />
    </button>
  )
}
