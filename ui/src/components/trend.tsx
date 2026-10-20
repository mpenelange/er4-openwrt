// Sparkline in any token colour (charts.tsx's Sparkline is for series slots). For stat-tile
// trends use the de-emphasis hue: color="--text-muted" (default). Gaps (null)
// break the line. Optional fixed range so e.g. CPU % trends share a 0-100 scale.
import { useEffect, useRef, useState } from 'preact/hooks'

/** Omit `width` to fill the parent's width. */
export function Trend({ values, color = '--text-muted', width: fixedWidth, height = 20, min = 0, max, fill }: {
  values: (number | null)[]; color?: string; width?: number; height?: number; min?: number; max?: number; fill?: boolean
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [measured, setMeasured] = useState(0)
  const width = fixedWidth ?? measured
  useEffect(() => {
    if (fixedWidth != null) return
    const parent = ref.current?.parentElement
    if (!parent) return
    const ro = new ResizeObserver(() => setMeasured(Math.floor(parent.clientWidth)))
    ro.observe(parent)
    return () => ro.disconnect()
  }, [fixedWidth])
  const draw = () => {
    const c = ref.current
    if (!c || !width) return
    const dpr = devicePixelRatio || 1
    c.width = width * dpr
    c.height = height * dpr
    const g = c.getContext('2d')!
    g.scale(dpr, dpr)
    g.clearRect(0, 0, width, height)
    const nums = values.filter((v): v is number => v != null && isFinite(v))
    if (nums.length < 2) return
    const top = max ?? Math.max(...nums, min + 1e-9)
    const col = getComputedStyle(c).getPropertyValue(color).trim()
    const x = (i: number) => (i / (values.length - 1)) * (width - 2) + 1
    const y = (v: number) => height - 1.5 - ((Math.min(Math.max(v, min), top) - min) / (top - min || 1)) * (height - 3)
    g.lineWidth = 1.5
    g.lineJoin = 'round'
    g.strokeStyle = col
    let open = false
    let first = 0
    const finish = (last: number) => {
      g.stroke()
      if (fill) {
        g.lineTo(x(last), height)
        g.lineTo(x(first), height)
        g.closePath()
        g.globalAlpha = 0.12
        g.fillStyle = col
        g.fill()
        g.globalAlpha = 1
      }
    }
    values.forEach((v, i) => {
      if (v == null || !isFinite(v)) {
        if (open) finish(i - 1)
        open = false
        return
      }
      if (!open) { g.beginPath(); g.moveTo(x(i), y(v)); open = true; first = i }
      else g.lineTo(x(i), y(v))
    })
    if (open) finish(values.length - 1)
  }
  useEffect(draw, [values, color, width, height, min, max])
  useEffect(() => {
    const obs = new MutationObserver(draw)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  })
  return <canvas ref={ref} style={{ width: fixedWidth != null ? `${fixedWidth}px` : '100%', height: `${height}px`, display: 'block' }} aria-hidden="true" />
}
