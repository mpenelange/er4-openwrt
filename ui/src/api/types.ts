// Shapes of the ubus replies the UI uses. Router-side sources:
//   system.board / system.info        rpcd built-in
//   network.interface.dump            netifd
//   network.device.status             netifd
//   luci-rpc.getDHCPLeases            luci-base (rpcd-mod-luci)
//   uci.*                             rpcd built-in (apply with rollback + confirm)
//   er4.stats / er4.offload           ER-4 rpcd plugin (openwrt/package/utils/er4-ui, see ui/README.md)

export interface BoardInfo {
  hostname: string
  model: string
  board_name: string
  kernel: string
  release: { distribution: string; version: string; revision: string; description: string }
}

export interface SystemInfo {
  uptime: number
  localtime: number
  load: [number, number, number] // x65536, as the kernel reports
  memory: { total: number; free: number; shared: number; buffered: number; available: number; cached: number }
  root: { total: number; free: number; used: number; avail: number }
  tmp?: { total: number; free: number; used: number; avail: number }
}

export interface IfaceAddr { address: string; mask: number }
export interface NetInterface {
  interface: string
  up: boolean
  pending: boolean
  available: boolean
  proto: string
  device?: string
  l3_device?: string
  uptime?: number
  // netifd leaves these out while the interface is down
  'ipv4-address'?: IfaceAddr[]
  'ipv6-address'?: IfaceAddr[]
  /** delegated prefixes (dhcpv6, from the ISP) */
  'ipv6-prefix'?: IfaceAddr[]
  /** this network's slice of a delegated prefix (ip6assign); local-address is the router's */
  'ipv6-prefix-assignment'?: (IfaceAddr & { 'local-address'?: IfaceAddr })[]
  route?: { target: string; mask: number; nexthop: string }[]
  /** false after an ifdown: stays down until started again */
  autostart?: boolean
  /** e.g. [{subsystem: 'pppoe', code: 'AUTH_FAILED'}] */
  errors?: { subsystem?: string; code: string }[]
  'dns-server'?: string[]
  data?: Record<string, unknown>
}

export interface DeviceStatus {
  type: string // "Network device" | "bridge" | "VLAN"
  up: boolean
  carrier: boolean
  speed?: string // e.g. "1000F", "100F", "-1"
  macaddr: string
  mtu: number
  'bridge-members'?: string[]
  /** from the PHY (ethtool), on ports whose driver reports it */
  autoneg?: boolean
  'link-advertising'?: string[]
  'link-partner-advertising'?: string[]
  'flow-control'?: { autoneg?: boolean; negotiated?: string[] }
  statistics: {
    rx_bytes: number; tx_bytes: number; rx_packets: number; tx_packets: number
    rx_dropped: number; tx_dropped: number; rx_errors: number; tx_errors: number; multicast: number
    rx_crc_errors?: number; rx_frame_errors?: number; rx_length_errors?: number; rx_missed_errors?: number
    rx_over_errors?: number; rx_fifo_errors?: number; tx_carrier_errors?: number; collisions?: number
  }
}

export interface DhcpLease {
  hostname?: string
  ipaddr: string
  macaddr: string
  expires: number // seconds left, -1 = static
}

/** luci-rpc getDHCPLeases dhcp6_leases (odhcpd): macaddr only when the DUID carries one */
export interface Dhcp6Lease {
  hostname?: string
  duid: string
  iaid?: string
  macaddr?: string
  ip6addr?: string
  ip6addrs?: string[]
  expires: number // seconds left; 0 = static
}

// er4.stats: one sample of everything the dashboard plots; rates come from deltas
export interface Er4Stats {
  time: number // ms since epoch, router clock
  cpu: { total: number[]; idle: number[] } // jiffies per core (cumulative), from /proc/stat
  ports: Record<string, { rx_bytes: number; tx_bytes: number; rx_packets: number; tx_packets: number; rx_dropped: number; tx_dropped: number }>
  offload: { flow_found: number; flow_not_found: number; invalidations: number }
  conntrack: { count: number; max: number }
}

export interface Er4Offload {
  loaded: boolean
  ipv4: boolean
  ipv6: boolean
  vlan: boolean
  pppoe: boolean
  stats: boolean
  cache_size: number
  fwd_queue_depth: number
}

// uci
export type UciValue = string | string[]
export interface UciSection {
  '.anonymous': boolean
  '.type': string
  '.name': string
  '.index'?: number
  [option: string]: UciValue | boolean | number | undefined
}
export type UciConfig = Record<string, UciSection>
// uci.changes: per config, a list of [op, section, option?, value?]
export type UciChange = [string, string, string?, UciValue?]
export type UciChanges = Record<string, UciChange[]>
