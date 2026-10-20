// Hover/focus tooltip for any inline element: <Tip text="...">badge</Tip>. Uses the shared
// .tooltip style; positioned below (or above, near the bottom edge) the anchor, kept on screen.
import type { ComponentChildren } from 'preact'
import { useRef, useState } from 'preact/hooks'
import { px } from './format'
import './extras.css'

export function Tip({ text, children }: { text: ComponentChildren; children: ComponentChildren }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null)
  const show = () => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    const left = Math.min(Math.max(8, r.left + r.width / 2 - 160), innerWidth - 328)
    setPos(r.bottom > innerHeight - 140 ? { left, bottom: innerHeight - r.top + 6 } : { left, top: r.bottom + 6 })
  }
  return (
    <span ref={ref} class="tip-anchor" onMouseEnter={show} onMouseLeave={() => setPos(null)} onFocusIn={show} onFocusOut={() => setPos(null)}>
      {children}
      {pos && <span class="tooltip tip" role="tooltip" style={{ left: px(pos.left), top: pos.top != null ? px(pos.top) : undefined, bottom: pos.bottom != null ? px(pos.bottom) : undefined }}>{text}</span>}
    </span>
  )
}
