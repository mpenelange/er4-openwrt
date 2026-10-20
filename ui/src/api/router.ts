// Read-side helpers for router state that isn't UCI. Pages import from here, not api.call
// directly, so the mock and the real router stay in sync in one place.
import { api } from './client'
import { emit } from './store'
import type { BoardInfo, DeviceStatus, DhcpLease, Dhcp6Lease, Er4Offload, Er4Stats, NetInterface, SystemInfo } from './types'

export const router = {
  board: () => api.call<BoardInfo>('system', 'board'),
  info: () => api.call<SystemInfo>('system', 'info'),

  interfaces: async () => (await api.call<{ interface: NetInterface[] }>('network.interface', 'dump')).interface,
  /** All devices (no name) or one. */
  devices: () => api.call<Record<string, DeviceStatus>>('network.device', 'status'),
  device: (name: string) => api.call<DeviceStatus>('network.device', 'status', { name }),

  leases: async () => {
    const r = await api.call<{ dhcp_leases: DhcpLease[] }>('luci-rpc', 'getDHCPLeases')
    return r.dhcp_leases
  },

  leases6: async () => {
    const r = await api.call<{ dhcp6_leases?: Dhcp6Lease[] }>('luci-rpc', 'getDHCPLeases')
    return r.dhcp6_leases ?? []
  },

  stats: () => api.call<Er4Stats>('er4', 'stats'),
  offload: () => api.call<Er4Offload>('er4', 'offload'),

  reboot: () => api.call('er4', 'reboot'),
}

/** Start, stop, restart or renew one interface. Restart is a single call on the router (`ifup`:
 *  down, then up), so restarting the network this browser uses still comes back by itself. */
export const ifaceCtl = {
  restart: async (name: string) => {
    const r = await api.call<{ error?: string }>('er4', 'iface_restart', { name })
    if (r?.error) throw new Error(r.error)
  },
  up: (name: string) => api.call(`network.interface.${name}`, 'up'),
  down: (name: string) => api.call(`network.interface.${name}`, 'down'),
  renew: (name: string) => api.call(`network.interface.${name}`, 'renew'),
}

/** Re-read live interface state a few times while an interface changes state. */
export function followIface() {
  for (const ms of [300, 1200, 2500, 4500, 8000]) setTimeout(() => emit('iface'), ms)
}

/**
 * The router's clock, for comparing router timestamps (WireGuard handshakes, image install
 * times) with "now". Without NTP (no WAN yet, just booted) it can be days or months off the
 * browser's. er4.stats carries the router's UTC time; system.info's localtime has the zone in it.
 */
let clockSkew = 0
export const routerClock = {
  /** Router time now, unix seconds (browser time until the first sync). */
  now: () => Date.now() / 1000 + clockSkew,
  async sync() {
    const t0 = Date.now()
    const s = await router.stats()
    clockSkew = (s.time - (t0 + Date.now()) / 2) / 1000
    emit('clock')
  },
}

/** Rates between two er4.stats samples: per-port bit/s and pkt/s, per-core CPU busy %. */
export function rates(a: Er4Stats, b: Er4Stats) {
  const dt = Math.max((b.time - a.time) / 1000, 0.001)
  const ports: Record<string, { rxBps: number; txBps: number; rxPps: number; txPps: number; drops: number }> = {}
  for (const [name, p] of Object.entries(b.ports)) {
    const q = a.ports[name]
    if (!q) continue
    ports[name] = {
      rxBps: ((p.rx_bytes - q.rx_bytes) * 8) / dt,
      txBps: ((p.tx_bytes - q.tx_bytes) * 8) / dt,
      rxPps: (p.rx_packets - q.rx_packets) / dt,
      txPps: (p.tx_packets - q.tx_packets) / dt,
      drops: p.rx_dropped - q.rx_dropped + (p.tx_dropped - q.tx_dropped),
    }
  }
  const cpu = b.cpu.total.map((t, i) => {
    const dTotal = t - a.cpu.total[i]
    const dIdle = b.cpu.idle[i] - a.cpu.idle[i]
    return dTotal > 0 ? (100 * (dTotal - dIdle)) / dTotal : 0
  })
  const found = b.offload.flow_found - a.offload.flow_found
  const missed = b.offload.flow_not_found - a.offload.flow_not_found
  return {
    dt,
    ports,
    cpu,
    cpuAvg: cpu.reduce((s, v) => s + v, 0) / (cpu.length || 1),
    /** Share of forwarded packets that took the hardware fast path, 0..1 (NaN when idle). */
    offloadRatio: found / (found + missed),
    offloadPps: found / dt,
  }
}
