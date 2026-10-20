// QR code as crisp SVG (one path, one rect per run of dark modules). Encoder: uqr (zero-dep).
import { useMemo } from 'preact/hooks'
import { encode } from 'uqr'
import './extras.css'

export function QrCode({ text, size = 240, label }: { text: string; size?: number; label?: string }) {
  const { d, n } = useMemo(() => {
    const qr = encode(text, { ecc: 'M', border: 3 })
    let d = ''
    qr.data.forEach((row, y) => {
      let x = 0
      while (x < row.length) {
        if (!row[x]) { x++; continue }
        const start = x
        while (x < row.length && row[x]) x++
        d += `M${start} ${y}h${x - start}v1h${start - x}z`
      }
    })
    return { d, n: qr.size }
  }, [text])
  return (
    <svg class="qr" width={size} height={size} viewBox={`0 0 ${n} ${n}`} shape-rendering="crispEdges" role="img" aria-label={label ?? 'QR code'}>
      <path d={d} />
    </svg>
  )
}
