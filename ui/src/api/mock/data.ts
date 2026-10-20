// Mock router state, modelled on the lab ER-4 running the source-built OpenWrt image
// (eth0 = WAN, eth1-eth3 = LAN bridge, eth3 = SFP; fw4 defaults; offload on).
import type { UciConfig, UciSection } from '../types'

let idx = 0
function s(type: string, name: string, opts: Record<string, string | string[]> = {}, anonymous = false): [string, UciSection] {
  return [name, { '.anonymous': anonymous, '.type': type, '.name': name, '.index': idx++, ...opts }]
}
function config(...sections: [string, UciSection][]): UciConfig {
  idx = 0
  return Object.fromEntries(sections)
}

export function initialUci(): Record<string, UciConfig> {
  return {
    system: config(
      s('system', 'cfg01e48a', { hostname: 'er4', timezone: 'UTC', zonename: 'UTC', log_size: '128' }, true),
      s('timeserver', 'ntp', { enabled: '1', server: ['0.openwrt.pool.ntp.org', '1.openwrt.pool.ntp.org'] }),
    ),
    dropbear: config(
      s('dropbear', 'main', { enable: '1', PasswordAuth: 'on', RootPasswordAuth: 'on', Port: '22' }),
    ),
    // strongswan-swanctl's /etc/config/ipsec ships with comments only
    ipsec: config(),
    network: config(
      s('interface', 'loopback', { device: 'lo', proto: 'static', ipaddr: '127.0.0.1', netmask: '255.0.0.0' }),
      s('globals', 'globals', { ula_prefix: 'fd3c:6a1e:9b20::/48', packet_steering: '0' }),
      s('device', 'cfg030f15', { name: 'br-lan', type: 'bridge', ports: ['eth1', 'eth2', 'eth3'] }, true),
      s('interface', 'lan', { device: 'br-lan', proto: 'static', ipaddr: '192.168.1.1', netmask: '255.255.255.0', ip6assign: '60' }),
      s('interface', 'wan', { device: 'eth0', proto: 'dhcp' }),
      s('interface', 'wan6', { device: 'eth0', proto: 'dhcpv6' }),
      s('device', 'iot_dev', { type: '8021q', ifname: 'br-lan', vid: '30', name: 'br-lan.30' }),
      s('interface', 'iot', { device: 'br-lan.30', proto: 'static', ipaddr: '192.168.30.1', netmask: '255.255.255.0' }),
      s('interface', 'wg0', { proto: 'wireguard', private_key: 'mock-private-key-not-real=', listen_port: '51820', addresses: ['10.200.0.1/24'] }),
      s('wireguard_wg0', 'peer_phone', { description: 'phone', public_key: 'pHoNe0mockPublicKeyAAAAAAAAAAAAAAAAAAAAAAAA=', allowed_ips: ['10.200.0.2/32'], persistent_keepalive: '25' }),
      s('wireguard_wg0', 'peer_laptop', { description: 'laptop', public_key: 'LaPToP0mockPublicKeyAAAAAAAAAAAAAAAAAAAAAAA=', allowed_ips: ['10.200.0.3/32'] }),
    ),
    firewall: config(
      s('defaults', 'cfg01e63d', { syn_flood: '1', input: 'REJECT', output: 'ACCEPT', forward: 'REJECT' }, true),
      s('zone', 'cfg02dc81', { name: 'lan', network: ['lan'], input: 'ACCEPT', output: 'ACCEPT', forward: 'ACCEPT' }, true),
      s('zone', 'cfg03dc81', { name: 'wan', network: ['wan', 'wan6'], input: 'REJECT', output: 'ACCEPT', forward: 'REJECT', masq: '1', mtu_fix: '1' }, true),
      s('zone', 'cfg04dc81', { name: 'iot', network: ['iot'], input: 'REJECT', output: 'ACCEPT', forward: 'REJECT' }, true),
      s('zone', 'cfg05dc81', { name: 'vpn', network: ['wg0'], input: 'ACCEPT', output: 'ACCEPT', forward: 'ACCEPT' }, true),
      s('forwarding', 'cfg06ad58', { src: 'lan', dest: 'wan' }, true),
      s('forwarding', 'cfg07ad58', { src: 'iot', dest: 'wan' }, true),
      s('forwarding', 'cfg08ad58', { src: 'vpn', dest: 'lan' }, true),
      s('rule', 'cfg0992bd', { name: 'Allow-DHCP-Renew', src: 'wan', proto: 'udp', dest_port: '68', target: 'ACCEPT', family: 'ipv4' }, true),
      s('rule', 'cfg0a92bd', { name: 'Allow-Ping', src: 'wan', proto: 'icmp', icmp_type: 'echo-request', family: 'ipv4', target: 'ACCEPT' }, true),
      s('rule', 'cfg0b92bd', { name: 'Allow-WireGuard', src: 'wan', proto: 'udp', dest_port: '51820', target: 'ACCEPT' }, true),
      s('rule', 'cfg0c92bd', { name: 'IoT-DNS-DHCP', src: 'iot', proto: 'tcp udp', dest_port: '53 67', target: 'ACCEPT' }, true),
      s('redirect', 'cfg0d3c3e', { name: 'NAS HTTPS', src: 'wan', src_dport: '443', dest: 'lan', dest_ip: '192.168.1.20', dest_port: '443', proto: 'tcp', target: 'DNAT' }, true),
      s('redirect', 'cfg0e3c3e', { name: 'Game server', src: 'wan', src_dport: '27015', dest: 'lan', dest_ip: '192.168.1.42', proto: 'tcp udp', target: 'DNAT', enabled: '0' }, true),
    ),
    dhcp: config(
      s('dnsmasq', 'cfg01411c', { domainneeded: '1', localise_queries: '1', local: '/lan/', domain: 'lan', expandhosts: '1', authoritative: '1', leasefile: '/tmp/dhcp.leases', rebind_protection: '1', rebind_localhost: '1', server: ['/corp.example/10.8.0.1'] }, true),
      s('dhcp', 'lan', { interface: 'lan', start: '100', limit: '150', leasetime: '12h', dhcpv4: 'server', ra: 'server', dhcpv6: 'server', ra_flags: ['managed-config', 'other-config'] }),
      s('dhcp', 'iot', { interface: 'iot', start: '100', limit: '100', leasetime: '24h' }),
      s('dhcp', 'wan', { interface: 'wan', ignore: '1' }),
      s('host', 'cfg05fe2b', { name: 'nas', mac: '02:00:00:12:aa:01', ip: '192.168.1.20' }, true),
      s('host', 'cfg06fe2b', { name: 'gaming-pc', mac: '02:00:00:9b:10:42', ip: '192.168.1.42' }, true),
      s('domain', 'cfg07f37c', { name: 'printer', ip: '192.168.1.50' }, true),
      s('domain', 'cfg08f37c', { name: 'homeassistant', ip: '192.168.30.20' }, true),
      s('cname', 'cfg09a1b2', { cname: 'files', target: 'nas' }, true),
    ),
    offload: config(
      s('offload', 'global', { enabled: '1', ipv4: '1', ipv6: '0', vlan: '1', pppoe: '0', stats: '1' }),
    ),
  }
}

export const leases = [
  { hostname: 'nas', ipaddr: '192.168.1.20', macaddr: '02:00:00:12:aa:01', expires: -1 },
  { hostname: 'gaming-pc', ipaddr: '192.168.1.42', macaddr: '02:00:00:9b:10:42', expires: -1 },
  { hostname: 'study-laptop', ipaddr: '192.168.1.117', macaddr: '02:00:00:0c:7e:19', expires: 38811 },
  { hostname: 'iphone', ipaddr: '192.168.1.131', macaddr: '6a:91:2e:dd:04:5c', expires: 21004 },
  { hostname: 'living-room-tv', ipaddr: '192.168.1.140', macaddr: '02:00:00:fe:22:9d', expires: 40120 },
  { ipaddr: '192.168.1.152', macaddr: '02:00:00:44:19:a2', expires: 3301 },
  { hostname: 'thermostat', ipaddr: '192.168.30.101', macaddr: '02:00:00:5a:61:07', expires: 80211 },
  { hostname: 'doorbell', ipaddr: '192.168.30.102', macaddr: '02:00:00:01:9e:33', expires: 77002 },
  { hostname: 'plug-kitchen', ipaddr: '192.168.30.110', macaddr: '02:00:00:aa:bb:10', expires: 65550 },
]

export const ports = {
  eth0: { mac: '02:00:00:00:00:10', speed: '1000F', carrier: true },
  eth1: { mac: '02:00:00:00:00:11', speed: '1000F', carrier: true },
  eth2: { mac: '02:00:00:00:00:12', speed: '1000F', carrier: true },
  eth3: { mac: '02:00:00:00:00:13', speed: '1000F', carrier: true },
} as const
