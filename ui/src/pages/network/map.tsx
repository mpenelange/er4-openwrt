// Ports ↔ networks, drawn like the firewall zone map: the four ports on the left, the networks
// that live on a port on the right. A solid line is untagged (a network on a bridge connects to
// every member port), a dashed line a tagged VLAN. Drag a port onto a network to carry it
// untagged (staged through setPortUntagged, like the port drawer); click a solid line to take
// the port off; click a port, a network or a VLAN line for its drawer. A network bridged over
// several ports is marked: the ER-4 has no switch chip, so the CPU forwards it (no offload).
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { go } from '../../app'
import { setPortUntagged, type Net, type NetModel, type PortName, type PortTarget } from '../../api/net'
import { linkSpeed, px } from '../../components/format'
import { ErrorBox } from '../../components/ui'
import type { NetData } from './data'
import '../firewall/firewall.css' // the zone map's look (.fw-map), shared
import { portViews } from './parts'

const PW = 128, NW = 210, NH = 44, GAP = 14, PAD = 16, TOP = 0

interface Edge { port: PortName; net: Net; vid?: number; key: string }

/** How a port joins `n` untagged, or why it can't by dragging */
function targetFor(n: Net): PortTarget | string {
  if (n.where.kind === 'bridge') return { kind: 'bridge', bridge: n.where.bridge }
  if (n.wan) return { kind: 'wan' }
  if (n.where.kind === 'port' || n.where.kind === 'none') return { kind: 'net', net: n.name }
  return 'a VLAN: click the port to tag it'
}

export function NetMap({ d, m }: { d: NetData; m: NetModel }) {
  const wrap = useRef<HTMLDivElement>(null)
  const svg = useRef<SVGSVGElement>(null)
  const [W, setW] = useState(640)
  const [hover, setHover] = useState<string | null>(null)
  const [drag, setDrag] = useState<{ from: PortName; x: number; y: number; moved: boolean; over?: string } | null>(null)
  const [error, setError] = useState<unknown>()
  useEffect(() => {
    const ro = new ResizeObserver(() => wrap.current && setW(wrap.current.clientWidth))
    if (wrap.current) ro.observe(wrap.current)
    return () => ro.disconnect()
  }, [])

  const views = portViews(d, m)
  const edges: Edge[] = useMemo(() => m.ports.flatMap((p) => [
    ...(p.untagged?.nets ?? []).map((net) => ({ port: p.name, net, key: `${p.name}>${net.name}` })),
    ...p.tagged.flatMap((t) => t.nets.map((net) => ({ port: p.name, net, vid: t.vid, key: `${p.name}>${net.name}.${t.vid}` }))),
  ]), [m])
  // networks a port can carry, in the order their first port appears; unplaced ones last
  const nets = useMemo(() => {
    const placed = m.ports.flatMap((p) => edges.filter((e) => e.port === p.name).map((e) => e.net))
    const rest = m.nets.filter((n) => n.where.kind !== 'virtual' && !placed.includes(n))
    return [...new Set(placed), ...rest]
  }, [m, edges])

  const rows = Math.max(m.ports.length, nets.length, 1)
  const H = TOP + rows * (NH + GAP) - GAP + 2 * PAD
  const portY = (i: number) => TOP + PAD + ((rows - m.ports.length) * (NH + GAP)) / 2 + i * (NH + GAP)
  const netY = (i: number) => TOP + PAD + ((rows - nets.length) * (NH + GAP)) / 2 + i * (NH + GAP)
  const nx = W - PAD - NW
  // a static address as configured; an uplink's as assigned (or how it gets one)
  const addrOf = (n: Net) => {
    if (n.ipaddr) return `${n.ipaddr}/${n.prefix}`
    const live = d.ifaces?.find((i) => i.interface === n.name)
    const a = live?.['ipv4-address']?.[0] ?? live?.['ipv6-address']?.[0]
    return a ? `${a.address}/${a.mask}` : n.proto === 'static' ? 'no address' : n.proto
  }
  const bridged = (n: Net) => n.where.kind === 'bridge' && (m.bridges.find((b) => b.name === (n.where as { bridge: string }).bridge)?.ports.length ?? 0) > 1

  // spread the lines leaving / entering one box so they don't sit on top of each other
  const geom = (e: Edge) => {
    const pi = m.ports.findIndex((p) => p.name === e.port), ni = nets.indexOf(e.net)
    const outs = edges.filter((x) => x.port === e.port), ins = edges.filter((x) => x.net === e.net)
    const so = (outs.indexOf(e) - (outs.length - 1) / 2) * 7, si = (ins.indexOf(e) - (ins.length - 1) / 2) * 7
    const x1 = PAD + PW, y1 = portY(pi) + NH / 2 + so, x2 = nx - 2, y2 = netY(ni) + NH / 2 + si
    const dx = (x2 - x1) / 2
    return { d: `M${x1} ${y1}C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`, mid: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 }, end: { x: x2, y: y2 } }
  }

  const at = (ev: PointerEvent) => {
    const r = svg.current!.getBoundingClientRect()
    return { x: ev.clientX - r.left, y: ev.clientY - r.top }
  }
  const netAt = (x: number, y: number) => (x >= nx && x <= nx + NW ? nets.find((_, i) => y >= netY(i) && y <= netY(i) + NH)?.name : undefined)
  const run = (p: Promise<unknown>) => p.then(() => setError(undefined), setError)

  const down = (port: PortName) => (ev: PointerEvent) => {
    if (ev.button !== 0) return
    svg.current!.setPointerCapture(ev.pointerId)
    setDrag({ from: port, ...at(ev), moved: false })
  }
  const move = (ev: PointerEvent) => {
    if (!drag) return
    const p = at(ev)
    const i = m.ports.findIndex((x) => x.name === drag.from)
    const moved = drag.moved || Math.hypot(p.x - (PAD + PW / 2), p.y - (portY(i) + NH / 2)) > 24
    setDrag({ ...drag, ...p, moved, over: netAt(p.x, p.y) })
  }
  const up = (ev: PointerEvent) => {
    if (!drag) return
    const p = at(ev)
    const target = netAt(p.x, p.y)
    const from = drag.from
    setDrag(null)
    if (!drag.moved) return go('network', 'port', from)
    const n = nets.find((x) => x.name === target)
    if (!n || edges.some((e) => e.port === from && e.net === n && e.vid === undefined)) return
    const t = targetFor(n)
    if (typeof t !== 'string') run(setPortUntagged(m, from, t))
  }

  const over = drag?.moved && drag.over ? nets.find((n) => n.name === drag.over) : undefined
  const dragLabel = !drag?.moved ? null : !over ? `Drop on a network to carry it on ${drag.from}`
    : edges.some((e) => e.port === drag.from && e.net === over && e.vid === undefined) ? `${over.name} is already on ${drag.from}`
    : typeof targetFor(over) === 'string' ? `${over.name} is ${targetFor(over)}`
    : over.where.kind === 'port' && over.where.port !== drag.from ? `Move ${over.name} from ${over.where.port} to ${drag.from}`
    : over.where.kind === 'bridge' ? `Add ${drag.from} to ${over.name}'s bridge` : `Carry ${over.name} on ${drag.from}`
  const hot = edges.find((e) => e.key === hover)
  const dragFrom = drag && m.ports.findIndex((p) => p.name === drag.from)
  const vlanLabels = new Map<string, Edge>() // one label per network and VLAN id
  for (const e of edges) if (e.vid !== undefined && !vlanLabels.has(`${e.net.name}.${e.vid}`)) vlanLabels.set(`${e.net.name}.${e.vid}`, e)

  return (
    <div class="fw-map net-map" ref={wrap}>
      {error ? <ErrorBox error={error} /> : null}
      <svg ref={svg} width={W} height={H} viewBox={`0 0 ${W} ${H}`} onPointerMove={move} onPointerUp={up} onPointerCancel={() => setDrag(null)}
        role="img" aria-label={`Ports and networks: ${edges.map((e) => `${e.port} ${e.vid ? `VLAN ${e.vid} ` : ''}${e.net.name}`).join(', ') || 'nothing connected'}`}>
        {edges.map((e) => {
          const g = geom(e)
          const isHot = hover === e.key
          const act = () => (e.vid !== undefined ? go('network', 'port', e.port) : run(setPortUntagged(m, e.port, { kind: 'none' })))
          return (
            <g class={`edge${e.vid !== undefined ? ' tagged' : ''}${isHot ? ' hot' : ''}`}>
              <path class="line" d={g.d} style={{ stroke: isHot ? undefined : `var(--series-${e.net.slot})` }} />
              <path class="hit" d={g.d} tabindex={0} role="button"
                aria-label={e.vid !== undefined ? `${e.port} carries ${e.net.name} as VLAN ${e.vid}: open ${e.port}` : `${e.port} carries ${e.net.name} untagged: take it off`}
                onMouseEnter={() => setHover(e.key)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(e.key)} onBlur={() => setHover(null)}
                onClick={act} onKeyDown={(k) => (k.key === 'Enter' || k.key === ' ') && act()} />
            </g>
          )
        })}
        {[...vlanLabels.values()].map((e) => {
          const g = geom(e)
          return <text class="vlan-t" x={g.end.x - 10} y={g.end.y - 5} text-anchor="end">VLAN {e.vid}</text>
        })}
        {dragFrom !== null && dragFrom !== undefined && drag?.moved && (
          <path class="drag-line" d={`M${PAD + PW} ${portY(dragFrom) + NH / 2}L${drag.x} ${drag.y}`} />
        )}
        {views.map((v, i) => (
          <g class={`zone-node port-node${v.link ? '' : ' nolink'}${drag?.from === v.name ? ' source' : ''}${v.unapplied ? ' staged' : ''}`}
            transform={`translate(${PAD},${portY(i)})`} onPointerDown={down(v.name as PortName)} tabindex={0} role="button"
            aria-label={`${v.name}${v.sfp ? ' (SFP)' : ''}: ${v.link === undefined ? 'link unknown' : v.link ? linkSpeed(v.speed) : 'no link'}`}
            onKeyDown={(k) => (k.key === 'Enter' || k.key === ' ') && go('network', 'port', v.name)}>
            <title>{`${v.name}: drag onto a network to carry it, click for details`}</title>
            <rect class="body" width={PW} height={NH} rx={6} />
            <text class="name" x={12} y={20}>{v.name}</text>
            <circle cx={16} cy={32} r={3.5} class={`link-dot${v.link ? ' up' : ''}`} />
            <text class="nets" x={25} y={36}>{v.link === undefined ? '' : v.link ? linkSpeed(v.speed) : 'no link'}</text>
          </g>
        ))}
        {nets.map((n, i) => (
          <g class={`zone-node${over === n && typeof targetFor(n) !== 'string' ? ' target' : ''}`} transform={`translate(${nx},${netY(i)})`}
            onClick={() => !drag && go('network', 'iface', n.name)} tabindex={0} role="button" aria-label={`Network ${n.name}`}
            onKeyDown={(k) => (k.key === 'Enter' || k.key === ' ') && go('network', 'iface', n.name)}>
            <title>{`${n.name}: click to edit`}</title>
            <rect class="body" width={NW} height={NH} rx={6} />
            <rect width={4} height={NH - 12} x={0} y={6} rx={2} style={{ fill: `var(--series-${n.slot})` }} />
            <text class="name" x={14} y={20}>{n.name}</text>
            <text class="nets" x={14} y={36}>{addrOf(n)}</text>
            {bridged(n) && (
              <g transform={`translate(${NW - 94},8)`}>
                <title>{`Bridged across ${m.bridges.find((b) => b.name === (n.where as { bridge: string }).bridge)?.ports.join(', ')}: the ER-4 has no switch chip, so the CPU forwards between these ports (no hardware offload)`}</title>
                <rect class="tag" width={86} height={16} rx={8} /><text class="tag-t" x={43} y={12} text-anchor="middle">BRIDGE · CPU</text>
              </g>
            )}
          </g>
        ))}
      </svg>
      {hot && !drag && (
        <div class="map-label" style={{ left: px(geom(hot).mid.x), top: px(geom(hot).mid.y) }}>
          {hot.vid !== undefined ? <>{hot.port} · VLAN {hot.vid} → {hot.net.name} · <b>click for {hot.port}</b></> : <>{hot.port} → {hot.net.name} untagged · <b>click to take it off</b></>}
        </div>
      )}
      {dragLabel && <div class="map-label drag" style={{ left: px(drag!.x), top: px(drag!.y - 8) }}>{dragLabel}</div>}
    </div>
  )
}
