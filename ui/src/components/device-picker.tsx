// Pick a LAN device by clicking it: DHCP leases (luci-rpc getDHCPLeases) merged with static
// hosts (UCI dhcp 'host' sections), searchable, plus a free-form address for anything else.
import { useMemo, useState } from 'preact/hooks'
import { router } from '../api/router'
import { uci } from '../api/uci'
import { useAsync } from '../api/store'
import { ip4 } from '../api/ip4'
import './extras.css'

export interface KnownDevice { name?: string; ip: string; mac?: string; reserved: boolean }

/** Every device the router knows, by IPv4 address (static hosts win over leases for names). */
export function useKnownDevices() {
  return useAsync(async () => {
    const [leases, dhcp] = await Promise.all([router.leases().catch(() => []), uci.get('dhcp').catch(() => ({}))])
    const by = new Map<string, KnownDevice>()
    for (const l of leases) by.set(l.ipaddr, { name: l.hostname, ip: l.ipaddr, mac: l.macaddr, reserved: l.expires < 0 })
    for (const h of Object.values(dhcp)) {
      if (h['.type'] !== 'host' || typeof h.ip !== 'string') continue
      const prev = by.get(h.ip)
      by.set(h.ip, { name: (typeof h.name === 'string' && h.name) || prev?.name, ip: h.ip, mac: (typeof h.mac === 'string' ? h.mac : prev?.mac), reserved: true })
    }
    return [...by.values()].sort((a, b) => (ip4(a.ip) ?? 0) - (ip4(b.ip) ?? 0))
  }, [], ['applied'])
}

export function DevicePicker({ value, onChange, devices }: {
  value: string; onChange: (ip: string, device?: KnownDevice) => void; devices: KnownDevice[]
}) {
  const [q, setQ] = useState('')
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    return s ? devices.filter((d) => [d.name, d.ip, d.mac].some((x) => x?.toLowerCase().includes(s))) : devices
  }, [q, devices])
  const known = devices.some((d) => d.ip === value)
  return (
    <div class="stack">
      <div class="row">
        <input class="input" style={{ flex: 1 }} placeholder={`Search ${devices.length} devices by name, IP or MAC`} value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)} aria-label="Search devices" />
      </div>
      <div class="device-grid" role="listbox" aria-label="Devices">
        {shown.map((d) => (
          <button type="button" role="option" aria-selected={d.ip === value} class={`device${d.ip === value ? ' on' : ''}`} onClick={() => onChange(d.ip, d)}>
            <span class="name">{d.name || <span class="muted">unnamed</span>}</span>
            <span class="ip">{d.ip}</span>
            <span class="meta">{d.reserved ? 'reserved address' : 'dynamic address'}</span>
          </button>
        ))}
        {!shown.length && <span class="muted" style={{ padding: '8px' }}>No device matches “{q}”</span>}
      </div>
      <label class="row secondary" style={{ fontSize: 'var(--fs-sm)' }}>
        Or address
        <input class={`input mono${value && ip4(value) === undefined ? ' invalid' : ''}`} style={{ width: '150px' }} placeholder="192.168.1.50"
          value={known ? '' : value} onInput={(e) => onChange((e.target as HTMLInputElement).value.trim())} />
      </label>
    </div>
  )
}
