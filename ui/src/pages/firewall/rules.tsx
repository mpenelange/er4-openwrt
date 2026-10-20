// Traffic rules as sentences ("Allow UDP 51820"), grouped by the path they guard (wan -> this
// router, wan -> lan, ...): fw4 files rules into one chain per source zone and direction, so
// order only matters inside a group. Inline enable toggle, drag (or arrow keys on the handle)
// to reorder within a group -> staged uci.order, click a row for the editor drawer.
import { useEffect, useMemo, useState } from 'preact/hooks'
import { go } from '../../app'
import { uci } from '../../api/uci'
import { WEEKDAYS, isEnabled, ofType, reorder, ruleDirection, ruleParts, ruleText, setEnabled, setOptions, slowPathReasons, str, weekdays } from '../../api/firewall'
import type { UciConfig, UciSection } from '../../api/types'
import { list } from '../../api/ip4'
import { Badge, Button, Card, Drawer, Empty, ErrorBox, Field, Toggle } from '../../components/ui'
import { Icon } from '../../components/icons'
import { Chips, MultiChips, type ChipOption } from '../../components/chips'
import { useKnownDevices } from '../../components/device-picker'
import { DragHandle, useSortable } from '../../components/sortable'
import { Hits, RouterPill, Sentence, SlowPath, Unapplied, ZonePill, isForwardRule, useFw } from './parts'

export function RulesView({ openId }: { openId?: string }) {
  const { fw } = useFw()
  const rules = ofType(fw, 'rule')
  const [q, setQ] = useState('')
  const [error, setError] = useState<unknown>()
  // Keep the dropped order on screen until the staged config comes back
  const [optimistic, setOptimistic] = useState<string[] | null>(null)
  useEffect(() => setOptimistic(null), [fw])
  const ordered = optimistic ? optimistic.map((n) => fw[n]).filter(Boolean) : rules
  const position = new Map(ordered.map((r, i) => [r['.name'], i + 1]))
  const needle = q.trim().toLowerCase()
  const shown = needle ? ordered.filter((r) => `${str(r.name)} ${ruleText(r)} ${str(r.src)} ${str(r.dest)}`.toLowerCase().includes(needle)) : ordered
  // groups in order of their first rule; a drop inside a group puts its rules back in the
  // positions the group held in the full list
  const groups = new Map<string, UciSection[]>()
  for (const r of shown) groups.set(ruleDirection(r), [...(groups.get(ruleDirection(r)) ?? []), r])
  const reorderGroup = (keys: string[]) => {
    const inGroup = new Set(keys)
    const all = ordered.map((r) => r['.name'])
    let i = 0
    const next = all.map((k) => (inGroup.has(k) ? keys[i++] : k))
    setOptimistic(next)
    reorder('firewall', fw, next).then(() => setError(undefined), (e) => { setOptimistic(null); setError(e) })
  }
  const slow = rules.filter((r) => isEnabled(r) && isForwardRule(r) && slowPathReasons(r).length).length
  const editing = openId && openId !== 'new' ? fw[openId] : undefined
  const close = () => go('firewall', 'rules')

  const toggle = (r: UciSection, on: boolean) => setEnabled('firewall', r, on).then(() => setError(undefined), setError)

  return (
    <>
      <Card flush title="Traffic rules" actions={<>
        {slow ? <span class="card-hint" title="These rules need every packet, so their connections can't be offloaded">{slow} on the CPU slow path</span> : null}
        <input class="input rule-filter" placeholder="Filter" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} aria-label="Filter rules" />
        <Button variant="primary" icon="plus" onClick={() => go('firewall', 'rules', 'new')}>Add rule</Button>
      </>}>
        {error ? <div style={{ padding: 'var(--sp-2)' }}><ErrorBox error={error} /></div> : null}
        {!rules.length ? (
          <Empty>
            <div class="stack" style={{ alignItems: 'center' }}>
              <span>No traffic rules. Zone policies and forwardings decide everything.</span>
            </div>
          </Empty>
        ) : !shown.length ? (
          <Empty>No rule matches “{q}”</Empty>
        ) : (
          <div class="rule-groups">
            {[...groups].map(([k, rs]) => <RuleGroup key={k} rules={rs} position={position} frozen={!!needle} onReorder={reorderGroup} onToggle={toggle} />)}
          </div>
        )}
      </Card>
      {(openId === 'new' || editing) && <RuleDrawer rule={editing} onClose={close} />}
    </>
  )
}

/** OpenWrt's stock WAN rules in plain words. needs: what stops working without the rule. */
const STOCK: Record<string, { what: string; needs?: 'dhcpv6' | 'ipv6' }> = {
  'Allow-DHCP-Renew': { what: 'Lets the ISP’s DHCP server answer when the WAN renews its address. Most ISPs work without it.' },
  'Allow-Ping': { what: 'Answers ping from the internet (IPv4). Off, the router stays silent.' },
  'Allow-IGMP': { what: 'IPv4 multicast group messages from the ISP. Only multicast IPTV needs it.' },
  'Allow-DHCPv6': { what: 'Lets the ISP’s DHCPv6 server reply: that’s how the WAN gets its IPv6 address and prefix.', needs: 'dhcpv6' },
  'Allow-MLD': { what: 'IPv6 multicast listener messages. Only multicast IPTV needs it.' },
  'Allow-ICMPv6-Input': { what: 'The ICMPv6 that IPv6 runs on: neighbour discovery, router adverts, “packet too big” and other errors (and ping, if listed).', needs: 'ipv6' },
  'Allow-ICMPv6-Forward': { what: 'ICMPv6 errors to devices on your networks (and ping, if listed). IPv6 needs “packet too big” to find the path MTU.', needs: 'ipv6' },
  'Allow-IPSec-ESP': { what: 'Forwards inbound IPsec (ESP) to devices on the LAN. The router’s own IPsec VPN doesn’t need it.' },
  'Allow-ISAKMP': { what: 'Forwards inbound IKE (UDP 500) to devices on the LAN. The router’s own IPsec VPN doesn’t need it.' },
  'Allow-Tailscale': { what: 'Direct Tailscale connections from the internet (UDP 41641). Without it Tailscale goes through its relays, which is slower.' },
}

/** Is IPv6 coming in on the WAN: DHCPv6 (or PPPoE's), or a 6in4 tunnel? */
function ipv6Wan(net: UciConfig) {
  const ifs = Object.values(net).filter((s) => s['.type'] === 'interface' && s.disabled !== '1')
  const dhcpv6 = ifs.some((s) => s.proto === 'dhcpv6' || (s.proto === 'pppoe' && s.ipv6 !== '0'))
  return { dhcpv6, ipv6: dhcpv6 || ifs.some((s) => s.proto === '6in4') }
}

function RuleGroup({ rules, position, frozen, onReorder, onToggle }: {
  rules: UciSection[]; position: Map<string, number>; frozen: boolean
  onReorder: (keys: string[]) => void; onToggle: (r: UciSection, on: boolean) => void
}) {
  const { staged, net } = useFw()
  const v6 = ipv6Wan(net)
  const sort = useSortable(rules, (r) => r['.name'], onReorder, frozen)
  const src = str(rules[0].src), dest = str(rules[0].dest)
  const end = (z: string) => (z === '*' ? <span class="zone-pill any">any zone</span> : z ? <ZonePill name={z} /> : <RouterPill />)
  return (
    <section class="rule-group">
      <h4 class="rule-group-head">
        {end(src)}<Icon name="arrowRight" size={13} />{!src && !dest ? <span class="zone-pill any">anywhere</span> : end(dest)}
        <span class="muted">{rules.length} rule{rules.length > 1 ? 's' : ''}</span>
      </h4>
      <div class="rule-list" ref={sort.listRef} role="list">
        {sort.items.map((r) => {
          const ip = sort.itemProps(r)
          const on = isEnabled(r)
          const fam = str(r.family)
          const stock = STOCK[str(r.name)]
          // a rule IPv6 needs, turned off while the WAN has IPv6
          const breaks = !on && stock?.needs && v6[stock.needs]
          return (
            <div {...ip} role="listitem" class={`${ip.class} rule-row trule${on ? '' : ' off'}`}
              onClick={(e) => !(e.target as HTMLElement).closest('button, a, input, .tip-anchor') && go('firewall', 'rules', r['.name'])}>
              <DragHandle {...sort.handleProps(r)} />
              <span class="idx num">{position.get(r['.name'])}</span>
              <Toggle on={on} label={`${on ? 'Disable' : 'Enable'} ${str(r.name) || 'rule'}`} onChange={(v) => onToggle(r, v)} />
              <span class="rule-what">
                <Sentence parts={ruleParts(r, { direction: false })} />
                {(fam === 'ipv4' || fam === 'ipv6') && <span class="fam">{fam === 'ipv4' ? 'IPv4' : 'IPv6'}</span>}
                {!on && <Badge>off</Badge>}
                <SlowPath s={r} />
                {staged.has(r['.name']) && <Unapplied />}
                {breaks && <Badge status="critical">IPv6 needs this</Badge>}
                {stock && <span class="rule-note">{stock.what}</span>}
              </span>
              <span class="rule-name" title={str(r.name)}>{str(r.name)}</span>
              <span class="hits-cell"><Hits s={r} /></span>
              <Button variant="ghost" icon="edit" aria-label={`Edit ${str(r.name) || 'rule'}`} title="Edit" onClick={() => go('firewall', 'rules', r['.name'])} />
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ---- editor -----------------------------------------------------------------------------------
const FIELDS = ['name', 'target', 'src', 'dest', 'proto', 'dest_port', 'icmp_type', 'src_ip', 'src_mac', 'dest_ip', 'src_port', 'family', 'limit', 'log', 'enabled',
  'weekdays', 'start_time', 'stop_time', 'start_date', 'stop_date'] as const
type Draft = Record<(typeof FIELDS)[number], string>

const PROTOS: ChipOption<string>[] = [
  { value: 'tcp udp', label: 'TCP + UDP' }, { value: 'tcp', label: 'TCP' }, { value: 'udp', label: 'UDP' },
  { value: 'icmp', label: 'ICMP / ping' }, { value: 'all', label: 'Any protocol' },
]

const portOk = (s: string) => list(s).every((p) => {
  const m = /^(\d{1,5})(?:[-:](\d{1,5}))?$/.exec(p)
  return !!m && +m[1] >= 1 && +m[1] <= 65535 && (!m[2] || (+m[2] >= +m[1] && +m[2] <= 65535))
})
const addrOk = (s: string) => list(s).every((a) => /^!?[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(a))
const limitOk = (s: string) => !s || /^\d+\/(s|sec|second|m|min|minute|h|hour|d|day)$/.test(s)
const macOk = (s: string) => list(s).every((m) => /^!?([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(m))
const timeOk = (s: string) => !s || /^([01]?\d|2[0-3]):[0-5]\d$/.test(s)
const dateOk = (s: string) => !s || /^(19[7-9]\d|20[0-3]\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(s)

function RuleDrawer({ rule, onClose }: { rule?: UciSection; onClose: () => void }) {
  const { zones } = useFw()
  const devices = (useKnownDevices().data ?? []).filter((x) => x.mac)
  const init = (): Draft => {
    const d = Object.fromEntries(FIELDS.map((k) => [k, rule ? (Array.isArray(rule[k]) ? (rule[k] as string[]).join(' ') : str(rule[k])) : ''])) as Draft
    if (!rule) Object.assign(d, { target: 'ACCEPT', src: zones.find((z) => z.name === 'wan') ? 'wan' : zones[0]?.name ?? '', proto: 'tcp' })
    if (!d.target) d.target = 'ACCEPT'
    if (!d.proto) d.proto = 'tcp udp'
    return d
  }
  const [d, setD] = useState<Draft>(init)
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const up = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }))
  const inp = (k: keyof Draft) => (e: Event) => up({ [k]: (e.target as HTMLInputElement).value })

  const isIcmp = /icmp/.test(d.proto)
  const isAll = d.proto === 'all' || d.proto === 'any'
  const preview = useMemo<UciSection>(() => {
    const s: UciSection = { '.anonymous': true, '.type': 'rule', '.name': 'preview' }
    for (const [k, v] of Object.entries(d)) if (v && !(k === 'dest_port' && (isIcmp || isAll)) && !(k === 'icmp_type' && !isIcmp)) s[k] = v
    if (s.log === '0') delete s.log
    return s
  }, [d])

  const errs = {
    dest_port: d.dest_port && !portOk(d.dest_port) ? 'Ports 1-65535: "443", "53 67", "1000-2000"' : undefined,
    src_port: d.src_port && !portOk(d.src_port) ? 'Ports 1-65535' : undefined,
    src_ip: d.src_ip && !addrOk(d.src_ip) ? 'Addresses or subnets, e.g. 203.0.113.0/24' : undefined,
    dest_ip: d.dest_ip && !addrOk(d.dest_ip) ? 'Addresses or subnets, e.g. 192.168.1.20' : undefined,
    limit: !limitOk(d.limit) ? 'e.g. 10/second, 6/minute' : undefined,
    src_mac: d.src_mac && !macOk(d.src_mac) ? 'MAC addresses like 02:00:00:0a:11:7e' : undefined,
    start_time: !timeOk(d.start_time) ? '24 h time, e.g. 22:00' : undefined,
    stop_time: !timeOk(d.stop_time) ? '24 h time, e.g. 07:00' : undefined,
    start_date: !dateOk(d.start_date) ? 'YYYY-MM-DD' : undefined,
    stop_date: !dateOk(d.stop_date) ? 'YYYY-MM-DD' : undefined,
  }
  const days = weekdays(d.weekdays)
  const macs = list(d.src_mac)
  const invalid = Object.values(errs).some(Boolean)
  const wideOpen = d.target === 'ACCEPT' && zones.find((z) => z.name === d.src)?.masq && !d.dest_port && !isIcmp && !d.src_ip

  const zoneChips = (self: 'src' | 'dest'): ChipOption<string>[] => [
    { value: '', label: 'this router', icon: 'chip', title: self === 'src' ? 'Traffic the router itself sends' : 'Traffic to the router itself' },
    ...zones.map((z) => ({ value: z.name, label: z.name, slot: z.slot })),
    { value: '*', label: 'any zone' },
  ]

  const save = async () => {
    setBusy(true)
    try {
      const v: Record<string, string | undefined> = { ...d }
      if (isIcmp || isAll) v.dest_port = undefined
      if (!isIcmp) v.icmp_type = undefined
      if (v.proto === 'tcp udp') v.proto = undefined // fw4 default
      if (v.log === '0') v.log = undefined
      if (v.enabled === '1') v.enabled = undefined
      if (days.length === 7) v.weekdays = undefined
      if (!v.name) v.name = autoName(preview)
      if (rule) await setOptions('firewall', rule['.name'], v, rule)
      else await uci.add('firewall', 'rule', Object.fromEntries(Object.entries(v).filter(([, x]) => x)) as Record<string, string>)
      onClose()
    } catch (e) {
      setError(e)
      setBusy(false)
    }
  }
  const remove = async () => {
    try { await uci.remove('firewall', rule!['.name']); onClose() } catch (e) { setError(e) }
  }

  const protoOpts = PROTOS.some((p) => p.value === d.proto) ? PROTOS : [...PROTOS, { value: d.proto, label: d.proto.toUpperCase() }]
  const slow = slowPathReasons(preview)

  return (
    <Drawer title={rule ? `Rule ${str(rule.name) || ''}` : 'New traffic rule'} onClose={onClose} footer={<>
      {rule && <Button variant="danger" icon="trash" onClick={remove}>Delete</Button>}
      <span style={{ flex: 1 }} />
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" icon="check" disabled={busy || invalid} onClick={save}>{rule ? 'Stage changes' : 'Add rule'}</Button>
    </>}>
      <div class="stack fw-form">
        <div class="preview-box" aria-live="polite">
          <span class="label">Preview</span>
          <div class="row" style={{ flexWrap: 'wrap' }}><Sentence parts={ruleParts(preview)} /> <SlowPath s={preview} /></div>
          {wideOpen && <div class="warn-line"><Icon name="warning" size={13} /> Opens every {isAll ? '' : d.proto.toUpperCase().replace(' ', '/') + ' '}port from {d.src} to {d.dest || 'the router'}. Add a port or a source address.</div>}
        </div>
        {error ? <ErrorBox error={error} /> : null}
        <Field label="Action">
          <Chips value={d.target} onChange={(v) => up({ target: v })} label="Action" options={[
            { value: 'ACCEPT', label: 'Allow' }, { value: 'REJECT', label: 'Reject', hint: 'tell sender' }, { value: 'DROP', label: 'Drop', hint: 'silently' },
          ]} />
        </Field>
        <Field label="Protocol"><Chips value={d.proto} onChange={(v) => up({ proto: v })} label="Protocol" options={protoOpts} /></Field>
        {!isIcmp && !isAll && (
          <Field label="Port(s)" hint="Destination port; several separated by spaces, ranges with a dash. Empty = every port." error={errs.dest_port}>
            <input class={`input mono${errs.dest_port ? ' invalid' : ''}`} value={d.dest_port} placeholder="443" onInput={inp('dest_port')} />
          </Field>
        )}
        {isIcmp && (
          <Field label="ICMP type">
            <Chips value={d.icmp_type} onChange={(v) => up({ icmp_type: v })} label="ICMP type" options={[
              { value: 'echo-request', label: 'ping' }, { value: '', label: 'all ICMP' },
              ...(d.icmp_type && d.icmp_type !== 'echo-request' ? [{ value: d.icmp_type, label: d.icmp_type }] : []),
            ]} />
          </Field>
        )}
        <Field label="From"><Chips value={d.src} onChange={(v) => up({ src: v })} label="From zone" options={zoneChips('src')} /></Field>
        <Field label="Only from addresses" hint="Optional: IPs or subnets" error={errs.src_ip}>
          <input class={`input mono${errs.src_ip ? ' invalid' : ''}`} value={d.src_ip} placeholder="any" onInput={inp('src_ip')} />
        </Field>
        <Field label="Only from devices" hint="Optional: MAC addresses, so a rule follows a device whatever its IP" error={errs.src_mac}>
          <div class="stack">
            <input class={`input mono${errs.src_mac ? ' invalid' : ''}`} value={d.src_mac} placeholder="any" onInput={inp('src_mac')} aria-label="Source MAC addresses" />
            {devices.length > 0 && (
              <select class="input" aria-label="Add a device" value="" onChange={(e) => {
                const m = (e.target as HTMLSelectElement).value
                if (m && !macs.includes(m)) up({ src_mac: [...macs, m].join(' ') })
              }}>
                <option value="">Add a known device…</option>
                {devices.map((x) => <option value={x.mac} disabled={macs.includes(x.mac!)}>{x.name ?? x.ip} · {x.mac}</option>)}
              </select>
            )}
          </div>
        </Field>
        <Field label="To"><Chips value={d.dest} onChange={(v) => up({ dest: v })} label="To zone" options={zoneChips('dest')} /></Field>
        <Field label="Only to addresses" hint="Optional: IPs or subnets" error={errs.dest_ip}>
          <input class={`input mono${errs.dest_ip ? ' invalid' : ''}`} value={d.dest_ip} placeholder="any" onInput={inp('dest_ip')} />
        </Field>
        <Field label="Name" hint="Shown next to the sentence; generated if empty">
          <input class="input" value={d.name} placeholder={autoName(preview)} onInput={inp('name')} />
        </Field>
        <label class="row fw-flag"><Toggle on={d.enabled !== '0'} label="Enabled" onChange={(v) => up({ enabled: v ? '' : '0' })} /> Enabled</label>
        <details class="disclosure" open={!!(d.weekdays || d.start_time || d.stop_time || d.start_date || d.stop_date)}>
          <summary><Icon name="chevronRight" size={14} /> Schedule</summary>
          <div class="stack">
            <Field label="Days" hint="None picked = every day">
              <MultiChips value={days} onChange={(v) => up({ weekdays: WEEKDAYS.filter((w) => v.includes(w)).join(' ') })} label="Days"
                options={WEEKDAYS.map((w) => ({ value: w, label: w }))} />
            </Field>
            <div class="row" style={{ gap: 'var(--sp-3)', flexWrap: 'wrap' }}>
              <Field label="Starts at" error={errs.start_time}>
                <input class={`input mono${errs.start_time ? ' invalid' : ''}`} style={{ width: 90 }} value={d.start_time} placeholder="00:00" onInput={inp('start_time')} aria-label="Start time" />
              </Field>
              <Field label="Ends at" hint={d.start_time && d.stop_time && d.stop_time < d.start_time ? 'Ends the next morning' : undefined} error={errs.stop_time}>
                <input class={`input mono${errs.stop_time ? ' invalid' : ''}`} style={{ width: 90 }} value={d.stop_time} placeholder="23:59" onInput={inp('stop_time')} aria-label="Stop time" />
              </Field>
              <Field label="First day" error={errs.start_date}>
                <input class={`input mono${errs.start_date ? ' invalid' : ''}`} style={{ width: 130 }} value={d.start_date} placeholder="YYYY-MM-DD" onInput={inp('start_date')} aria-label="Start date" />
              </Field>
              <Field label="Last day" error={errs.stop_date}>
                <input class={`input mono${errs.stop_date ? ' invalid' : ''}`} style={{ width: 130 }} value={d.stop_date} placeholder="YYYY-MM-DD" onInput={inp('stop_date')} aria-label="Stop date" />
              </Field>
            </div>
            {(days.length > 0 || d.start_time || d.stop_time) && d.target !== 'ACCEPT' && (
              <div class="warn-line"><Icon name="info" size={13} /> Router time. Connections already open when the block starts keep running until they close.</div>
            )}
          </div>
        </details>
        <details class="disclosure" open={!!(d.src_port || d.family || d.limit || (d.log && d.log !== '0'))}>
          <summary><Icon name="chevronRight" size={14} /> Advanced</summary>
          <div class="stack">
            <Field label="IP version"><Chips value={d.family} onChange={(v) => up({ family: v })} label="IP version" options={[{ value: '', label: 'IPv4 + IPv6' }, { value: 'ipv4', label: 'IPv4 only' }, { value: 'ipv6', label: 'IPv6 only' }]} /></Field>
            <Field label="Source port(s)" error={errs.src_port}>
              <input class={`input mono${errs.src_port ? ' invalid' : ''}`} value={d.src_port} placeholder="any" onInput={inp('src_port')} />
            </Field>
            <Field label="Rate limit" hint="Matching traffic above this is not matched by the rule" error={errs.limit}>
              <input class={`input mono${errs.limit ? ' invalid' : ''}`} value={d.limit} placeholder="none, e.g. 10/second" onInput={inp('limit')} />
            </Field>
            <label class="row fw-flag"><Toggle on={!!d.log && d.log !== '0'} label="Log matches" onChange={(v) => up({ log: v ? '1' : '' })} /> Log matching packets</label>
            {slow.length > 0 && (
              <div class="warn-line"><Icon name="warning" size={13} /> {slow.join(' and ')} keeps matching traffic off the hardware offload (CPU slow path).</div>
            )}
          </div>
        </details>
      </div>
    </Drawer>
  )
}

function autoName(s: UciSection) {
  const verb = { ACCEPT: 'Allow', REJECT: 'Reject', DROP: 'Drop' }[str(s.target)] ?? str(s.target)
  const proto = list(s.proto).join('-') || 'tcp-udp'
  const ports = list(s.dest_port).join('-')
  return [verb, str(s.src) || 'router', 'to', str(s.dest) || 'router', proto === 'all' ? '' : proto, ports].filter(Boolean).join('-').replace(/\*/g, 'any')
}
