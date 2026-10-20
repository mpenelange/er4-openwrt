// Firewall page mock. Router calls used by pages/firewall (all exist on the real router):
//   uci.get/set/add/delete/order 'firewall'   rpcd built-in (order: rpcd uci "order", core mock)
//   uci.get 'network', 'dhcp'                  rpcd built-in (zone networks, static hosts)
//   luci-rpc.getDHCPLeases                     luci-base (device picker)
//   er4.firewall_status                        hit counters per rule name + the nft ruleset text
// The "slow path" badge is derived from the rule's own options.
//
// Scenarios (?scenario=... or #/firewall/?scenario=...):
//   fw-many    7 zones, ~40 rules (some slow path / disabled), 16 port forwards
//   fw-empty   only lan + wan zones, no forwardings, rules or port forwards
//   fw-error   uci.get firewall fails (ubus timeout)
//   fw-staged  starts with unapplied changes (rule toggled, new rule, new forwarding, reorder)
import { UBUS_STATUS, UbusError } from '../../ubus'
import { mockUci, objects, registerMock } from '../registry'
import { afterInit, editLive, removeWhere, scenario, section, stage } from '../scenario'

afterInit(() => {
  if (scenario('fw-many')) editLive(({ firewall, network, dhcp }) => {
    const nets: [string, string][] = [['guest', '192.168.40.1'], ['dmz', '192.168.50.1'], ['mgmt', '10.10.0.1']]
    for (const [n, ip] of nets) network[n] = section('interface', n, { device: `br-lan.${ip.split('.')[2]}`, proto: 'static', ipaddr: ip, netmask: '255.255.255.0' }, false)
    firewall.zg = section('zone', 'zg', { name: 'guest', network: ['guest'], input: 'REJECT', output: 'ACCEPT', forward: 'REJECT' })
    firewall.zd = section('zone', 'zd', { name: 'dmz', network: ['dmz'], input: 'REJECT', output: 'ACCEPT', forward: 'REJECT' })
    firewall.zm = section('zone', 'zm', { name: 'mgmt', network: ['mgmt'], input: 'ACCEPT', output: 'ACCEPT', forward: 'ACCEPT' })
    const fw = [['guest', 'wan'], ['dmz', 'wan'], ['mgmt', 'lan'], ['mgmt', 'dmz'], ['lan', 'dmz'], ['vpn', 'wan'], ['lan', 'iot']]
    fw.forEach(([src, dest], i) => { firewall[`fwm${i}`] = section('forwarding', `fwm${i}`, { src, dest }) })
    const R = (o: Record<string, string>) => o
    const rules = [
      R({ name: 'Allow-DHCPv6', src: 'wan', proto: 'udp', dest_port: '546', family: 'ipv6', target: 'ACCEPT' }),
      R({ name: 'Allow-MLD', src: 'wan', proto: 'icmp', src_ip: 'fe80::/10', icmp_type: '130/0 131/0 132/0 143/0', family: 'ipv6', target: 'ACCEPT' }),
      R({ name: 'Allow-ICMPv6-Input', src: 'wan', proto: 'icmp', icmp_type: 'echo-request echo-reply destination-unreachable packet-too-big time-exceeded', limit: '1000/sec', family: 'ipv6', target: 'ACCEPT' }),
      R({ name: 'Guest-DNS', src: 'guest', proto: 'tcp udp', dest_port: '53', target: 'ACCEPT' }),
      R({ name: 'Guest-DHCP', src: 'guest', proto: 'udp', dest_port: '67-68', target: 'ACCEPT' }),
      R({ name: 'Block-Guest-LAN', src: 'guest', dest: 'lan', proto: 'all', target: 'REJECT' }),
      R({ name: 'Block-IoT-LAN', src: 'iot', dest: 'lan', proto: 'all', target: 'DROP' }),
      R({ name: 'IoT-NTP', src: 'iot', dest: 'wan', proto: 'udp', dest_port: '123', target: 'ACCEPT' }),
      R({ name: 'Log-IoT-Cloud', src: 'iot', dest: 'wan', proto: 'tcp', dest_port: '8883', log: '1', target: 'ACCEPT' }),
      R({ name: 'SSH-Brute-Limit', src: 'wan', proto: 'tcp', dest_port: '22', limit: '6/minute', limit_burst: '10', target: 'ACCEPT', enabled: '0' }),
      R({ name: 'DMZ-Web', src: 'wan', dest: 'dmz', dest_ip: '192.168.50.10', proto: 'tcp', dest_port: '80 443', target: 'ACCEPT' }),
      R({ name: 'DMZ-No-LAN', src: 'dmz', dest: 'lan', proto: 'all', target: 'REJECT' }),
      R({ name: 'Mgmt-SNMP', src: 'mgmt', proto: 'udp', dest_port: '161', src_ip: '10.10.0.0/24', target: 'ACCEPT' }),
      R({ name: 'Torrent-Quota', src: 'lan', dest: 'wan', src_ip: '192.168.1.140', proto: 'tcp udp', extra: '-m quota --quota 50000000000', target: 'ACCEPT' }),
      R({ name: 'Kids-Night-Block', src: 'lan', dest: 'wan', src_mac: 'aa:bb:cc:00:11:22', proto: 'all', target: 'REJECT', enabled: '0' }),
      R({ name: 'Block-Telnet-Out', src: 'lan', dest: 'wan', proto: 'tcp', dest_port: '23', target: 'REJECT' }),
      R({ name: 'Allow-IPSec-ESP', src: 'wan', dest: 'lan', proto: 'esp', target: 'ACCEPT' }),
      R({ name: 'Allow-ISAKMP', src: 'wan', dest: 'lan', proto: 'udp', dest_port: '500', target: 'ACCEPT' }),
      R({ name: 'VPN-to-IoT', src: 'vpn', dest: 'iot', proto: 'tcp', dest_port: '80 443 1883', target: 'ACCEPT' }),
      R({ name: 'Drop-SMB-WAN', src: 'lan', dest: 'wan', proto: 'tcp', dest_port: '137-139 445', target: 'DROP' }),
      R({ name: 'Ping-Limit', src: 'wan', proto: 'icmp', icmp_type: 'echo-request', limit: '10/sec', target: 'ACCEPT', family: 'ipv4' }),
      R({ name: 'Mail-Out', src: 'dmz', dest: 'wan', proto: 'tcp', dest_port: '25 465 587', target: 'ACCEPT' }),
      R({ name: 'Mark-VoIP', src: 'lan', dest: 'wan', proto: 'udp', dest_port: '5060 10000-20000', set_mark: '0x10', target: 'MARK' }),
      R({ name: 'Guest-Rate-Limit', src: 'guest', dest: 'wan', proto: 'all', limit: '2000/sec', target: 'ACCEPT' }),
      R({ name: 'Mgmt-HTTPS', src: 'lan', dest: 'mgmt', proto: 'tcp', dest_port: '443 8443', src_ip: '192.168.1.117', target: 'ACCEPT' }),
      R({ name: 'Router-NTP-Out', dest: 'wan', proto: 'udp', dest_port: '123', target: 'ACCEPT' }),
      R({ name: 'Block-QUIC', src: 'guest', dest: 'wan', proto: 'udp', dest_port: '443', target: 'REJECT', enabled: '0' }),
      R({ name: 'Plex-Remote', src: 'wan', dest: 'lan', dest_ip: '192.168.1.20', proto: 'tcp', dest_port: '32400', target: 'ACCEPT' }),
      R({ name: 'Any-to-DMZ-Log', src: '*', dest: 'dmz', proto: 'all', log: '1', target: 'DROP' }),
      R({ name: 'mDNS-IoT', src: 'iot', proto: 'udp', dest_port: '5353', dest_ip: '224.0.0.251', target: 'ACCEPT' }),
      R({ name: 'Block-DoT', src: 'lan', dest: 'wan', proto: 'tcp', dest_port: '853', target: 'REJECT' }),
      R({ name: 'Game-UPnP-Range', src: 'wan', dest: 'lan', proto: 'udp', dest_port: '3074 3478-3480', dest_ip: '192.168.1.42', target: 'ACCEPT' }),
      R({ name: 'Doorbell-RTSP', src: 'lan', dest: 'iot', dest_ip: '192.168.30.102', proto: 'tcp', dest_port: '554', target: 'ACCEPT' }),
      R({ name: 'Drop-Invalid-Bogons', src: 'wan', src_ip: '10.0.0.0/8 172.16.0.0/12', proto: 'all', target: 'DROP' }),
    ]
    rules.forEach((r, i) => { firewall[`rm${i}`] = section('rule', `rm${i}`, r) })
    const hosts = [['nas', '192.168.1.20'], ['gaming-pc', '192.168.1.42'], ['webserver', '192.168.50.10'], ['mail', '192.168.50.11'], ['cam-front', '192.168.30.120']]
    hosts.slice(2).forEach(([name, ip], i) => { dhcp[`hm${i}`] = section('host', `hm${i}`, { name, ip, mac: `02:00:00:00:00:0${i}` }) })
    const fwds: [string, string, string, string, string?, string?][] = [
      ['Web HTTP', '80', 'dmz', '192.168.50.10', 'tcp'], ['Web HTTPS', '443', 'dmz', '192.168.50.10', 'tcp'],
      ['Mail SMTP', '25', 'dmz', '192.168.50.11', 'tcp'], ['Mail IMAPS', '993', 'dmz', '192.168.50.11', 'tcp'],
      ['NAS SSH', '2222', 'lan', '192.168.1.20', 'tcp', '22'], ['Plex', '32400', 'lan', '192.168.1.20', 'tcp'],
      ['Minecraft', '25565', 'lan', '192.168.1.42', 'tcp'], ['Xbox Live', '3074', 'lan', '192.168.1.42', 'tcp udp'],
      ['Valheim', '2456-2458', 'lan', '192.168.1.42', 'udp'], ['Camera RTSP', '8554', 'iot', '192.168.30.120', 'tcp', '554'],
      ['RDP (old)', '3389', 'lan', '192.168.1.117', 'tcp'], ['Home Assistant', '8123', 'lan', '192.168.1.152', 'tcp'],
      ['Syncthing', '22000', 'lan', '192.168.1.20', 'tcp udp'], ['Factorio', '34197', 'lan', '192.168.1.42', 'udp'],
    ]
    fwds.forEach(([name, ext, dest, ip, proto, port], i) => {
      firewall[`pm${i}`] = section('redirect', `pm${i}`, { name, src: 'wan', src_dport: ext, dest, dest_ip: ip, proto: proto ?? 'tcp', target: 'DNAT', ...(port ? { dest_port: port } : {}), ...(i === 10 ? { enabled: '0' } : {}) })
    })
  })

  if (scenario('fw-empty')) editLive(({ firewall }) => {
    removeWhere(firewall, (s) => ['rule', 'redirect', 'forwarding'].includes(s['.type']) || (s['.type'] === 'zone' && !['lan', 'wan'].includes(String(s.name))))
  })

  if (scenario('fw-error')) {
    const get = objects.uci.get
    objects.uci.get = (args) => {
      if (args.config === 'firewall') throw new UbusError('uci', 'get', UBUS_STATUS.TIMEOUT)
      return get(args)
    }
  }

  if (scenario('fw-staged')) {
    stage.set('firewall', 'cfg0a92bd', { enabled: '0' })
    stage.add('firewall', 'rule', { name: 'Block-IoT-LAN', src: 'iot', dest: 'lan', proto: 'all', target: 'DROP' })
    stage.add('firewall', 'forwarding', { src: 'vpn', dest: 'wan' })
    stage.set('firewall', 'cfg0e3c3e', { enabled: '1' })
  }
})

// ---- er4.firewall_status: what fw4 loaded (applied config only, like the router) ----------------
const hash = (t: string) => [...t].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)
registerMock('er4', {
  firewall_status: () => {
    const fw = mockUci.live.firewall ?? {}
    const counters: Record<string, { packets: number; bytes: number }> = {}
    const lines = ['table inet fw4 {']
    const zones = Object.values(fw).filter((x) => x['.type'] === 'zone')
    for (const z of zones) {
      const n = String(z.name)
      lines.push(`\tchain input_${n} {`, `\t\tjump ${String(z.input ?? 'REJECT').toLowerCase()}_from_${n} comment "!fw4: Handle ${n} IPv4/IPv6 input traffic"`, '\t}')
    }
    for (const x of Object.values(fw)) {
      if (!['rule', 'redirect', 'nat'].includes(x['.type']) || x.enabled === '0') continue
      const name = String(x.name ?? x['.name'])
      const h = hash(name)
      // a few rules never matched; the rest have plausible counts (DHCP renewals, pings, …)
      const packets = h % 5 === 0 ? 0 : (h % 9000) + 3
      counters[name] = { packets, bytes: packets * (60 + (h % 900)) }
      const chain = x['.type'] === 'rule' ? `${x.dest ? 'forward' : 'input'}_${x.src ?? 'lan'}` : x['.type'] === 'nat' ? `srcnat_${x.src ?? 'wan'}` : `dstnat_${x.src ?? 'wan'}`
      lines.push(`\tchain ${chain} {`, `\t\t${x.proto ? `meta l4proto ${String(x.proto).replace(' ', ', ')} ` : ''}${x.dest_port ? `th dport ${x.dest_port} ` : ''}counter packets ${packets} bytes ${counters[name].bytes} ${String(x.target ?? 'accept').toLowerCase()} comment "!fw4: ${name}"`, '\t}')
    }
    lines.push('}')
    return { ruleset: lines.join('\n'), counters }
  },
})
