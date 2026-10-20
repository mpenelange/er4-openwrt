// Mock endpoints for the Network page (pages/network).
//
// Router sources (no ER-4 plugin needed for this page):
//   network.interface dump   netifd   (overridden here: masks from netmask, VLAN/port state)
//   network.device status    netifd   (overridden here: 8021q devices from UCI, no-link ports)
//   er4.offload              ER-4 plugin (already in core)
//
// Scenarios (see ../scenario.ts): many = extra VLANs + a dedicated port with no link;
// empty = no networks at all; fresh = factory defaults (lan on eth1, no bridge); error = interface dump times out; staged = a new "guest"
// network staged by the wizard but not applied; loading = interface dump never returns.
import { UBUS_STATUS, UbusError } from '../../ubus'
import type { UciConfig, UciSection } from '../../types'
import { mockUci as st, objects, registerMock, type MockHandler } from '../registry'
import { afterCore, never, netScenario as scenario } from '../scenario'

const sc = scenario()

function put(c: UciConfig, type: string, name: string, opts: Record<string, string | string[]>, anonymous = false) {
  c[name] = { '.anonymous': anonymous, '.type': type, '.name': name, '.index': Object.keys(c).length, ...opts } as UciSection
}

function seedMany(cfg: Record<string, UciConfig>) {
  const n = cfg.network, d = cfg.dhcp, f = cfg.firewall
  const br = Object.values(n).find((s) => s.type === 'bridge')!
  br.ports = ['eth1', 'eth3']
  put(n, 'device', 'guest_dev', { type: '8021q', ifname: 'br-lan', vid: '20', name: 'br-lan.20' })
  put(n, 'interface', 'guest', { device: 'br-lan.20', proto: 'static', ipaddr: '192.168.20.1', netmask: '255.255.255.0' })
  put(n, 'interface', 'lab', { device: 'eth2', proto: 'static', ipaddr: '10.10.0.1', netmask: '255.255.255.0', mtu: '9000' })
  put(n, 'device', 'cams_dev', { type: '8021q', ifname: 'eth3', vid: '40', name: 'eth3.40' })
  put(n, 'interface', 'cams', { device: 'eth3.40', proto: 'static', ipaddr: '192.168.40.1', netmask: '255.255.255.0' })
  put(n, 'device', 'mgmt_dev', { type: '8021q', ifname: 'eth3', vid: '99', name: 'eth3.99' })
  put(n, 'interface', 'mgmt', { device: 'eth3.99', proto: 'static', ipaddr: '172.16.99.1', netmask: '255.255.255.0' })
  put(d, 'dhcp', 'guest', { interface: 'guest', start: '50', limit: '200', leasetime: '2h' })
  put(d, 'dhcp', 'lab', { interface: 'lab', start: '100', limit: '50', leasetime: '12h' })
  put(d, 'dhcp', 'cams', { interface: 'cams', start: '10', limit: '40', leasetime: '7d' })
  put(d, 'dhcp', 'mgmt', { interface: 'mgmt', ignore: '1' })
  put(f, 'zone', 'cfg20dc81', { name: 'guest', network: ['guest'], input: 'REJECT', output: 'ACCEPT', forward: 'REJECT' }, true)
  put(f, 'zone', 'cfg21dc81', { name: 'cams', network: ['cams'], input: 'REJECT', output: 'ACCEPT', forward: 'REJECT' }, true)
  put(f, 'forwarding', 'cfg22ad58', { src: 'guest', dest: 'wan' }, true)
  put(f, 'forwarding', 'cfg23ad58', { src: 'lan', dest: 'cams' }, true)
  // lab and mgmt join the lan zone
  const lanZone = Object.values(f).find((s) => s['.type'] === 'zone' && s.name === 'lan')!
  lanZone.network = ['lan', 'lab', 'mgmt']
}

function seedEmpty(cfg: Record<string, UciConfig>) {
  for (const [k, s] of Object.entries(cfg.network)) if (s['.type'] === 'interface' && k !== 'loopback') delete cfg.network[k]
  for (const [k, s] of Object.entries(cfg.network)) if (s['.type'] === 'device' || s['.type'].startsWith('wireguard_')) delete cfg.network[k]
  for (const [k, s] of Object.entries(cfg.dhcp)) if (s['.type'] === 'dhcp') delete cfg.dhcp[k]
}

/** A freshly flashed router (board.d/01_network): lan on eth1 alone, no bridge, eth2/eth3
 *  unassigned, no extra networks or VPN. The ER-4 has no switch chip, so ports aren't bridged. */
function seedFresh(cfg: Record<string, UciConfig>) {
  for (const [k, s] of Object.entries(cfg.network)) if (s['.type'] === 'device' || s['.type'].startsWith('wireguard_') || k === 'iot' || k === 'wg0') delete cfg.network[k]
  cfg.network.lan.device = 'eth1'
  delete cfg.dhcp.iot
  for (const [k, s] of Object.entries(cfg.firewall)) {
    if ((s['.type'] === 'zone' && (s.name === 'iot' || s.name === 'vpn')) || (s['.type'] === 'forwarding' && (s.src === 'iot' || s.src === 'vpn'))
      || ((s['.type'] === 'rule' || s['.type'] === 'redirect') && (s.src === 'iot' || s.name === 'Allow-WireGuard'))) delete cfg.firewall[k]
  }
}

const NO_LINK = sc === 'many' ? new Set(['eth2']) : sc === 'fresh' ? new Set(['eth2', 'eth3']) : new Set<string>()

afterCore(() => {
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
  if (sc === 'many' || sc === 'empty' || sc === 'fresh') {
    ;(sc === 'many' ? seedMany : sc === 'fresh' ? seedFresh : seedEmpty)(st.live)
    st.staged = clone(st.live)
  }

  const coreDump = objects['network.interface'].dump
  const coreStatus = objects['network.device'].status

  // The methods captured here may already be wrapped (async) by other ext files (e.g.
  // dashboard.ts scenarios), so always await them.
  const status: MockHandler = async (args) => {
    const all = (await coreStatus({})) as Record<string, Record<string, unknown>>
    for (const p of NO_LINK) if (all[p]) all[p] = { ...all[p], carrier: false, speed: '-1' }
    const devs = Object.values(st.live.network).filter((s) => s['.type'] === 'device')
    if (!devs.some((s) => s.name === 'br-lan.30')) delete all['br-lan.30']
    // a PPPoE session has its own device, carrying the WAN's traffic
    if (st.live.network.wan?.proto === 'pppoe' && all.eth0) all['pppoe-wan'] = { ...all.eth0, type: 'Network device', macaddr: '', speed: '-1' }
    for (const s of devs) {
      if (s.type !== '8021q') continue
      const parent = all[String(s.ifname)]
      if (parent) all[String(s.name)] = { ...parent, type: 'VLAN', 'bridge-members': undefined }
    }
    if (args.name) return all[args.name as string] ?? (() => { throw new UbusError('network.device', 'status', UBUS_STATUS.NOT_FOUND) })()
    return all
  }

  registerMock('network.device', { status })
  registerMock('network.interface', {
    dump: async (args) => {
      if (sc === 'error') throw new UbusError('network.interface', 'dump', UBUS_STATUS.TIMEOUT)
      if (sc === 'loading') return never()
      const { interface: ifs } = (await coreDump(args)) as { interface: Record<string, unknown>[] }
      const devs = (await status({})) as Record<string, { carrier: boolean }>
      for (const i of ifs) {
        const s = st.live.network[String(i.interface)]
        if (!s) continue
        if (s.netmask && s.ipaddr) {
          const mask = String(s.netmask).split('.').reduce((n, o) => n + (Number(o) >>> 0).toString(2).replace(/0/g, '').length, 0)
          i['ipv4-address'] = [{ address: String(s.ipaddr), mask }]
        }
        const dev = s.device ? String(s.device) : undefined
        // PPPoE runs over the device but its layer-3 device is pppoe-<name>; a stopped interface has none
        if (dev) Object.assign(i, s.proto === 'pppoe' || i.autostart === false ? { device: dev } : { device: dev, l3_device: dev })
        if (s.proto !== 'wireguard' && (!dev || !devs[dev] || !devs[dev].carrier)) {
          Object.assign(i, { up: false, pending: false, available: !!dev && !!devs[dev], uptime: undefined })
          for (const k of ['ipv4-address', 'ipv6-address', 'route', 'dns-server']) delete i[k] // as netifd
        }
      }
      return { interface: ifs }
    },
  })

  if (sc === 'staged') {
    const u = objects.uci
    u.add({ config: 'network', type: 'device', name: 'guest_dev', values: { type: '8021q', ifname: 'br-lan', vid: '20', name: 'br-lan.20' } })
    u.add({ config: 'network', type: 'interface', name: 'guest', values: { device: 'br-lan.20', proto: 'static', ipaddr: '192.168.20.1', netmask: '255.255.255.0' } })
    u.add({ config: 'dhcp', type: 'dhcp', name: 'guest', values: { interface: 'guest', start: '100', limit: '150', leasetime: '12h' } })
    u.add({ config: 'firewall', type: 'zone', values: { name: 'guest', network: ['guest'], input: 'REJECT', output: 'ACCEPT', forward: 'REJECT' } })
    u.add({ config: 'firewall', type: 'forwarding', values: { src: 'guest', dest: 'wan' } })
    u.set({ config: 'network', section: 'lan', values: { ipaddr: '192.168.1.254' } })
  }
})
