// Dashboard mocks: edge states for the core endpoints, plus a stats history.
//
// ER-4 plugin:
//   er4.history {window: seconds (300 | 3600 | 86400)}
//     -> { step: seconds, samples: Er4Stats[] }  oldest first, the same cumulative counters as
//     er4.stats, so the UI computes rates with rates(). The plugin keeps ring buffers in RAM:
//     2 s x 150 (5 min), 15 s x 240 (1 h), 120 s x 720 (24 h); ~40 KiB total. Lets the
//     dashboard draw the last 5 min / 1 h / 24 h the moment it opens instead of starting empty.
//
// Scenarios (see ../scenario.ts): wan-down, eth2-nolink, eth3-100m, stats-error, slow,
// offload-off, conntrack-full, no-leases.
import { UBUS_STATUS, UbusError } from '../../ubus'
import type { Er4Stats, NetInterface } from '../../types'
import { objects, registerMock } from '../registry'
import { maybeSlow, scenario, wrapMock } from '../scenario'

type Counters = Er4Stats['ports'][string]

// Which ports have no carrier right now
function downPorts(): Set<string> {
  const s = new Set<string>()
  if (scenario('wan-down')) s.add('eth0')
  if (scenario('eth2-nolink')) s.add('eth2')
  return s
}

// Counters of a port without link stop moving; when the link returns they continue from there
// (an offset hides the traffic the core simulation kept counting meanwhile).
const freeze: Record<string, { at?: Counters; offset?: Counters }> = {}
const sub = (a: Counters, b?: Counters): Counters => (b ? (Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v - b[k as keyof Counters]])) as Counters) : a)
function adjustPort(name: string, raw: Counters, down: boolean): Counters {
  const f = (freeze[name] ??= {})
  if (down) {
    f.at ??= sub(raw, f.offset)
    return f.at
  }
  if (f.at) {
    f.offset = sub(raw, f.at)
    f.at = undefined
  }
  return sub(raw, f.offset)
}
let flowsFrozen: Er4Stats['offload'] | undefined
let flowsOffset = { flow_found: 0, flow_not_found: 0 }

wrapMock('er4', 'stats', (orig) => async (args) => {
  if (scenario('stats-error')) throw new UbusError('er4', 'stats', UBUS_STATUS.METHOD_NOT_FOUND)
  const s = (await orig(args)) as Er4Stats
  const down = downPorts()
  for (const [p, c] of Object.entries(s.ports)) s.ports[p] = adjustPort(p, c, down.has(p))
  // No WAN or no offload module: the fast path sees no packets
  const idle = down.has('eth0') || scenario('offload-off')
  const raw = { ...s.offload, flow_found: s.offload.flow_found - flowsOffset.flow_found, flow_not_found: s.offload.flow_not_found - flowsOffset.flow_not_found }
  if (idle) {
    flowsFrozen ??= raw
    s.offload = { ...flowsFrozen, invalidations: s.offload.invalidations }
  } else {
    if (flowsFrozen) {
      flowsOffset = { flow_found: s.offload.flow_found - flowsFrozen.flow_found, flow_not_found: s.offload.flow_not_found - flowsFrozen.flow_not_found }
      flowsFrozen = undefined
    }
    s.offload = { ...s.offload, flow_found: s.offload.flow_found - flowsOffset.flow_found, flow_not_found: s.offload.flow_not_found - flowsOffset.flow_not_found }
  }
  if (scenario('conntrack-full')) s.conntrack = { count: 16384 - 180 - Math.round(Math.random() * 90), max: 16384 }
  return s
})

wrapMock('er4', 'offload', (orig) => async (args) => {
  const o = (await orig(args)) as Record<string, unknown>
  if (scenario('offload-off')) o.loaded = false
  return o
})

wrapMock('network.device', 'status', (orig) => async (args) => {
  type D = { carrier: boolean; speed?: string }
  const r = (await orig(args)) as Record<string, D>
  const down = downPorts()
  const fix = (name: string, d: { carrier: boolean; speed?: string }) => {
    if (down.has(name)) { d.carrier = false; d.speed = '-1' }
    if (name === 'eth3' && scenario('eth3-100m')) d.speed = '100H'
  }
  if (args.name) fix(String(args.name), r as unknown as D)
  else for (const [n, d] of Object.entries(r)) fix(n, d)
  return r
})

wrapMock('network.interface', 'dump', (orig) => async (args) => {
  const r = (await orig(args)) as { interface: NetInterface[] }
  if (scenario('wan-down')) {
    for (const i of r.interface) {
      if (i.interface === 'wan' || i.interface === 'wan6') {
        Object.assign(i, { up: false, pending: true, uptime: undefined })
        // netifd leaves the address/route lists out of a down interface
        for (const k of ['ipv4-address', 'ipv6-address', 'ipv6-prefix', 'route', 'dns-server'] as const) delete i[k]
      }
    }
  }
  return r
})

wrapMock('luci-rpc', 'getDHCPLeases', (orig) => (args) => {
  if (scenario('no-leases')) return { dhcp_leases: [] }
  return orig(args)
})

// ---- er4.history ------------------------------------------------------------------------
// Traffic model for the past: the core mock's wave for fine steps, plus a day/night envelope
// (quiet at 4am, busy in the evening) that shows on the 1 h / 24 h windows.
function model(t: number, step: number) {
  const hour = (new Date(t * 1000).getHours() + new Date(t * 1000).getMinutes() / 60)
  const day = 0.25 + 0.75 * Math.pow(0.5 - 0.5 * Math.cos((2 * Math.PI * (hour - 4)) / 24), 1.4)
  const fine = step <= 2
  const wave = fine ? 140 * Math.sin(t / 23) + (Math.sin(t / 3.7) > 0.93 ? 420 : 0) : 90 * Math.sin(t / 900) + (Math.random() < 0.04 ? 260 : 0)
  const down = 1e6 * Math.max(5, day * (180 + wave + 30 * Math.random()))
  const up = 1e6 * Math.max(1, day * (25 + 15 * Math.sin(t / (fine ? 17 : 700)) + 10 * Math.random()))
  return { down, up }
}

registerMock('er4', {
  history: async ({ window }) => {
    if (scenario('stats-error')) throw new UbusError('er4', 'history', UBUS_STATUS.METHOD_NOT_FOUND)
    const win = Number(window ?? 300)
    const step = win <= 300 ? 2 : win <= 3600 ? 15 : 120
    const n = Math.round(win / step)
    const now = (await objects.er4.stats({})) as Er4Stats
    const out: Er4Stats[] = [now]
    const lanShare: Record<string, number> = { eth1: 0.55, eth2: 0.35, eth3: 0.1 }
    let cur = JSON.parse(JSON.stringify(now)) as Er4Stats
    for (let k = 1; k <= n; k++) {
      const t = now.time / 1000 - k * step
      const { down, up } = scenario('wan-down') && k * step < 90 ? { down: 0, up: 0 } : model(t, step)
      const prev = JSON.parse(JSON.stringify(cur)) as Er4Stats
      prev.time = cur.time - step * 1000
      const take = (p: string, rx: number, tx: number) => {
        const c = prev.ports[p]
        c.rx_bytes -= (rx / 8) * step
        c.tx_bytes -= (tx / 8) * step
        c.rx_packets -= (rx / 8 / 900) * step
        c.tx_packets -= (tx / 8 / 900) * step
      }
      take('eth0', down, up)
      for (const [p, share] of Object.entries(lanShare)) take(p, up * share, down * share)
      const pps = (down + up) / 8 / 900
      prev.offload.flow_found -= pps * (0.975 + 0.02 * Math.random()) * step
      prev.offload.flow_not_found -= pps * 0.015 * step
      if (Math.random() < step / 200) prev.offload.invalidations -= 1
      for (let i = 0; i < 4; i++) {
        const busy = Math.min(0.95, 0.04 + (down / 1e9) * 0.18 + 0.05 * Math.random() + (i === 0 ? 0.03 : 0))
        prev.cpu.total[i] -= 100 * step
        prev.cpu.idle[i] -= 100 * step * (1 - busy)
      }
      prev.conntrack = { count: Math.round(120 + 200 * (down / 4e8) + 30 * Math.random()), max: now.conntrack.max }
      out.push(prev)
      cur = prev
    }
    out.reverse()
    return { step, samples: out }
  },
})

// 'slow' applies to the other areas' calls too, so every screen's loading state can be seen
queueMicrotask(() => queueMicrotask(() => {
  for (const [obj, methods] of Object.entries(objects)) {
    if (obj === 'session') continue
    for (const [m, fn] of Object.entries(methods)) {
      if ((fn as { slowWrapped?: boolean }).slowWrapped) continue
      const w = Object.assign((a: Record<string, unknown>) => maybeSlow(fn(a)), { slowWrapped: true })
      methods[m] = w
    }
  }
}))
