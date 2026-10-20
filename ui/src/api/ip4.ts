// IPv4 helpers shared by the firewall and VPN pages (subnet membership, next free address).
// (The Network/Devices model is api/net.ts.)
import type { UciConfig, UciValue } from './types'

export function ip4(s: string): number | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.trim())
  if (!m) return undefined
  const o = m.slice(1).map(Number)
  if (o.some((x) => x > 255)) return undefined
  return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3]
}

export const ip4str = (n: number) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.')

export function maskBits(prefix: number) {
  return prefix <= 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
}

export function netmaskToPrefix(mask: string): number {
  const n = ip4(mask)
  if (n === undefined) return 24
  let p = 0
  for (let b = 31; b >= 0 && (n >>> b) & 1; b--) p++
  return p
}

export interface Subnet { addr: number; prefix: number; network: number }

/** "10.200.0.1/24" -> { addr, prefix, network } */
export function cidr(s: string): Subnet | undefined {
  const [a, p] = s.split('/')
  const addr = ip4(a)
  const prefix = p === undefined ? 32 : Number(p)
  if (addr === undefined || !(prefix >= 0 && prefix <= 32)) return undefined
  return { addr, prefix, network: (addr & maskBits(prefix)) >>> 0 }
}

export function inSubnet(ip: string, subnet: { network: number; prefix: number }) {
  const n = ip4(ip.split('/')[0])
  return n !== undefined && ((n & maskBits(subnet.prefix)) >>> 0) === subnet.network
}

export const cidrStr = (c: { network: number; prefix: number }) => `${ip4str(c.network)}/${c.prefix}`

/** UCI option (string or list) as a list; "a b" strings split like fw4 does for list-ish options. */
export function list(v: UciValue | boolean | number | undefined): string[] {
  if (v === undefined || v === null || typeof v === 'boolean' || typeof v === 'number') return []
  return (Array.isArray(v) ? v : v.split(/\s+/)).filter(Boolean)
}

/** IPv4 subnets of static interfaces in UCI network: { lan: 192.168.1.0/24, wg0: 10.200.0.0/24 ... } */
export function interfaceSubnets(net: UciConfig): Record<string, Subnet> {
  const out: Record<string, Subnet> = {}
  for (const s of Object.values(net)) {
    if (s['.type'] !== 'interface') continue
    if (typeof s.ipaddr === 'string') {
      const c = cidr(s.ipaddr.includes('/') ? s.ipaddr : `${s.ipaddr}/${netmaskToPrefix(String(s.netmask ?? '255.255.255.0'))}`)
      if (c) out[s['.name']] = c
    } else {
      const a = list(s.addresses).map(cidr).find(Boolean)
      if (a) out[s['.name']] = a
    }
  }
  return out
}
