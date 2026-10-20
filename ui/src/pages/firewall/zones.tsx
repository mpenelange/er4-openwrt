// Zones: the map (zones as nodes, allowed forwardings as arrows; drag zone -> zone to allow,
// click an arrow to block), the zone x zone matrix (click a cell to toggle), per-zone default
// policies inline, global defaults, and the zone editor drawer.
//
// fw4 semantics shown here: traffic from zone A to zone B passes if a forwarding A -> B exists,
// otherwise the global default forward policy decides. A zone's own "forward" policy only covers
// traffic between networks of that same zone (the matrix diagonal).
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { go } from '../../app'
import { uci } from '../../api/uci'
import { forwardings, isExternal, ofType, POLICIES, setOptions, str, type Forwarding, type Policy, type Zone } from '../../api/firewall'
import { Button, Card, Drawer, Field, Segmented, Table, Toggle, ErrorBox } from '../../components/ui'
import { Icon } from '../../components/icons'
import { px } from '../../components/format'
import { MultiChips } from '../../components/chips'
import { Tip } from '../../components/tooltip'
import { Unapplied, ZonePill, useFw, zoneIcon } from './parts'

const POLICY_OPTS = POLICIES.map((p) => ({ value: p, label: p[0] + p.slice(1).toLowerCase() }))

async function allow(src: string, dest: string, existing?: Forwarding) {
  if (existing) await uci.remove('firewall', existing.section, ['enabled'])
  else await uci.add('firewall', 'forwarding', { src, dest })
}
const block = (f: Forwarding) => uci.remove('firewall', f.section)

export function ZonesView({ openId }: { openId?: string }) {
  const { fw, zones } = useFw()
  const fwd = forwardings(fw)
  const close = () => go('firewall', 'zones')
  const editing = openId === 'new' ? null : zones.find((z) => z.section === openId)
  return (
    <>
      <div class={`fw-zone-top${zones.length > 5 ? ' stacked' : ''}`}>
        <Card title="Zone map">
          {zones.length ? <ZoneMap fwd={fwd} /> : <div class="empty">No zones. Add one below.</div>}
        </Card>
        <Card title="Who may reach whom" flush>
          <ZoneMatrix fwd={fwd} />
        </Card>
      </div>
      <Card title="Zones" flush actions={<Button icon="plus" onClick={() => go('firewall', 'zones', 'new')}>Add zone</Button>}>
        <ZoneTable />
      </Card>
      <DefaultsCard />
      {openId && (openId === 'new' || editing) && <ZoneDrawer zone={editing ?? undefined} onClose={close} />}
    </>
  )
}

// ---- map ------------------------------------------------------------------------------------
const NW = 156, NH = 48, GAP = 22, PAD = 20

interface Box { x: number; y: number; z: Zone; col: 'int' | 'ext' }

function ZoneMap({ fwd }: { fwd: Forwarding[] }) {
  const { zones, staged, net } = useFw()
  const wrap = useRef<HTMLDivElement>(null)
  const svg = useRef<SVGSVGElement>(null)
  const [W, setW] = useState(640)
  const [hover, setHover] = useState<string | null>(null)
  const [drag, setDrag] = useState<{ from: string; x: number; y: number; moved: boolean; over?: string } | null>(null)
  const [error, setError] = useState<unknown>()

  useEffect(() => {
    const ro = new ResizeObserver(() => wrap.current && setW(wrap.current.clientWidth))
    if (wrap.current) ro.observe(wrap.current)
    return () => ro.disconnect()
  }, [])

  const internal = zones.filter((z) => !isExternal(z))
  const external = zones.filter(isExternal)
  const rows = Math.max(internal.length, external.length, 1)
  const H = rows * (NH + GAP) - GAP + 2 * PAD
  const side = Math.max(PAD + 70, Math.min(W * 0.2, 170))
  const boxes = useMemo(() => {
    const out = new Map<string, Box>()
    const place = (list: Zone[], x: number, col: 'int' | 'ext') => {
      const off = ((rows - list.length) * (NH + GAP)) / 2
      list.forEach((z, i) => out.set(z.name, { x, y: PAD + off + i * (NH + GAP), z, col }))
    }
    place(internal, external.length ? side : W / 2 - NW / 2, 'int')
    place(external, W - side - NW, 'ext')
    return out
  }, [zones, W])

  const edges = fwd.flatMap((f) => {
    const a = boxes.get(f.src), b = boxes.get(f.dest)
    if (!a || !b || a === b) return []
    const reverse = fwd.some((g) => g.src === f.dest && g.dest === f.src)
    return [{ f, ...edgeGeom(a, b, reverse) }]
  })

  const at = (e: PointerEvent) => {
    const r = svg.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const hit = (x: number, y: number) => [...boxes.values()].find((b) => x >= b.x && x <= b.x + NW && y >= b.y && y <= b.y + NH)?.z.name

  const run = (p: Promise<unknown>) => p.then(() => setError(undefined), setError)

  const down = (z: string) => (e: PointerEvent) => {
    if (e.button !== 0) return
    svg.current!.setPointerCapture(e.pointerId)
    setDrag({ from: z, ...at(e), moved: false })
  }
  const move = (e: PointerEvent) => {
    if (!drag) return
    const p = at(e)
    const b = boxes.get(drag.from)!
    const moved = drag.moved || Math.hypot(p.x - (b.x + NW / 2), p.y - (b.y + NH / 2)) > 30
    setDrag({ ...drag, ...p, moved, over: hit(p.x, p.y) })
  }
  const up = (e: PointerEvent) => {
    if (!drag) return
    const p = at(e)
    const target = hit(p.x, p.y)
    setDrag(null)
    if (!drag.moved || target === drag.from) {
      const z = zones.find((x) => x.name === drag.from)
      if (z && target === drag.from) go('firewall', 'zones', z.section)
      return
    }
    if (!target) return
    const existing = fwd.find((f) => f.src === drag.from && f.dest === target)
    if (!existing || !existing.enabled) run(allow(drag.from, target, existing))
  }

  const hovered = edges.find((e) => e.f.section === hover)
  const dragFrom = drag && boxes.get(drag.from)
  const dragLabel = drag?.moved && drag.over && drag.over !== drag.from
    ? fwd.some((f) => f.src === drag.from && f.dest === drag.over && f.enabled) ? `${drag.from} → ${drag.over} is already allowed` : `Allow ${drag.from} → ${drag.over}`
    : drag?.moved ? `Drop on a zone to allow ${drag.from} → …` : null

  return (
    <div class="fw-map" ref={wrap}>
      {error ? <ErrorBox error={error} /> : null}
      <svg ref={svg} width={W} height={H} viewBox={`0 0 ${W} ${H}`} onPointerMove={move} onPointerUp={up} onPointerCancel={() => setDrag(null)}
        role="img" aria-label={`Zone map: ${edges.filter((e) => e.f.enabled).map((e) => `${e.f.src} to ${e.f.dest}`).join(', ') || 'no forwardings'}`}>
        <defs>
          {['on', 'hot', 'off'].map((k) => (
            <marker id={`fw-arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
              <path class={`arrowhead ${k}`} d="M0 0L10 5L0 10z" />
            </marker>
          ))}
        </defs>
        {external.length > 0 && internal.length > 0 && (
          <g class="map-cols">
            <text x={side + NW / 2} y={12} text-anchor="middle">INSIDE</text>
            <text x={W - side - NW / 2} y={12} text-anchor="middle">INTERNET SIDE</text>
          </g>
        )}
        {edges.map(({ f, d }) => {
          const hot = hover === f.section
          const cls = `edge${f.enabled ? '' : ' disabled'}${staged.has(f.section) ? ' staged' : ''}${hot ? ' hot' : ''}`
          return (
            <g class={cls}>
              <path class="line" d={d} marker-end={`url(#fw-arrow-${hot ? 'hot' : f.enabled ? 'on' : 'off'})`} />
              <path class="hit" d={d} tabindex={0} role="button"
                aria-label={f.enabled ? `${f.src} to ${f.dest} allowed: block` : `${f.src} to ${f.dest} disabled: enable`}
                onMouseEnter={() => setHover(f.section)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(f.section)} onBlur={() => setHover(null)}
                onClick={() => run(f.enabled ? block(f) : allow(f.src, f.dest, f))}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && run(f.enabled ? block(f) : allow(f.src, f.dest, f))} />
            </g>
          )
        })}
        {dragFrom && drag?.moved && (
          <path class="drag-line" d={`M${dragFrom.x + NW / 2} ${dragFrom.y + NH / 2}L${drag.x} ${drag.y}`} marker-end="url(#fw-arrow-on)" />
        )}
        {[...boxes.values()].map((b) => (
          <g class={`zone-node${drag?.over === b.z.name && drag.from !== b.z.name && drag.moved ? ' target' : ''}${drag?.from === b.z.name ? ' source' : ''}${staged.has(b.z.section) ? ' staged' : ''}`}
            transform={`translate(${b.x},${b.y})`} onPointerDown={down(b.z.name)}>
            <title>{`${b.z.name}: drag onto another zone to allow forwarding, click to edit`}</title>
            <rect class="body" width={NW} height={NH} rx={6} />
            <rect width={4} height={NH - 12} x={0} y={6} rx={2} style={{ fill: `var(--series-${b.z.slot})` }} />
            <Icon name={zoneIcon(b.z, net)} size={14} x={12} y={9} class="ico" />
            <text class="name" x={32} y={21}>{b.z.name}</text>
            {b.z.masq && <g transform={`translate(${NW - 40},8)`}><rect class="tag" width={32} height={16} rx={8} /><text class="tag-t" x={16} y={12} text-anchor="middle">NAT</text></g>}
            <text class="nets" x={12} y={39}>{truncate(b.z.networks.join(', ') || 'no networks', 24)}</text>
          </g>
        ))}
      </svg>
      {hovered && !drag && (
        <div class="map-label" style={{ left: px(hovered.mid.x), top: px(hovered.mid.y) }}>
          {hovered.f.enabled ? <>{hovered.f.src} → {hovered.f.dest} allowed · <b>click to block</b></> : <>{hovered.f.src} → {hovered.f.dest} disabled · <b>click to enable</b></>}
        </div>
      )}
      {dragLabel && <div class="map-label drag" style={{ left: px(drag!.x), top: px(drag!.y - 8) }}>{dragLabel}</div>}
    </div>
  )
}

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

function edgeGeom(a: Box, b: Box, reverse: boolean) {
  const cy = (bx: Box) => bx.y + NH / 2
  if (a.col !== b.col) {
    const ltr = a.x < b.x
    const x1 = ltr ? a.x + NW : a.x, x2 = ltr ? b.x - 2 : b.x + NW + 2
    const off = reverse ? (ltr ? -7 : 7) : 0
    const y1 = cy(a) + off, y2 = cy(b) + off
    const dx = (x2 - x1) / 2
    const p = [x1, y1, x1 + dx, y1, x2 - dx, y2, x2, y2]
    return { d: `M${p[0]} ${p[1]}C${p[2]} ${p[3]} ${p[4]} ${p[5]} ${p[6]} ${p[7]}`, mid: cubicMid(p) }
  }
  // same column: an arc on the outer side; the reverse direction bulges further out
  const sign = a.col === 'int' ? -1 : 1
  const ex = a.col === 'int' ? a.x - 2 : a.x + NW + 2
  const sx = a.col === 'int' ? a.x : a.x + NW
  const down = a.y < b.y
  const rowsApart = Math.abs(b.y - a.y) / (NH + GAP)
  const bulge = Math.min(28 + 16 * rowsApart + (reverse && !down ? 22 : 0), Math.max(a.x - 6, 40))
  const y1 = cy(a) + (down ? 6 : -6), y2 = cy(b) + (down ? -6 : 6)
  const cx = sx + sign * bulge
  const p = [sx, y1, cx, y1, cx, y2, ex, y2]
  return { d: `M${p[0]} ${p[1]}C${p[2]} ${p[3]} ${p[4]} ${p[5]} ${p[6]} ${p[7]}`, mid: cubicMid(p) }
}

const cubicMid = (p: number[]) => ({ x: (p[0] + 3 * p[2] + 3 * p[4] + p[6]) / 8, y: (p[1] + 3 * p[3] + 3 * p[5] + p[7]) / 8 })

// ---- matrix ---------------------------------------------------------------------------------
function ZoneMatrix({ fwd }: { fwd: Forwarding[] }) {
  const { zones, fw, staged } = useFw()
  const [error, setError] = useState<unknown>()
  const defFwd = str(ofType(fw, 'defaults')[0]?.forward) || 'REJECT'
  const rules = ofType(fw, 'rule')
  if (!zones.length) return <div class="empty">No zones</div>
  return (
    <div class="fw-matrix-wrap">
      {error ? <ErrorBox error={error} /> : null}
      <table class="fw-matrix">
        <thead>
          <tr>
            <th class="corner"><span>from</span> ↓ <span>to</span> →</th>
            {zones.map((z) => <th><ZonePill name={z.name} /></th>)}
          </tr>
        </thead>
        <tbody>
          {zones.map((src) => (
            <tr>
              <th><ZonePill name={src.name} /></th>
              {zones.map((dst) => {
                if (src === dst) {
                  return (
                    <td class="diag">
                      <Tip text={`Between networks inside ${src.name}: ${src.forward} (the zone's own forward policy, set in the table below).`}>
                        <span class="within">{src.forward.toLowerCase()}</span>
                      </Tip>
                    </td>
                  )
                }
                const f = fwd.find((x) => x.src === src.name && x.dest === dst.name)
                const on = !!f?.enabled
                const n = rules.filter((r) => str(r.src) === src.name && str(r.dest) === dst.name && r.enabled !== '0').length
                const label = on
                  ? `${src.name} → ${dst.name}: allowed. Click to block.`
                  : `${src.name} → ${dst.name}: no forwarding, so the default policy applies (${defFwd}). Click to allow.`
                return (
                  <td>
                    <button type="button" class={`cell ${on ? 'allow' : 'block'}${f && staged.has(f.section) ? ' staged' : ''}`} title={label} aria-label={label}
                      onClick={() => (on ? block(f!) : allow(src.name, dst.name, f)).then(() => setError(undefined), setError)}>
                      {on ? <><Icon name="check" size={13} /> allow</> : defFwd === 'ACCEPT' ? 'default' : '–'}
                    </button>
                    {n > 0 && <a class="rc" href="#/firewall/rules" title={`${n} traffic rule${n > 1 ? 's' : ''} also match ${src.name} → ${dst.name} (checked first)`}>{n}</a>}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---- zone table -----------------------------------------------------------------------------
function ZoneTable() {
  const { zones, staged } = useFw()
  const [error, setError] = useState<unknown>()
  const set = (z: Zone, values: Record<string, string>) => uci.set('firewall', z.section, values).then(() => setError(undefined), setError)
  const flag = (z: Zone, opt: string, on: boolean) => (on ? uci.set('firewall', z.section, { [opt]: '1' }) : uci.remove('firewall', z.section, [opt])).then(() => setError(undefined), setError)
  return (
    <>
      {error ? <ErrorBox error={error} /> : null}
      <Table<Zone> rows={zones} rowKey={(z) => z.section} empty="No zones yet" columns={[
        { key: 'name', label: 'Zone', render: (z) => <span class="row"><ZonePill name={z.name} />{staged.has(z.section) && <Unapplied />}</span> },
        { key: 'networks', label: 'Networks', value: (z) => z.networks.join(','), render: (z) => <span class="net-list">{z.networks.length ? z.networks.map((n) => <code>{n}</code>) : <span class="muted">none</span>}</span> },
        { key: 'input', label: 'Input', tip: 'Connections to the router itself', render: (z) => <PolicyPick value={z.input} label={`${z.name} input`} onChange={(v) => set(z, { input: v })} /> },
        { key: 'output', label: 'Output', tip: 'Connections from the router', render: (z) => <PolicyPick value={z.output} label={`${z.name} output`} onChange={(v) => set(z, { output: v })} /> },
        { key: 'forward', label: 'Within', tip: 'Between networks of the same zone (zone to zone: the map)', render: (z) => <PolicyPick value={z.forward} label={`${z.name} within zone`} onChange={(v) => set(z, { forward: v })} /> },
        { key: 'masq', label: 'Masq', tip: "Masquerade: NAT to the zone's address (internet side)", value: (z) => +z.masq, render: (z) => <Toggle on={z.masq} label={`Masquerade ${z.name}`} onChange={(v) => flag(z, 'masq', v)} /> },
        { key: 'edit', label: '', width: '36px', render: (z) => <Button variant="ghost" icon="edit" aria-label={`Edit zone ${z.name}`} title="Edit zone" onClick={() => go('firewall', 'zones', z.section)} /> },
      ]} />
    </>
  )
}

/** Accept / Reject / Drop in a cell: a native select fits the 700 px table (three segmented
 *  controls per row didn't). The word carries the meaning, the colour repeats it. */
function PolicyPick({ value, label, onChange }: { value: Policy; label: string; onChange: (v: Policy) => void }) {
  return (
    <select class={`input policy-pick ${value.toLowerCase()}`} aria-label={label} value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value as Policy)}>
      {POLICY_OPTS.map((o) => <option value={o.value}>{o.label}</option>)}
    </select>
  )
}

// ---- defaults -------------------------------------------------------------------------------
function DefaultsCard() {
  const { fw, staged } = useFw()
  const d = ofType(fw, 'defaults')[0]
  const [error, setError] = useState<unknown>()
  if (!d) return null
  const run = (p: Promise<unknown>) => p.then(() => setError(undefined), setError)
  const set = (k: string, v: string) => run(uci.set('firewall', d['.name'], { [k]: v }))
  const flag = (k: string, on: boolean) => run(on ? uci.set('firewall', d['.name'], { [k]: '1' }) : uci.remove('firewall', d['.name'], [k]))
  return (
    <Card title={<>Global defaults {staged.has(d['.name']) && <Unapplied />}</>}>
      {error ? <ErrorBox error={error} /> : null}
      <div class="fw-defaults">
        <Field label="Input (to router)"><Segmented<Policy> value={(str(d.input) || 'REJECT') as Policy} options={POLICY_OPTS} onChange={(v) => set('input', v)} /></Field>
        <Field label="Output (from router)"><Segmented<Policy> value={(str(d.output) || 'ACCEPT') as Policy} options={POLICY_OPTS} onChange={(v) => set('output', v)} /></Field>
        <Field label="Forward (zone to zone, no forwarding)"><Segmented<Policy> value={(str(d.forward) || 'REJECT') as Policy} options={POLICY_OPTS} onChange={(v) => set('forward', v)} /></Field>
        <label class="row fw-flag"><Toggle on={d.syn_flood === '1' || d.synflood_protect === '1'} label="SYN flood protection" onChange={(v) => flag(d.synflood_protect !== undefined ? 'synflood_protect' : 'syn_flood', v)} /> SYN flood protection</label>
        <label class="row fw-flag"><Toggle on={d.drop_invalid === '1'} label="Drop invalid packets" onChange={(v) => flag('drop_invalid', v)} /> Drop invalid packets</label>
      </div>
    </Card>
  )
}

// ---- zone drawer ----------------------------------------------------------------------------
function ZoneDrawer({ zone, onClose }: { zone?: Zone; onClose: () => void }) {
  const { fw, net, zones } = useFw()
  const [name, setName] = useState(zone?.name ?? '')
  const [networks, setNetworks] = useState<string[]>(zone?.networks ?? [])
  const [input, setInput] = useState<Policy>(zone?.input ?? 'REJECT')
  const [output, setOutput] = useState<Policy>(zone?.output ?? 'ACCEPT')
  const [forward, setForward] = useState<Policy>(zone?.forward ?? 'REJECT')
  const [masq, setMasq] = useState(zone?.masq ?? false)
  const [mtuFix, setMtuFix] = useState(zone?.mtuFix ?? false)
  const [log, setLog] = useState(!!zone && str(fw[zone.section]?.log) !== '' && str(fw[zone.section]?.log) !== '0')
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState(false)

  const ifaces = Object.values(net).filter((s) => s['.type'] === 'interface' && s['.name'] !== 'loopback').map((s) => s['.name'])
  const owner = (n: string) => zones.find((z) => z !== zone && z.networks.includes(n))
  const nameErr = !name ? 'Required' : !/^[A-Za-z0-9_]{1,11}$/.test(name) ? 'Letters, digits and _ only, up to 11' : zones.some((z) => z !== zone && z.name === name) ? 'A zone with this name exists' : undefined
  const refs = zone ? [...ofType(fw, 'rule'), ...ofType(fw, 'redirect')].filter((s) => str(s.src) === zone.name || str(s.dest) === zone.name) : []

  const save = async () => {
    setBusy(true)
    try {
      const values = { name, network: networks, input, output, forward, masq: masq ? '1' : '', mtu_fix: mtuFix ? '1' : '', log: log ? '1' : '' }
      // A network belongs to one zone: move it out of the others
      for (const n of networks) {
        const o = owner(n)
        if (o) await uci.set('firewall', o.section, { network: o.networks.filter((x) => x !== n) })
      }
      if (zone) {
        await setOptions('firewall', zone.section, values, fw[zone.section])
        if (name !== zone.name) {
          // Rename: keep forwardings, rules and port forwards pointing at it
          for (const s of Object.values(fw)) {
            if (!['forwarding', 'rule', 'redirect'].includes(s['.type'])) continue
            const v: Record<string, string> = {}
            if (str(s.src) === zone.name) v.src = name
            if (str(s.dest) === zone.name) v.dest = name
            if (Object.keys(v).length) await uci.set('firewall', s['.name'], v)
          }
        }
      } else {
        const v = Object.fromEntries(Object.entries(values).filter(([, x]) => (Array.isArray(x) ? x.length : x)))
        await uci.add('firewall', 'zone', v)
      }
      onClose()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!zone) return
    setBusy(true)
    try {
      for (const f of forwardings(fw)) if (f.src === zone.name || f.dest === zone.name) await uci.remove('firewall', f.section)
      await uci.remove('firewall', zone.section)
      onClose()
    } catch (e) {
      setError(e)
      setBusy(false)
    }
  }

  return (
    <Drawer title={zone ? `Zone ${zone.name}` : 'New zone'} onClose={onClose} footer={<>
      {zone && <Button variant="danger" icon="trash" disabled={busy} onClick={remove}>Delete zone</Button>}
      <span style={{ flex: 1 }} />
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" icon="check" disabled={busy || !!nameErr} onClick={save}>{zone ? 'Stage changes' : 'Add zone'}</Button>
    </>}>
      <div class="stack fw-form">
        {error ? <ErrorBox error={error} /> : null}
        <Field label="Name" error={name || zone ? nameErr : undefined}>
          <input class={`input${name && nameErr ? ' invalid' : ''}`} value={name} placeholder="guest" onInput={(e) => setName((e.target as HTMLInputElement).value.trim())} />
        </Field>
        <Field label="Networks in this zone" hint="Click to add or remove. A network can only be in one zone; picking one here moves it.">
          <MultiChips value={networks} onChange={setNetworks} label="Networks" options={ifaces.map((n) => {
            const o = owner(n)
            return { value: n, label: n, hint: o && !networks.includes(n) ? `in ${o.name}` : undefined }
          })} />
        </Field>
        <Field label="Input: connections to the router"><Segmented<Policy> value={input} options={POLICY_OPTS} onChange={setInput} /></Field>
        <Field label="Output: connections from the router"><Segmented<Policy> value={output} options={POLICY_OPTS} onChange={setOutput} /></Field>
        <Field label="Within zone: between this zone's networks"><Segmented<Policy> value={forward} options={POLICY_OPTS} onChange={setForward} /></Field>
        <label class="row fw-flag"><Toggle on={masq} label="Masquerade" onChange={setMasq} /> Masquerade (NAT) traffic leaving through this zone</label>
        <label class="row fw-flag"><Toggle on={mtuFix} label="MSS clamping" onChange={setMtuFix} /> Clamp TCP MSS to the path MTU</label>
        <label class="row fw-flag"><Toggle on={log} label="Log blocked traffic" onChange={setLog} /> Log blocked traffic (to the system log, at most 10 a minute)</label>
        {!zone && <p class="muted" style={{ margin: 0 }}>After adding, drag on the zone map to choose which zones it may reach.</p>}
        {zone && refs.length > 0 && (
          <p class="secondary" style={{ margin: 0 }}>
            <Icon name="info" size={13} style={{ verticalAlign: '-2px' }} /> {refs.length} rule{refs.length > 1 ? 's' : ''} / port forward{refs.length > 1 ? 's' : ''} refer to this zone
            {name !== zone.name ? ' and will be renamed with it.' : '; deleting the zone leaves them pointing at nothing.'}
          </p>
        )}
      </div>
    </Drawer>
  )
}
