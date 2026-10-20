// In-browser stand-in for the router's ubus, so the UI can be built and demoed without
// hardware. Behaves like rpcd where the UI depends on it:
//   - uci.get returns the session's staged view; set/add/delete only stage
//   - uci.apply {rollback, timeout} makes staged values live and reverts them unless
//     uci.confirm arrives in time (watch the console for the mock rollback); a rollback
//     stages the applied changes again, and revert/apply are refused while one is pending
//   - er4.stats counters advance with simulated traffic
// Login: user root, any non-empty password.
import { UBUS_STATUS, UbusError, type Transport } from '../ubus'
import type { UciChange, UciConfig, UciSection, UciValue } from '../types'
import { initialUci, leases, ports } from './data'
import { mockUci as st, objects, registerMock, type MockHandler } from './registry'
import { mockNow } from './scenario'
// Per-area mock endpoints: one file per UI area in ./ext/, each calling registerMock()
import.meta.glob('./ext/*.ts', { eager: true })

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

st.live = initialUci()
st.staged = clone(st.live)
let changes: Record<string, UciChange[]> = {}
// An armed apply: the live config to go back to, and the session's staged changes, which rpcd
// restores on rollback (they show up as unapplied again)
let pending: { snapshot: Record<string, UciConfig>; staged: Record<string, UciConfig>; changes: Record<string, UciChange[]>; timer: number } | undefined
let anon = 0x100

function fail(object: string, method: string, code: number): never {
  throw new UbusError(object, method, code)
}

function record(config: string, ch: UciChange) {
  ;(changes[config] ??= []).push(ch)
}

/** rpcd's rollback: the old config goes live again and the applied changes are staged again. */
function undoApply() {
  st.live = pending!.snapshot
  st.staged = pending!.staged
  changes = pending!.changes
  pending = undefined
}

// ---- traffic simulation ------------------------------------------------------------
const t0 = Date.now()
const counters = Object.fromEntries(
  Object.keys(ports).map((p) => [p, { rx_bytes: 0, tx_bytes: 0, rx_packets: 0, tx_packets: 0, rx_dropped: 0, tx_dropped: 0 }]),
) as Record<string, { rx_bytes: number; tx_bytes: number; rx_packets: number; tx_packets: number; rx_dropped: number; tx_dropped: number }>
const cpu = { total: [0, 0, 0, 0], idle: [0, 0, 0, 0] }
const flows = { flow_found: 0, flow_not_found: 0, invalidations: 3 }
let lastSim = Date.now()

function simulate() {
  const now = Date.now()
  const dt = (now - lastSim) / 1000
  lastSim = now
  const t = (now - t0) / 1000
  // WAN download with a slow wave plus bursts; uploads smaller; LAN mirrors WAN
  const down = 1e6 * (180 + 140 * Math.sin(t / 23) + (Math.sin(t / 3.7) > 0.93 ? 420 : 0) + 30 * Math.random())
  const up = 1e6 * (25 + 15 * Math.sin(t / 17) + 10 * Math.random())
  const lanShare = { eth1: 0.55, eth2: 0.35, eth3: 0.1 } as const
  const add = (p: string, rxBits: number, txBits: number) => {
    const c = counters[p]
    c.rx_bytes += (rxBits / 8) * dt
    c.tx_bytes += (txBits / 8) * dt
    c.rx_packets += (rxBits / 8 / 900) * dt
    c.tx_packets += (txBits / 8 / 900) * dt
    if (Math.random() < 0.02) c.rx_dropped += 1
  }
  add('eth0', down, up)
  for (const [p, share] of Object.entries(lanShare)) add(p, up * share, down * share)
  const pps = (down + up) / 8 / 900
  flows.flow_found += pps * 0.985 * dt
  flows.flow_not_found += pps * 0.015 * dt
  if (Math.random() < 0.01) flows.invalidations += 1
  for (let i = 0; i < 4; i++) {
    const busy = Math.min(0.95, 0.04 + (down / 1e9) * 0.18 + 0.05 * Math.random())
    cpu.total[i] += 100 * dt
    cpu.idle[i] += 100 * dt * (1 - busy)
  }
}
setInterval(simulate, 250)

const round = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v)]))

// ---- ubus objects ---------------------------------------------------------------------
const core: Record<string, Record<string, MockHandler>> = {
  session: {
    login: ({ username, password }) => {
      if (username !== 'root' || !password) fail('session', 'login', UBUS_STATUS.PERMISSION_DENIED)
      return { ubus_rpc_session: crypto.randomUUID().replace(/-/g, ''), timeout: 3600 }
    },
    destroy: () => ({}),
    access: () => ({ access: true }),
  },

  system: {
    board: () => ({
      hostname: String(Object.values(st.live.system).find((x) => x['.type'] === 'system')?.hostname ?? 'er4'),
      model: 'Ubiquiti EdgeRouter 4',
      board_name: 'ubnt,edgerouter-4',
      kernel: '5.15.0-er4+',
      release: { distribution: 'OpenWrt', version: '25.12.5', revision: 'r33051-f5dae5ece4', description: 'OpenWrt 25.12.5 (ER-4 offload build)' },
    }),
    info: () => ({
      uptime: Math.round((Date.now() - t0) / 1000) + 86400 * 3 + 7211,
      localtime: Math.round(Date.now() / 1000),
      load: [0.31, 0.27, 0.22].map((l) => Math.round(l * 65536)),
      memory: { total: 1011441664, free: 932000000, shared: 13140000, buffered: 0, available: 910600000, cached: 13140000 },
      root: { total: 493860, free: 481340, used: 12520, avail: 481340 },
      tmp: { total: 493860, free: 489120, used: 4740, avail: 489120 },
    }),
    reboot: () => ({}),
  },

  uci: {
    get: ({ config, section }) => {
      const c = st.staged[config as string] ?? fail('uci', 'get', UBUS_STATUS.NOT_FOUND)
      if (section) return { values: c[section as string] ?? fail('uci', 'get', UBUS_STATUS.NOT_FOUND) }
      return { values: clone(c) }
    },
    set: ({ config, section, values }) => {
      const s = st.staged[config as string]?.[section as string] ?? fail('uci', 'set', UBUS_STATUS.NOT_FOUND)
      // rpcd: an empty list fails the whole call (nothing is saved); an unchanged string is skipped
      if (Object.values(values as object).some((v) => Array.isArray(v) && !v.length)) fail('uci', 'set', UBUS_STATUS.INVALID_ARGUMENT)
      for (const [k, v] of Object.entries(values as Record<string, UciValue>)) {
        if (typeof v === 'string' && s[k] === v) continue
        // rpcd: a list replaces the option (remove + one list-add per item)
        if (Array.isArray(v)) {
          if (k in s) record(config as string, ['remove', section as string, k])
          for (const x of v) record(config as string, ['list-add', section as string, k, x])
        } else record(config as string, ['set', section as string, k, v])
        s[k] = v
      }
      return {}
    },
    add: ({ config, type, name, values }) => {
      const c = st.staged[config as string] ?? fail('uci', 'add', UBUS_STATUS.NOT_FOUND)
      const sec = (name as string) || `cfg${(anon++).toString(16)}`
      const index = Math.max(-1, ...Object.values(c).map((x) => x['.index'] ?? 0)) + 1
      c[sec] = { '.anonymous': !name, '.type': type as string, '.name': sec, '.index': index, ...((values as object) ?? {}) } as UciSection
      // rpcd's deltas: a named section is ['set', name, type], an anonymous one ['add', id, type];
      // list values are one list-add per item
      record(config as string, name ? ['set', sec, type as string] : ['add', sec, type as string])
      for (const [k, v] of Object.entries((values as Record<string, UciValue>) ?? {})) {
        if (Array.isArray(v)) for (const x of v) record(config as string, ['list-add', sec, k, x])
        else record(config as string, ['set', sec, k, v])
      }
      return { section: sec }
    },
    delete: ({ config, section, options }) => {
      const c = st.staged[config as string] ?? fail('uci', 'delete', UBUS_STATUS.NOT_FOUND)
      if (options) {
        // rpcd: NOT_FOUND (nothing saved) unless at least one of the options exists
        const sec = c[section as string] ?? fail('uci', 'delete', UBUS_STATUS.NOT_FOUND)
        if (!(options as string[]).some((o) => o in sec)) fail('uci', 'delete', UBUS_STATUS.NOT_FOUND)
        for (const o of (options as string[]).filter((o) => o in sec)) {
          delete c[section as string]?.[o]
          record(config as string, ['remove', section as string, o])
        }
      } else {
        if (!c[section as string]) fail('uci', 'delete', UBUS_STATUS.NOT_FOUND)
        delete c[section as string]
        record(config as string, ['remove', section as string])
      }
      return {}
    },
    // rpcd: the listed sections take positions 0..n-1 (unlisted ones follow). Real rpcd records
    // an 'order' delta for every listed section; the mock records only the ones that moved.
    order: ({ config, sections }) => {
      const c = st.staged[config as string] ?? fail('uci', 'order', UBUS_STATUS.NOT_FOUND)
      const listed = (sections as string[]).filter((n) => c[n])
      const rest = Object.values(c).sort((a, b) => (a['.index'] ?? 0) - (b['.index'] ?? 0)).map((x) => x['.name']).filter((n) => !listed.includes(n))
      ;[...listed, ...rest].forEach((n, i) => {
        if (c[n]['.index'] !== i && i < listed.length) record(config as string, ['order', n, String(i)])
        c[n]['.index'] = i
      })
      return {}
    },
    changes: () => ({ changes: clone(changes) }),
    revert: ({ config }) => {
      if (pending) fail('uci', 'revert', UBUS_STATUS.PERMISSION_DENIED) // rpcd: not while an apply is pending
      st.staged[config as string] = clone(st.live[config as string])
      delete changes[config as string]
      return {}
    },
    apply: ({ rollback, timeout }) => {
      if (pending) fail('uci', 'apply', UBUS_STATUS.PERMISSION_DENIED) // rpcd: apply already pending
      const snapshot = clone(st.live)
      const staged = clone(st.staged)
      const applied = clone(changes)
      st.live = clone(st.staged)
      changes = {}
      if (rollback) {
        const ms = Number(timeout ?? 30) * 1000
        pending = {
          snapshot, staged, changes: applied,
          timer: window.setTimeout(() => {
            console.warn('[mock] no confirm within timeout: rolling back')
            undoApply()
          }, ms),
        }
      }
      return {}
    },
    confirm: () => {
      if (!pending) fail('uci', 'confirm', UBUS_STATUS.NO_DATA)
      clearTimeout(pending.timer)
      pending = undefined
      return {}
    },
    rollback: () => {
      if (!pending) fail('uci', 'rollback', UBUS_STATUS.NO_DATA)
      clearTimeout(pending.timer)
      undoApply()
      return {}
    },
  },

  'network.interface': {
    dump: () => {
      const net = st.live.network
      const iface = (name: string, extra: object) => {
        const i: Record<string, unknown> = {
          interface: name, up: true, pending: false, available: true, uptime: ifUptime(name),
          'ipv4-address': [], 'ipv6-address': [], route: [], 'dns-server': [], ...extra,
        }
        const r = ifRuntime[name]
        if (r?.down || (r?.upAt ?? 0) > Date.now()) {
          // down or coming up: netifd sends no address/route lists at all
          for (const k of ['ipv4-address', 'ipv6-address', 'ipv6-prefix', 'route', 'dns-server', 'l3_device', 'uptime']) delete i[k]
          Object.assign(i, { up: false, pending: !r.down, ...(r.down && { autostart: false }) })
        }
        return i as { interface: string; up: boolean }
      }
      const out = [iface('loopback', { proto: 'static', device: 'lo', l3_device: 'lo', 'ipv4-address': [{ address: '127.0.0.1', mask: 8 }] })]
      for (const s of Object.values(net)) {
        if (s['.type'] !== 'interface' || s['.name'] === 'loopback') continue
        const name = s['.name']
        if (name === 'wan' && s.proto === 'pppoe') {
          // no credentials, no session: pppd keeps retrying (netifd: pending, not up)
          const ok = !!s.username && !!s.password
          out.push(iface(name, ok
            ? { proto: 'pppoe', device: String(s.device ?? 'eth0'), l3_device: 'pppoe-wan', 'ipv4-address': [{ address: '100.64.12.34', mask: 32 }], route: [{ target: '0.0.0.0', mask: 0, nexthop: '100.64.0.1' }], 'dns-server': ['100.64.0.53'] }
            : { proto: 'pppoe', device: String(s.device ?? 'eth0'), up: false, pending: true, 'ipv4-address': undefined, route: undefined, 'dns-server': undefined, errors: [{ subsystem: 'pppoe', code: 'AUTH_FAILED' }] }))
        }
        else if (name === 'wan')
          out.push(iface(name, { proto: String(s.proto ?? 'dhcp'), device: 'eth0', l3_device: 'eth0', 'ipv4-address': [{ address: '203.0.113.57', mask: 24 }], route: [{ target: '0.0.0.0', mask: 0, nexthop: '203.0.113.1' }], 'dns-server': ['203.0.113.2', '203.0.113.3'] }))
        else if (s.proto === 'dhcpv6') {
          // the ISP delegates a /56 unless a smaller one is asked for (reqprefix)
          const want = Number(s.reqprefix) || 56
          out.push(iface(name, {
            proto: 'dhcpv6', device: String(s.device ?? 'eth0'), l3_device: String(s.device ?? 'eth0').replace(/^@/, '') === 'wan' ? 'eth0' : String(s.device ?? 'eth0'),
            'ipv6-address': s.reqaddress === 'none' ? [] : [{ address: '2001:db8:ffff::57', mask: 128 }],
            'ipv6-prefix': s.reqprefix === 'no' ? [] : [{ address: '2001:db8:4a10:100::', mask: Math.max(want, 48), class: name, assigned: {} }],
            route: [{ target: '::', mask: 0, nexthop: 'fe80::1', source: '::/0' }], 'dns-server': ['2001:db8:ffff::53'],
          }))
        }
        else {
          // ip6assign: a slice of wan6's delegated prefix (2001:db8:4a10:100::/56), one per network
          const v6 = (() => {
            const w6 = Object.values(net).find((x) => x['.type'] === 'interface' && x.proto === 'dhcpv6')
            const size = Number(s.ip6assign)
            if (!size || !w6 || w6.reqprefix === 'no' || ifRuntime[w6['.name']]?.down) return undefined
            const k = Object.values(net).filter((x) => x['.type'] === 'interface' && Number(x.ip6assign)).findIndex((x) => x['.name'] === name)
            const p = `2001:db8:4a10:1${(k * 3).toString(16)}0::`
            return { 'ipv6-prefix-assignment': [{ address: p, mask: size, 'local-address': { address: `${p}1`, mask: size } }] }
          })()
          const addr = s.ipaddr ? [{ address: String(s.ipaddr), mask: 24 }] : Array.isArray(s.addresses) ? s.addresses.map((a) => ({ address: a.split('/')[0], mask: Number(a.split('/')[1]) })) : []
          out.push(iface(name, { proto: String(s.proto), device: String(s.device ?? name), l3_device: String(s.device ?? name), 'ipv4-address': addr, ...v6 }))
        }
      }
      return { interface: out }
    },
  },

  'network.device': {
    status: ({ name }) => {
      simulate()
      const dev = (p: keyof typeof ports) => ({
        type: 'Network device', up: true, carrier: ports[p].carrier, speed: ports[p].speed, macaddr: ports[p].mac, mtu: 1500,
        // eth3 (SFP) reports no PHY details; eth2 has a flaky cable: CRC errors
        ...(p !== 'eth3' && {
          autoneg: true, 'link-advertising': ['10baseT-H', '10baseT-F', '100baseT-H', '100baseT-F', '1000baseT-F'],
          'link-partner-advertising': ports[p].carrier ? ['10baseT-H', '10baseT-F', '100baseT-H', '100baseT-F', '1000baseT-F'] : [],
          'flow-control': { autoneg: true, negotiated: ports[p].carrier ? ['rx', 'tx'] : [] },
        }),
        statistics: { ...round(counters[p]), rx_errors: p === 'eth2' ? 37 : 0, tx_errors: 0, multicast: 0,
          rx_crc_errors: p === 'eth2' ? 37 : 0, rx_frame_errors: 0, rx_length_errors: 0, rx_missed_errors: 0, rx_over_errors: 0, rx_fifo_errors: 0, tx_carrier_errors: 0, collisions: 0 },
      })
      const all: Record<string, unknown> = Object.fromEntries((Object.keys(ports) as (keyof typeof ports)[]).map((p) => [p, dev(p)]))
      const bridge = Object.values(st.live.network).find((x) => x['.type'] === 'device' && x.type === 'bridge')
      all['br-lan'] = { ...dev('eth1'), type: 'bridge', 'bridge-members': bridge?.ports ?? [] }
      all['br-lan.30'] = { ...dev('eth1'), type: 'VLAN' }
      all['wg0'] = { ...dev('eth2'), type: 'Network device', speed: '-1', macaddr: '' }
      return name ? all[name as string] ?? fail('network.device', 'status', UBUS_STATUS.NOT_FOUND) : all
    },
  },

  'luci-rpc': {
    getDHCPLeases: () => ({ dhcp_leases: leases }),
  },

  er4: {
    stats: () => {
      simulate()
      return {
        time: Math.round(mockNow() * 1000),
        cpu: { total: cpu.total.map(Math.round), idle: cpu.idle.map(Math.round) },
        ports: Object.fromEntries(Object.entries(counters).map(([p, c]) => [p, round(c)])),
        offload: round(flows),
        conntrack: { count: 240 + Math.round(60 * Math.sin((Date.now() - t0) / 9000)), max: 16384 },
      }
    },
    offload: () => {
      const o = st.live.offload.global
      return {
        loaded: o.enabled === '1', ipv4: o.ipv4 === '1', ipv6: o.ipv6 === '1', vlan: o.vlan === '1', pppoe: o.pppoe === '1',
        stats: o.stats === '1', cache_size: 8192, fwd_queue_depth: 128,
      }
    },
  },
}

for (const [o, m] of Object.entries(core)) registerMock(o, m)

// ---- per-interface control: netifd's network.interface.<name> up/down/renew ---------------
const ifRuntime: Record<string, { down?: boolean; upAt?: number; since?: number }> = {}
const ifUptime = (name: string) => {
  const since = ifRuntime[name]?.since
  return since ? Math.floor((Date.now() - since) / 1000) : 3 * 86400
}
/** Bring an interface up after a short delay (DHCP, PPPoE take a moment). */
export function mockIfUp(name: string, ms = 1500) {
  ifRuntime[name] = { upAt: Date.now() + ms, since: Date.now() + ms }
}
function ifaceObject(name: string): Record<string, MockHandler> | undefined {
  const s = st.live.network?.[name]
  if (!s || s['.type'] !== 'interface') return undefined
  return {
    up: () => { if (ifRuntime[name]?.down || !ifRuntime[name]) mockIfUp(name); return {} },
    down: () => { ifRuntime[name] = { down: true }; return {} },
    renew: () => { if (!ifRuntime[name]?.down) mockIfUp(name, 800); return {} },
  }
}
registerMock('er4', {
  // the router runs `ifup <name>` (down, then up) in the background
  iface_restart: ({ name }) => {
    const s = st.live.network?.[String(name)]
    if (!s || s['.type'] !== 'interface' || name === 'loopback') return { error: 'no such interface' }
    mockIfUp(String(name), 2000)
    return {}
  },
})

export const mockTransport: Transport = async (_session, object, method, args) => {
  await new Promise((r) => setTimeout(r, 25 + Math.random() * 50))
  const fn = (objects[object] ?? (object.startsWith('network.interface.') ? ifaceObject(object.slice(18)) : undefined))?.[method]
  if (!fn) fail(object, method, UBUS_STATUS.METHOD_NOT_FOUND)
  return fn(args)
}

