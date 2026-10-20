// Number/units formatting. Everything user-visible goes through these so units stay consistent.

const SI = ['', 'k', 'M', 'G', 'T']

/** 940e6 -> "940 Mbit/s". Bits per second, SI (network convention). */
export function bps(v: number, digits = 3): string {
  if (!isFinite(v)) return '–'
  let i = 0
  while (Math.abs(v) >= 1000 && i < SI.length - 1) { v /= 1000; i++ }
  return `${sig(v, digits)} ${SI[i]}bit/s`
}

/** 812345 -> "812k pps" */
export function pps(v: number): string {
  if (!isFinite(v)) return '–'
  let i = 0
  while (Math.abs(v) >= 1000 && i < SI.length - 1) { v /= 1000; i++ }
  return `${sig(v, 3)}${SI[i]} pps`
}

/** Bytes, binary units: 1536 -> "1.5 KiB" */
export function bytes(v: number): string {
  if (!isFinite(v)) return '–'
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let i = 0
  while (Math.abs(v) >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${i ? sig(v, 3) : Math.round(v)} ${u[i]}`
}

/** Compact count: 1234567 -> "1.23M" */
export function count(v: number): string {
  if (!isFinite(v)) return '–'
  let i = 0
  while (Math.abs(v) >= 1000 && i < SI.length - 1) { v /= 1000; i++ }
  return `${i ? sig(v, 3) : Math.round(v)}${SI[i].toUpperCase()}`
}

export function pct(v: number, digits = 0): string {
  return isFinite(v) ? `${v.toFixed(digits)}%` : '–'
}

/** Seconds -> "3d 2h", "4h 12m", "37s" */
export function duration(s: number): string {
  if (!isFinite(s) || s < 0) return '–'
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${Math.floor(s % 60)}s`
  return `${Math.floor(s)}s`
}

/** Link speed from netifd ("1000F") -> "1G full" */
export function linkSpeed(s?: string): string {
  if (!s || s.startsWith('-')) return 'no link'
  const n = parseInt(s, 10)
  const duplex = s.endsWith('F') ? 'full' : s.endsWith('H') ? 'half' : ''
  return `${n >= 1000 ? `${n / 1000}G` : `${n}M`}${duplex ? ` ${duplex}` : ''}`
}

function sig(v: number, digits: number) {
  const a = Math.abs(v)
  return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(Math.max(0, digits - 2)) : v.toFixed(Math.max(0, digits - 1))
}

/** CSS length for an inline style: Preact 11 no longer adds 'px' to numbers, so { width: 64 } is dropped. */
export const px = (n: number) => `${n}px`
