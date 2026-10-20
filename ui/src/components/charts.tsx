// Charts. Rules: series colours from --series-N in fixed order; one y-axis
// (never dual); 2px lines; recessive grid; crosshair + one readout listing every series at
// that x; a legend for >= 2 series; text in ink colours, never series colours.
import { useEffect, useRef } from 'preact/hooks'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'

export interface Series {
  label: string
  /** 1-8: categorical slot. Assign by entity (e.g. port), never by rank. */
  slot: number
  values: (number | null)[]
}

function cssVar(el: Element, name: string) {
  return getComputedStyle(el).getPropertyValue(name).trim()
}

/** Re-render when the OS or the in-app theme flips, so canvas colours follow the tokens. */
function useThemeVersion(cb: () => void) {
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const obs = new MutationObserver(cb)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    mq.addEventListener('change', cb)
    return () => { obs.disconnect(); mq.removeEventListener('change', cb) }
  }, [])
}

/**
 * Time series with a shared y-axis. `times` in seconds (unix). `format` formats y values for
 * the axis and the readout (e.g. bps). Height in px; width follows the container.
 */
export function TimeSeries({ times, series, format, height = 180, yMin = 0, stacked = false }: {
  times: number[]; series: Series[]; format: (v: number) => string; height?: number; yMin?: number; stacked?: boolean
}) {
  const box = useRef<HTMLDivElement>(null)
  const plot = useRef<uPlot | null>(null)

  const build = () => {
    const el = box.current
    if (!el) return
    plot.current?.destroy()
    const ink = cssVar(el, '--text-muted')
    const grid = cssVar(el, '--grid')
    const opts: uPlot.Options = {
      width: el.clientWidth,
      height,
      padding: [8, 8, 0, 0],
      cursor: { points: { size: 8, width: 2 }, drag: { x: false, y: false } },
      legend: { show: series.length > 1, live: true },
      // Off the plot, the legend reads the newest sample (live values) instead of blanks
      hooks: { setCursor: [showLatest], setData: [showLatest] },
      scales: { x: { time: true }, y: { range: (_u, _min, max) => [yMin, Math.max(max * 1.1, yMin + 1)] } },
      axes: [
        { stroke: ink, grid: { show: false }, ticks: { stroke: grid, width: 1 }, font: '11px system-ui', size: 28, values: timeTicks },
        { stroke: ink, grid: { stroke: grid, width: 1 }, ticks: { show: false }, font: '11px system-ui', size: 64,
          values: (_u, vals) => vals.map((v) => format(v)) },
      ],
      series: [
        { value: (_u, v) => (v == null ? '' : clock(new Date(v * 1000), true)) },
        ...series.map((s) => {
          const color = cssVar(el, `--series-${s.slot}`)
          return {
            label: s.label,
            stroke: color,
            width: 2,
            fill: stacked ? color + '33' : undefined,
            points: { show: false },
            value: (_u: uPlot, v: number | null) => (v == null ? '–' : format(v)),
          }
        }),
      ],
    }
    plot.current = new uPlot(opts, [times, ...series.map((s) => s.values)] as uPlot.AlignedData, el)
  }

  // (Re)build when the series set changes; otherwise just push new data
  const shape = series.map((s) => `${s.label}:${s.slot}`).join('|')
  useEffect(() => { build(); return () => plot.current?.destroy() }, [shape, height])
  useEffect(() => { plot.current?.setData([times, ...series.map((s) => s.values)] as uPlot.AlignedData) }, [times, series])
  useThemeVersion(build)
  useEffect(() => {
    const ro = new ResizeObserver(() => box.current && plot.current?.setSize({ width: box.current.clientWidth, height }))
    if (box.current) ro.observe(box.current)
    return () => ro.disconnect()
  }, [height])

  return <div ref={box} class="timeseries" />
}

/** Tiny inline trend line for stat tiles and table cells; no axes, no interaction. */
export function Sparkline({ values, slot = 1, width = 80, height = 22, max }: { values: number[]; slot?: number; width?: number; height?: number; max?: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const draw = () => {
    const c = ref.current
    if (!c || values.length < 2) return
    const dpr = devicePixelRatio || 1
    c.width = width * dpr
    c.height = height * dpr
    const g = c.getContext('2d')!
    g.scale(dpr, dpr)
    g.clearRect(0, 0, width, height)
    const top = max ?? Math.max(...values, 1e-9)
    g.strokeStyle = cssVar(c, `--series-${slot}`)
    g.lineWidth = 1.5
    g.lineJoin = 'round'
    g.beginPath()
    values.forEach((v, i) => {
      const x = (i / (values.length - 1)) * (width - 2) + 1
      const y = height - 2 - (Math.min(v, top) / top) * (height - 4)
      i ? g.lineTo(x, y) : g.moveTo(x, y)
    })
    g.stroke()
  }
  useEffect(draw, [values, slot, width, height, max])
  useThemeVersion(draw)
  return <canvas ref={ref} style={{ width: `${width}px`, height: `${height}px`, display: 'block' }} aria-hidden="true" />
}

/** Single-line x tick labels (uPlot's defaults are two lines and the 28px axis band cuts the second). */
function showLatest(u: uPlot) {
  if (u.cursor.idx != null) return
  const n = u.data[0].length
  for (let i = n - 1; i >= 0; i--) {
    if (u.data.some((d, k) => k > 0 && d[i] != null)) { u.setLegend({ idx: i }); return }
  }
}

/** 24 h clock, as on the time axis: HH:MM or HH:MM:SS. */
function clock(d: Date, seconds: boolean): string {
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}${seconds ? `:${two(d.getSeconds())}` : ''}`
}

function timeTicks(_u: uPlot, splits: number[], _axis: number, _space: number, incr: number): string[] {
  return splits.map((v) => {
    const d = new Date(v * 1000)
    if (incr >= 86400) return `${d.getDate()}.${d.getMonth() + 1}.`
    return clock(d, incr < 60)
  })
}
