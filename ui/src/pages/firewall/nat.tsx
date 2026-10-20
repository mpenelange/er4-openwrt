// Source NAT rules (UCI firewall 'nat'), one sentence each, checked top to bottom:
//   Masquerade traffic from 10.200.0.0/24 leaving through WAN
//   Rewrite source of traffic from 192.168.1.20 leaving through WAN as 203.0.113.9
//   Don't NAT traffic from anywhere to 10.8.0.0/16 leaving through vpn
// Zone masquerading (the zone's own switch) covers the usual case; these are the exceptions.
import { useEffect, useState } from 'preact/hooks'
import { go } from '../../app'
import { uci } from '../../api/uci'
import { isEnabled, natParts, natTarget, ofType, reorder, setEnabled, setOptions, str } from '../../api/firewall'
import type { UciSection } from '../../api/types'
import { ip4, list } from '../../api/ip4'
import { Badge, Button, Card, Drawer, Empty, ErrorBox, Field, Toggle } from '../../components/ui'
import { Icon } from '../../components/icons'
import { Chips, type ChipOption } from '../../components/chips'
import { DragHandle, useSortable } from '../../components/sortable'
import { Hits, Sentence, Unapplied, useFw } from './parts'

export function NatView({ openId }: { openId?: string }) {
  const { fw, staged } = useFw()
  const rules = ofType(fw, 'nat')
  const [error, setError] = useState<unknown>()
  const [optimistic, setOptimistic] = useState<string[] | null>(null)
  useEffect(() => setOptimistic(null), [fw])
  const ordered = optimistic ? optimistic.map((n) => fw[n]).filter(Boolean) : rules
  const sort = useSortable(ordered, (r) => r['.name'], (keys) => {
    setOptimistic(keys)
    reorder('firewall', fw, keys).then(() => setError(undefined), (e) => { setOptimistic(null); setError(e) })
  }, false)
  const editing = openId && openId !== 'new' ? fw[openId] : undefined
  const close = () => go('firewall', 'nat')
  const label = (r: UciSection) => str(r.name) || 'NAT rule'

  return (
    <>
      <Card flush title="Source NAT rules" actions={<Button variant="primary" icon="plus" onClick={() => go('firewall', 'nat', 'new')}>Add NAT rule</Button>}>
        {error ? <div style={{ padding: 'var(--sp-2)' }}><ErrorBox error={error} /></div> : null}
        {!rules.length ? (
          <Empty>
            <div class="stack" style={{ alignItems: 'center' }}>
              <span>No NAT rules. Zones with Masquerade on cover the usual case.</span>
            </div>
          </Empty>
        ) : (
          <div class="rule-list" ref={sort.listRef} role="list">
            {sort.items.map((r, i) => {
              const ip = sort.itemProps(r)
              const on = isEnabled(r)
              return (
                <div {...ip} role="listitem" class={`${ip.class} rule-row${on ? '' : ' off'}`}
                  onClick={(e) => !(e.target as HTMLElement).closest('button, a, input, .tip-anchor') && go('firewall', 'nat', r['.name'])}>
                  <DragHandle {...sort.handleProps(r)} />
                  <span class="idx num">{i + 1}</span>
                  <Toggle on={on} label={`${on ? 'Disable' : 'Enable'} ${label(r)}`}
                    onChange={(v) => setEnabled('firewall', r, v).then(() => setError(undefined), setError)} />
                  <Sentence parts={natParts(r)} />
                  <span class="rule-meta">
                    <span class="rule-name">{str(r.name)}</span>
                    {!on && <Badge>off</Badge>}
                    <Hits s={r} />
                    {staged.has(r['.name']) && <Unapplied />}
                  </span>
                  <Button variant="ghost" icon="edit" aria-label={`Edit ${label(r)}`} title="Edit" onClick={() => go('firewall', 'nat', r['.name'])} />
                </div>
              )
            })}
          </div>
        )}
      </Card>
      {(openId === 'new' || editing) && <NatDrawer rule={editing} onClose={close} />}
    </>
  )
}

const FIELDS = ['name', 'target', 'src', 'proto', 'src_ip', 'dest_ip', 'dest_port', 'snat_ip', 'snat_port', 'enabled'] as const
type Draft = Record<(typeof FIELDS)[number], string>

const addrOk = (s: string) => list(s).every((a) => /^!?[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(a))
const portOk = (s: string) => list(s).every((p) => {
  const m = /^(\d{1,5})(?:[-:](\d{1,5}))?$/.exec(p)
  return !!m && +m[1] >= 1 && +m[1] <= 65535 && (!m[2] || (+m[2] >= +m[1] && +m[2] <= 65535))
})

function NatDrawer({ rule, onClose }: { rule?: UciSection; onClose: () => void }) {
  const { zones } = useFw()
  const [d, setD] = useState<Draft>(() => {
    const x = Object.fromEntries(FIELDS.map((k) => [k, rule ? (Array.isArray(rule[k]) ? (rule[k] as string[]).join(' ') : str(rule[k])) : ''])) as Draft
    x.target = rule ? natTarget(rule) : 'MASQUERADE'
    if (!rule) x.src = zones.find((z) => z.name === 'wan')?.name ?? zones[0]?.name ?? ''
    if (!x.proto) x.proto = 'all'
    return x
  })
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const up = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }))
  const inp = (k: keyof Draft) => (e: Event) => up({ [k]: (e.target as HTMLInputElement).value })
  const ports = d.proto === 'tcp' || d.proto === 'udp' || d.proto === 'tcp udp'
  const snat = d.target === 'SNAT'
  const preview: UciSection = { '.anonymous': true, '.type': 'nat', '.name': 'preview', ...Object.fromEntries(Object.entries(d).filter(([, v]) => v)) }

  const errs = {
    src_ip: d.src_ip && !addrOk(d.src_ip) ? 'Addresses or subnets, e.g. 10.200.0.0/24' : undefined,
    dest_ip: d.dest_ip && !addrOk(d.dest_ip) ? 'Addresses or subnets' : undefined,
    dest_port: ports && d.dest_port && !portOk(d.dest_port) ? 'Ports 1-65535' : undefined,
    snat_ip: snat && !d.snat_ip && !d.snat_port ? 'An address, a port, or both' : snat && d.snat_ip && ip4(d.snat_ip) === undefined && !/:/.test(d.snat_ip) ? 'One address, e.g. 203.0.113.9' : undefined,
    snat_port: snat && ports && d.snat_port && !portOk(d.snat_port) ? 'A port or range' : undefined,
    src: !d.src ? 'Pick the zone the traffic leaves through' : undefined,
  }
  const invalid = Object.values(errs).some(Boolean)

  const save = async () => {
    setBusy(true)
    try {
      const v: Record<string, string | undefined> = { ...d }
      if (v.proto === 'all') v.proto = undefined
      if (!ports) { v.dest_port = undefined; v.snat_port = undefined }
      if (!snat) { v.snat_ip = undefined; v.snat_port = undefined }
      if (v.enabled === '1') v.enabled = undefined
      if (!v.name) v.name = `${{ MASQUERADE: 'Masquerade', SNAT: 'SNAT', ACCEPT: 'No-NAT' }[d.target]}-${(list(d.src_ip)[0] ?? 'any').replace(/[/.:]/g, '-')}-${d.src}`
      if (rule) await setOptions('firewall', rule['.name'], v, rule)
      else await uci.add('firewall', 'nat', Object.fromEntries(Object.entries(v).filter(([, x]) => x)) as Record<string, string>)
      onClose()
    } catch (e) {
      setError(e)
      setBusy(false)
    }
  }
  const remove = async () => {
    try { await uci.remove('firewall', rule!['.name']); onClose() } catch (e) { setError(e) }
  }

  const zoneChips: ChipOption<string>[] = zones.map((z) => ({ value: z.name, label: z.name, slot: z.slot }))
  return (
    <Drawer title={rule ? `NAT rule ${str(rule.name)}` : 'New NAT rule'} onClose={onClose} footer={<>
      {rule && <Button variant="danger" icon="trash" onClick={remove}>Delete</Button>}
      <span style={{ flex: 1 }} />
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" icon="check" disabled={busy || invalid} onClick={save}>{rule ? 'Stage changes' : 'Add NAT rule'}</Button>
    </>}>
      <div class="stack fw-form">
        <div class="preview-box" aria-live="polite">
          <span class="label">Preview</span>
          <div class="row" style={{ flexWrap: 'wrap' }}><Sentence parts={natParts(preview)} /></div>
        </div>
        {error ? <ErrorBox error={error} /> : null}
        <Field label="Action">
          <Chips value={d.target} onChange={(v) => up({ target: v })} label="Action" options={[
            { value: 'MASQUERADE', label: 'Masquerade', hint: "port's address" },
            { value: 'SNAT', label: 'Rewrite source', hint: 'fixed address' },
            { value: 'ACCEPT', label: "Don't NAT" },
          ]} />
        </Field>
        <Field label="Leaving through" error={errs.src}><Chips value={d.src} onChange={(v) => up({ src: v })} label="Outbound zone" options={zoneChips} /></Field>
        <Field label="From addresses" hint="Empty = anywhere" error={errs.src_ip}>
          <input class={`input mono${errs.src_ip ? ' invalid' : ''}`} value={d.src_ip} placeholder="anywhere" onInput={inp('src_ip')} />
        </Field>
        <Field label="To addresses" hint="Empty = anywhere" error={errs.dest_ip}>
          <input class={`input mono${errs.dest_ip ? ' invalid' : ''}`} value={d.dest_ip} placeholder="anywhere" onInput={inp('dest_ip')} />
        </Field>
        {snat && (
          <div class="row" style={{ gap: 'var(--sp-3)', alignItems: 'flex-start' }}>
            <Field label="New source address" error={errs.snat_ip}>
              <input class={`input mono${errs.snat_ip ? ' invalid' : ''}`} value={d.snat_ip} placeholder="203.0.113.9" onInput={inp('snat_ip')} />
            </Field>
            {ports && (
              <Field label="New source port" error={errs.snat_port}>
                <input class={`input mono${errs.snat_port ? ' invalid' : ''}`} style={{ width: 120 }} value={d.snat_port} placeholder="unchanged" onInput={inp('snat_port')} />
              </Field>
            )}
          </div>
        )}
        <Field label="Protocol">
          <Chips value={d.proto} onChange={(v) => up({ proto: v })} label="Protocol" options={[
            { value: 'all', label: 'Any' }, { value: 'tcp udp', label: 'TCP + UDP' }, { value: 'tcp', label: 'TCP' }, { value: 'udp', label: 'UDP' },
          ]} />
        </Field>
        {ports && (
          <Field label="Destination port(s)" hint="Empty = every port" error={errs.dest_port}>
            <input class={`input mono${errs.dest_port ? ' invalid' : ''}`} value={d.dest_port} placeholder="any" onInput={inp('dest_port')} />
          </Field>
        )}
        <Field label="Name" hint="Generated if empty"><input class="input" value={d.name} onInput={inp('name')} /></Field>
        <label class="row fw-flag"><Toggle on={d.enabled !== '0'} label="Enabled" onChange={(v) => up({ enabled: v ? '' : '0' })} /> Enabled</label>
        {d.target === 'MASQUERADE' && zones.find((z) => z.name === d.src)?.masq && !d.src_ip && !d.dest_ip && (
          <div class="warn-line"><Icon name="info" size={13} /> Zone {d.src} already masquerades everything; this rule adds nothing without addresses.</div>
        )}
      </div>
    </Drawer>
  )
}
