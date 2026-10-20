// Port forwards (UCI firewall 'redirect', target DNAT), one line each:
//   WAN :443 → nas 192.168.1.20:443 (TCP)
// Inline enable toggle; editor drawer with service presets and a device picker (DHCP leases +
// static hosts). The destination zone follows the device's subnet automatically.
import { useMemo, useState } from 'preact/hooks'
import { go } from '../../app'
import { uci } from '../../api/uci'
import { isEnabled, ofType, protoLabel, setEnabled, setOptions, str, type Zone } from '../../api/firewall'
import type { UciConfig, UciSection } from '../../api/types'
import { interfaceSubnets, inSubnet, ip4, list } from '../../api/ip4'
import { Badge, Button, Card, Drawer, Empty, ErrorBox, Field, Toggle } from '../../components/ui'
import { Icon } from '../../components/icons'
import { Chips } from '../../components/chips'
import { Tip } from '../../components/tooltip'
import { DevicePicker, useKnownDevices, type KnownDevice } from '../../components/device-picker'
import { Hits, Unapplied, ZonePill, useFw } from './parts'

const PRESETS: { label: string; port: string; proto: string; name: string }[] = [
  { label: 'HTTPS', port: '443', proto: 'tcp', name: 'HTTPS' },
  { label: 'HTTP', port: '80', proto: 'tcp', name: 'HTTP' },
  { label: 'SSH', port: '22', proto: 'tcp', name: 'SSH' },
  { label: 'RDP', port: '3389', proto: 'tcp', name: 'Remote Desktop' },
  { label: 'Plex', port: '32400', proto: 'tcp', name: 'Plex' },
  { label: 'Minecraft', port: '25565', proto: 'tcp', name: 'Minecraft' },
  { label: 'Steam / Source', port: '27015', proto: 'tcp udp', name: 'Game server' },
  { label: 'Xbox Live', port: '3074', proto: 'tcp udp', name: 'Xbox Live' },
  { label: 'PlayStation', port: '3478-3480', proto: 'tcp udp', name: 'PlayStation' },
  { label: 'WireGuard', port: '51820', proto: 'udp', name: 'WireGuard' },
  { label: 'Home Assistant', port: '8123', proto: 'tcp', name: 'Home Assistant' },
]

const range = (p: string): [number, number] | undefined => {
  const m = /^(\d+)(?:[-:](\d+))?$/.exec(p.trim())
  return m ? [+m[1], +(m[2] ?? m[1])] : undefined
}
const protos = (s: UciSection) => (list(s.proto).length ? list(s.proto) : ['tcp', 'udp'])

/** Other enabled forwards that grab the same external port + protocol on the same zone. */
function conflicts(r: UciSection, all: UciSection[]) {
  const a = range(str(r.src_dport))
  if (!a || !isEnabled(r)) return []
  return all.filter((o) => {
    if (o === r || !isEnabled(o) || str(o.src) !== str(r.src)) return false
    const b = range(str(o.src_dport))
    return !!b && a[0] <= b[1] && b[0] <= a[1] && protos(o).some((p) => protos(r).includes(p))
  })
}

export function zoneForIp(ip: string, zones: Zone[], net: UciConfig): Zone | undefined {
  const subnets = interfaceSubnets(net)
  const iface = Object.entries(subnets).find(([, s]) => inSubnet(ip, s))?.[0]
  return iface ? zones.find((z) => z.networks.includes(iface)) : undefined
}

export function ForwardsView({ openId }: { openId?: string }) {
  const { fw, staged } = useFw()
  const redirects = ofType(fw, 'redirect')
  const devices = useKnownDevices()
  const [error, setError] = useState<unknown>()
  const editing = openId && openId !== 'new' ? fw[openId] : undefined
  const close = () => go('firewall', 'forwards')
  const nameOf = (ip: string) => devices.data?.find((d) => d.ip === ip)?.name

  return (
    <>
      <Card flush title="Port forwards" actions={<>
        <Button variant="primary" icon="plus" onClick={() => go('firewall', 'forwards', 'new')}>Add port forward</Button>
      </>}>
        {error ? <div style={{ padding: 'var(--sp-2)' }}><ErrorBox error={error} /></div> : null}
        {!redirects.length ? (
          <Empty>
            <div class="stack" style={{ alignItems: 'center' }}>
              <span>No port forwards. Nothing on the inside is reachable from the internet.</span>
            </div>
          </Empty>
        ) : (
          <div class="rule-list">
            {redirects.map((r) => {
              const on = isEnabled(r)
              const clash = conflicts(r, redirects)
              return (
                <div class={`rule-row fwd-row${on ? '' : ' off'}`} onClick={(e) => !(e.target as HTMLElement).closest('button, a, .tip-anchor') && go('firewall', 'forwards', r['.name'])}>
                  <Toggle on={on} label={`${on ? 'Disable' : 'Enable'} ${str(r.name) || 'port forward'}`} onChange={(v) => setEnabled('firewall', r, v).then(() => setError(undefined), setError)} />
                  <ForwardSentence r={r} device={nameOf(str(r.dest_ip))} />
                  <span class="rule-meta">
                    <span class="rule-name">{str(r.name)}</span>
                    {str(r.src_ip) && <Badge>only from {list(r.src_ip).join(', ')}</Badge>}
                    {!on && <Badge>off</Badge>}
                    {clash.length > 0 && (
                      <Tip text={`External port ${str(r.src_dport)} is also forwarded by ${clash.map((c) => str(c.name) || c['.name']).join(', ')}. Only the first one gets the traffic.`}>
                        <span tabIndex={0}><Badge status="warning">port conflict</Badge></span>
                      </Tip>
                    )}
                    <Hits s={r} />
                    {staged.has(r['.name']) && <Unapplied />}
                  </span>
                  <Button variant="ghost" icon="edit" aria-label={`Edit ${str(r.name) || 'port forward'}`} title="Edit" onClick={() => go('firewall', 'forwards', r['.name'])} />
                </div>
              )
            })}
          </div>
        )}
      </Card>
      {(openId === 'new' || editing) && <ForwardDrawer redirect={editing} devices={devices.data ?? []} onClose={close} />}
    </>
  )
}

export function ForwardSentence({ r, device }: { r: UciSection; device?: string }) {
  const ext = str(r.src_dport)
  const port = str(r.dest_port) || ext
  return (
    <span class="sentence">
      <ZonePill name={str(r.src) || 'wan'} />
      <code class="addr">:{ext || 'any'}</code>
      <Icon name="arrowRight" size={14} class="muted" />
      {device ? <b>{device}</b> : null}
      <code class="addr">{str(r.dest_ip) || '?'}{port ? `:${port}` : ''}</code>
      <span class="muted">({protoLabel(list(r.proto))})</span>
    </span>
  )
}

function ForwardDrawer({ redirect, devices, onClose }: { redirect?: UciSection; devices: KnownDevice[]; onClose: () => void }) {
  const { zones, net, fw } = useFw()
  const wan = zones.find((z) => z.name === 'wan')?.name ?? zones.find((z) => z.masq)?.name ?? ''
  const [d, setD] = useState({
    name: str(redirect?.name),
    src: str(redirect?.src) || wan,
    proto: redirect ? (list(redirect.proto).join(' ') || 'tcp udp') : 'tcp',
    src_dport: str(redirect?.src_dport),
    dest_ip: str(redirect?.dest_ip),
    dest_port: str(redirect?.dest_port),
    dest: str(redirect?.dest),
    src_ip: str(redirect?.src_ip),
    enabled: redirect ? isEnabled(redirect) : true,
    reflection: str(redirect?.reflection) !== '0',
  })
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const up = (p: Partial<typeof d>) => setD((x) => ({ ...x, ...p }))

  const autoZone = zoneForIp(d.dest_ip, zones, net)
  const destZone = autoZone?.name ?? d.dest
  const device = devices.find((x) => x.ip === d.dest_ip)
  const preview = useMemo(() => ({ '.anonymous': true, '.type': 'redirect', '.name': 'preview', ...d, dest: destZone, enabled: d.enabled ? '1' : '0' }) as UciSection, [d, destZone])
  const clash = conflicts(preview, ofType(fw, 'redirect').filter((x) => x['.name'] !== redirect?.['.name']))

  const portErr = (p: string, required: boolean) => (!p ? (required ? 'Required' : undefined) : range(p) && range(p)![0] >= 1 && range(p)![1] <= 65535 && range(p)![0] <= range(p)![1] ? undefined : 'A port (1-65535) or range like 3478-3480')
  const errs = {
    src_dport: portErr(d.src_dport, true),
    dest_port: portErr(d.dest_port, false),
    dest_ip: !d.dest_ip ? 'Pick a device' : ip4(d.dest_ip) === undefined ? 'Not an IPv4 address' : !destZone ? 'Not in any zone: choose the zone below' : undefined,
  }
  const invalid = Object.values(errs).some(Boolean)

  const save = async () => {
    setBusy(true)
    try {
      const v: Record<string, string | undefined> = {
        name: d.name || `${device?.name ?? d.dest_ip} ${d.src_dport}`,
        src: d.src, proto: d.proto === 'tcp udp' ? undefined : d.proto, src_dport: d.src_dport, dest: destZone, dest_ip: d.dest_ip,
        dest_port: d.dest_port && d.dest_port !== d.src_dport ? d.dest_port : undefined, src_ip: d.src_ip || undefined,
        target: 'DNAT', enabled: d.enabled ? undefined : '0', reflection: d.reflection ? undefined : '0',
      }
      if (redirect) await setOptions('firewall', redirect['.name'], v, redirect)
      else await uci.add('firewall', 'redirect', Object.fromEntries(Object.entries(v).filter(([, x]) => x)) as Record<string, string>)
      onClose()
    } catch (e) {
      setError(e)
      setBusy(false)
    }
  }
  const remove = async () => {
    try { await uci.remove('firewall', redirect!['.name']); onClose() } catch (e) { setError(e) }
  }
  const preset = PRESETS.find((p) => p.port === d.src_dport && p.proto === d.proto)

  return (
    <Drawer title={redirect ? `Port forward ${str(redirect.name)}` : 'New port forward'} onClose={onClose} footer={<>
      {redirect && <Button variant="danger" icon="trash" onClick={remove}>Delete</Button>}
      <span style={{ flex: 1 }} />
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" icon="check" disabled={busy || invalid} onClick={save}>{redirect ? 'Stage changes' : 'Add port forward'}</Button>
    </>}>
      <div class="stack fw-form">
        <div class="preview-box" aria-live="polite">
          <span class="label">Preview</span>
          <div class="row" style={{ flexWrap: 'wrap' }}><ForwardSentence r={preview} device={device?.name} /></div>
          {clash.length > 0 && <div class="warn-line"><Icon name="warning" size={13} /> Port {d.src_dport} is already forwarded by {clash.map((c) => str(c.name) || c['.name']).join(', ')}.</div>}
          {device && !device.reserved && <div class="warn-line"><Icon name="info" size={13} /> {device.name ?? d.dest_ip} has a dynamic address that can change; reserve it under Devices so this keeps working.</div>}
        </div>
        {error ? <ErrorBox error={error} /> : null}
        <Field label="Service">
          <div class="chips">
            {PRESETS.map((p) => (
              <button type="button" class={`chip${preset === p ? ' on' : ''}`} aria-pressed={preset === p}
                onClick={() => up({ src_dport: p.port, proto: p.proto, name: !d.name || PRESETS.some((x) => x.name === d.name) ? p.name : d.name })}>
                {p.label}<span class="chip-hint">{p.port}</span>
              </button>
            ))}
          </div>
        </Field>
        <div class="fw-2col">
          <Field label="External port" error={d.src_dport ? errs.src_dport : undefined} hint="Or pick a service above">
            <input class={`input mono${d.src_dport && errs.src_dport ? ' invalid' : ''}`} value={d.src_dport} placeholder="443" onInput={(e) => up({ src_dport: (e.target as HTMLInputElement).value.trim() })} />
          </Field>
          <Field label="Protocol">
            <Chips value={d.proto} onChange={(v) => up({ proto: v })} label="Protocol" options={[{ value: 'tcp', label: 'TCP' }, { value: 'udp', label: 'UDP' }, { value: 'tcp udp', label: 'Both' }]} />
          </Field>
        </div>
        <Field label="To device" error={d.dest_ip ? errs.dest_ip : undefined}>
          <DevicePicker value={d.dest_ip} devices={devices} onChange={(ip) => up({ dest_ip: ip })} />
        </Field>
        <div class="fw-2col">
          <Field label="Port on the device" hint="Empty = same as external" error={errs.dest_port}>
            <input class={`input mono${errs.dest_port ? ' invalid' : ''}`} value={d.dest_port} placeholder={d.src_dport || 'same'} onInput={(e) => up({ dest_port: (e.target as HTMLInputElement).value.trim() })} />
          </Field>
          <Field label="Device zone" hint={!d.dest_ip ? undefined : autoZone ? 'From the device address' : 'Address outside all zone subnets: choose'}>
            {!d.dest_ip ? <span class="muted row" style={{ height: 'var(--row-h)' }}>follows the device</span> : autoZone ?<span class="row" style={{ height: 'var(--row-h)' }}><ZonePill name={autoZone.name} /> <span class="muted">auto</span></span> : (
              <Chips value={d.dest} onChange={(v) => up({ dest: v })} label="Destination zone" options={zones.filter((z) => !z.masq).map((z) => ({ value: z.name, label: z.name, slot: z.slot }))} />
            )}
          </Field>
        </div>
        <Field label="Name" hint="Generated if empty">
          <input class="input" value={d.name} placeholder={`${device?.name ?? 'device'} ${d.src_dport}`} onInput={(e) => up({ name: (e.target as HTMLInputElement).value })} />
        </Field>
        <label class="row fw-flag"><Toggle on={d.enabled} label="Enabled" onChange={(v) => up({ enabled: v })} /> Enabled</label>
        <details class="disclosure" open={!!d.src_ip || (!!d.src && d.src !== wan) || !d.reflection}>
          <summary><Icon name="chevronRight" size={14} /> Advanced</summary>
          <div class="stack">
            <Field label="Incoming zone"><Chips value={d.src} onChange={(v) => up({ src: v })} label="Incoming zone" options={zones.map((z) => ({ value: z.name, label: z.name, slot: z.slot }))} /></Field>
            <Field label="Only from addresses" hint="Optional: limit who can use this forward, e.g. your office IP">
              <input class="input mono" value={d.src_ip} placeholder="anyone" onInput={(e) => up({ src_ip: (e.target as HTMLInputElement).value.trim() })} />
            </Field>
            <label class="row fw-flag"><Toggle on={d.reflection} label="NAT loopback" onChange={(v) => up({ reflection: v })} /> NAT loopback: devices at home can use the public address too</label>
          </div>
        </details>
      </div>
    </Drawer>
  )
}
