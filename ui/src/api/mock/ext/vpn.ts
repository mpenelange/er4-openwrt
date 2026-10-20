// VPN (WireGuard) page mock. Router calls used by pages/vpn (all exist on the real router):
//   er4.wg_instances   ER-4 plugin (same shape as luci.wireguard getWgInstances); runtime of `wg show all dump`:
//                                   { wg0: { name, public_key, listen_port, fwmark, peers: [ {...} ] } },
//                                   peers is an ARRAY and every value a string ("0" = never, "off", "(none)")
//   er4.wg_keypair     ER-4 plugin; fallback when the browser can't do X25519
//                                   (WebCrypto needs https/localhost, the router serves plain http)
//   uci.get/set/add/delete 'network', 'firewall'   rpcd built-in
//   network.interface.dump          netifd (WAN address = default endpoint for client configs)
//
// Scenarios (?scenario=... or #/vpn/?scenario=...):
//   vpn-none    no WireGuard interface at all (setup wizard)
//   vpn-empty   wg0 configured, no peers
//   vpn-many    wg0 with 26 peers in every state (online, stale, never, disabled)
//   vpn-error   wg_instances fails (status unknown, config still editable)
//   vpn-staged  starts with unapplied changes (a peer disabled, a peer added)
import { UBUS_STATUS, UbusError } from '../../ubus'
import { mockUci, registerMock } from '../registry'
import { afterInit, editLive, mockNow, removeWhere, scenario, section, stage } from '../scenario'
import { canGenerateLocally, generateKeyPairLocal, publicFromPrivate, randomKey } from '../../wgkeys'
import { list } from '../../net'

const born = Date.now() / 1000
const pubCache = new Map<string, string>()

/** Deterministic fake key for mock data (not a real curve point). */
function fakeKey(seed: string) {
  let h = 2166136261
  const out: number[] = []
  for (let i = 0; i < 32; i++) {
    for (const c of seed + i) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
    out.push(h & 255)
  }
  return btoa(String.fromCharCode(...out))
}

async function serverPub(priv: string) {
  if (!pubCache.has(priv)) pubCache.set(priv, (canGenerateLocally() && (await publicFromPrivate(priv))) || fakeKey(priv))
  return pubCache.get(priv)!
}

registerMock('er4', {
  wg_instances: async () => {
    if (scenario('vpn-error')) throw new UbusError('er4', 'wg_instances', UBUS_STATUS.TIMEOUT)
    const net = mockUci.live.network
    // handshake times are on the router's clock (clock-behind scenario: 105 days back)
    const now = mockNow()
    const routerBorn = born - (Date.now() / 1000 - now)
    const out: Record<string, unknown> = {}
    for (const s of Object.values(net)) {
      if (s['.type'] !== 'interface' || s.proto !== 'wireguard' || s.disabled === '1') continue
      const iface = s['.name']
      const peers: Record<string, string | string[] | undefined>[] = []
      Object.values(net)
        .filter((p) => p['.type'] === `wireguard_${iface}` && p.disabled !== '1')
        .sort((a, b) => (a['.index'] ?? 0) - (b['.index'] ?? 0))
        .forEach((p, i) => {
          const pub = String(p.public_key ?? '')
          // index 0, 2: online; 1: stale (hours); 3: never; then repeating with variety
          const kind = i % 5 === 3 ? 'never' : i % 5 === 1 ? 'stale' : 'online'
          const rate = 1 + ((i * 7919) % 13)
          const up = Date.now() / 1000 - born
          // Real reply: every value is a string straight from `wg show all dump`
          peers.push({
            name: typeof p.description === 'string' ? p.description : undefined,
            public_key: pub,
            endpoint: kind === 'never' ? '(none)' : `198.51.100.${20 + i}:${41000 + i * 37}`,
            allowed_ips: list(p.allowed_ips),
            latest_handshake: String(kind === 'never' ? 0 : kind === 'stale' ? Math.round(routerBorn - 3600 * (2 + (i % 20)) - 600 * i) : Math.round(now - ((now + i * 17) % 115) - 3)),
            transfer_rx: String(kind === 'never' ? 0 : Math.round(rate * 4.1e7 + (kind === 'online' ? up * rate * 9000 : 0))),
            transfer_tx: String(kind === 'never' ? 0 : Math.round(rate * 3.3e8 + (kind === 'online' ? up * rate * 61000 : 0))),
            persistent_keepalive: typeof p.persistent_keepalive === 'string' ? p.persistent_keepalive : 'off',
          })
        })
      out[iface] = { name: iface, public_key: await serverPub(String(s.private_key ?? iface)), listen_port: String(s.listen_port ?? '0'), fwmark: 'off', peers }
    }
    return out
  },
  wg_keypair: async () => {
    if (canGenerateLocally()) {
      try { return { keys: await generateKeyPairLocal() } } catch { /* fall through */ }
    }
    return { keys: { priv: randomKey(), pub: randomKey() } }
  },
})

afterInit(() => {
  if (scenario('vpn-none')) editLive(({ network, firewall }) => {
    removeWhere(network, (s) => s['.name'] === 'wg0' || s['.type'] === 'wireguard_wg0')
    removeWhere(firewall, (s) => (s['.type'] === 'zone' && s.name === 'vpn') || (s['.type'] === 'forwarding' && (s.src === 'vpn' || s.dest === 'vpn')) || s.name === 'Allow-WireGuard')
  })

  if (scenario('vpn-empty')) editLive(({ network }) => removeWhere(network, (s) => s['.type'] === 'wireguard_wg0'))

  if (scenario('vpn-many')) editLive(({ network }) => {
    const names = ['ipad', 'work-laptop', 'tablet', 'pixel-8', 'steam-deck', 'phone-2', 'office-desktop', 'travel-router', 'backup-server',
      'smart-tv', 'macbook-air', 'chromebook', 'offsite-nas', 'car', 'watch', 'raspberrypi', 'kindle', 'android-tv', 'vm-lab', 'jetson', 'ci-runner', 'guest-1', 'guest-2', 'printer']
    names.forEach((n, i) => {
      network[`peer_m${i}`] = section('wireguard_wg0', `peer_m${i}`, {
        description: n, public_key: fakeKey(n), allowed_ips: [`10.200.0.${4 + i}/32`],
        ...(i % 4 === 0 ? { persistent_keepalive: '25' } : {}), ...(i % 9 === 8 ? { disabled: '1' } : {}),
        ...(i === 7 ? { allowed_ips: ['10.200.0.11/32', '192.168.77.0/24'], route_allowed_ips: '1', endpoint_host: 'travel.example.net', endpoint_port: '51820' } : {}),
      }, false)
    })
  })

  if (scenario('vpn-staged')) {
    stage.set('network', 'peer_laptop', { disabled: '1' })
    stage.add('network', 'wireguard_wg0', { description: 'tablet', public_key: fakeKey('tablet'), preshared_key: fakeKey('psk'), allowed_ips: ['10.200.0.4/32'], persistent_keepalive: '25' }, 'peer_tablet')
  }
})

// ---- Tailscale (er4.tailscale_*): logged out until "log in"; the login link is "visited" 3 s later.
// Scenario ts-none: not downloaded yet (tailscale_install takes 4 s). One release behind until
// "Update now" (5 s).
const ts = { enabled: false, running: false, loggedIn: false, loginAt: 0, routes: [] as string[], exit: false, accept: false, auto: true,
  installAt: 0, version: '1.104.1', updateAt: 0 }
const TS_LATEST = '1.106.0'
const tsVersion = () => {
  if (ts.updateAt && Date.now() - ts.updateAt > 5000) { ts.version = TS_LATEST; ts.updateAt = 0 }
  return { version: ts.version, latest: ts.version === TS_LATEST ? null : TS_LATEST, updating: !!ts.updateAt, update_log: ts.updateAt ? 'Downloaded 17532515/35908682 (48.8%)' : null }
}
const tsNode = (name: string, ip: string, os: string, online: boolean, extra: object = {}) => ({
  name, dns: `${name}.tail-example.ts.net`, ips: [ip, `fd7a:115c:a1e0::${ip.split('.')[3]}`], os, online, last_seen: online ? undefined : '2026-10-14T19:02:11Z',
  exit_node: false, exit_option: false, relay: 'fra', direct: online, rx: online ? 8_400_000 : 0, tx: online ? 1_200_000 : 0, routes: [], ...extra,
})
registerMock('er4', {
  tailscale_status: () => {
    if (scenario('ts-none') && !(ts.installAt && Date.now() - ts.installAt > 4000)) {
      return { installed: false, install: ts.installAt ? { state: 'downloading' } : null }
    }
    if (!ts.running) return { installed: true, enabled: ts.enabled, running: false, ...tsVersion() }
    if (!ts.loggedIn && ts.loginAt && Date.now() - ts.loginAt > 3000) ts.loggedIn = true
    if (!ts.loggedIn) return { installed: true, enabled: ts.enabled, running: true, ...tsVersion(), backend: 'NeedsLogin', auth_url: ts.loginAt ? 'https://login.tailscale.com/a/1a2b3c4d5e6f' : null, peers: [], self: null, prefs: null }
    return {
      installed: true, enabled: ts.enabled, running: true, ...tsVersion(), backend: 'Running', auth_url: null, tailnet: 'home@example.com', health: [],
      self: { ...tsNode('er4', '100.101.102.103', 'linux', true), routes: ts.routes, exit_option: ts.exit },
      peers: [tsNode('macbook', '100.88.12.4', 'macOS', true), tsNode('pixel-8', '100.92.7.31', 'android', false), tsNode('office-nas', '100.70.3.9', 'linux', true, { routes: ['10.50.0.0/24'] })],
      prefs: { routes: ts.routes, exit_node: ts.exit, accept_routes: ts.accept, use_exit_node: null, auto_update: ts.auto },
    }
  },
  tailscale_install: () => { if (!ts.installAt) ts.installAt = Date.now(); return {} },
  tailscale_update: () => { if (!ts.updateAt && ts.version !== TS_LATEST) ts.updateAt = Date.now(); return {} },
  tailscale_up: ({ routes, exit_node, accept_routes, auto_update }) => {
    if (!Array.isArray(routes) || routes.some((r) => !/^[0-9a-fA-F.:]+\/\d{1,3}$/.test(String(r)))) return { error: 'bad routes' }
    Object.assign(ts, { enabled: true, running: true, routes: routes.map(String), exit: !!exit_node, accept: !!accept_routes, auto: auto_update !== false })
    if (!ts.loggedIn) ts.loginAt = Date.now()
    return {}
  },
  tailscale_logout: ({ stop }) => {
    Object.assign(ts, { loggedIn: false, loginAt: 0 })
    if (stop) Object.assign(ts, { running: false, enabled: false })
    return {}
  },
})

// ---- IPsec (er4.ipsec_status / ipsec_cert): SAs follow the applied 'ipsec' config ------------
let ipsecCert: { host: string } | undefined
const MOCK_CA = '-----BEGIN CERTIFICATE-----\nMIIBXjCCAQSgAwIBAgIIMockCAforER4wCgYIKoZIzj0EAwIwFjEUMBIGA1UEAxML\nRVItNCBWUE4gQ0EwHhcNMjYxMDE1MDAwMDAwWhcNMzYxMDEyMDAwMDAwWjAWMRQw\n-----END CERTIFICATE-----\n'
registerMock('er4', {
  ipsec_status: () => {
    const cfg = mockUci.live.ipsec ?? {}
    const sas: object[] = []
    const users = Object.values(cfg).filter((s) => s['.type'] === 'mschapv2_secrets').map((s) => String(s.id))
    if (cfg.rw && users.length) sas.push({ name: 'rw', state: 'ESTABLISHED', remote_host: '198.51.100.44', remote_id: users[0], eap_id: users[0], vips: ['10.201.0.1'], established: 640, encr: 'AES_GCM_16', dh: 'ECP_256',
      children: [{ name: 'rw_net', state: 'INSTALLED', local_ts: list(cfg.rw_net?.local_subnet), remote_ts: ['10.201.0.1/32'], bytes_in: 5_400_000, bytes_out: 61_000_000, encr: 'AES_GCM_16' }] })
    for (const r of Object.values(cfg).filter((s) => s['.type'] === 'remote' && s['.name'] !== 'rw')) {
      const t = cfg[`${r['.name']}_net`]
      sas.push({ name: r['.name'], state: 'ESTABLISHED', remote_host: String(r.gateway), remote_id: String(r.gateway), vips: [], established: 3600, encr: 'AES_GCM_16', dh: 'ECP_256',
        children: [{ name: `${r['.name']}_net`, state: 'INSTALLED', local_ts: list(t?.local_subnet), remote_ts: list(t?.remote_subnet), bytes_in: 120_000, bytes_out: 98_000 }] })
    }
    return { installed: true, running: true, sas, ca: ipsecCert ? MOCK_CA : null,
      server: ipsecCert ? { subject: `CN=${ipsecCert.host}`, san: [ipsecCert.host], not_after: 'Oct 14 00:00:00 2031' } : null }
  },
  ipsec_cert: ({ name }) => {
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(name)) return { error: 'a host name or IPv4 address' }
    ipsecCert = { host: name }
    return {}
  },
})
