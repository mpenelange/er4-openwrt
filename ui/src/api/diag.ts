// Diagnostics: logs, routing tables and the tools the router runs for you (er4 plugin).
//   er4.log {source: 'system'|'kernel', lines}  -> {source, boot, lines: [LogLine]}
//   er4.routes {}                              -> {ipv4: [IpRoute], ipv6: [IpRoute], neigh: [IpNeigh]} (`ip -j`)
//   er4.diag_start {tool, host, family?, count?, server?} -> {id} | {error}
//   er4.diag_poll {id}                         -> {output, done, code} | {error}
//   er4.diag_stop {id}                         -> {}
//   er4.conntrack {limit}                      -> {count, max, flows: [Conn]} (conntrack -L, netlink)
//   er4.wan_health {window}                    -> {step, target, running, samples, events} (er4-wanmon)
//   er4.processes / er4.kill {pid, signal}     -> {processes: [Proc]} / {} | {error}
//   er4.capture_start {iface, filter, seconds, packets} / capture_status / capture_stop  (tcpdump to /tmp)
// Tools run in the background on the router (rpcd is single-threaded); poll for output.
import { api, isMock } from './client'
import { sessionId } from './system'

export type LogSource = 'system' | 'kernel' | 'saved'
export type LogLevel = 'emerg' | 'alert' | 'crit' | 'err' | 'warn' | 'notice' | 'info' | 'debug'

export interface LogLine {
  /** unix seconds (system log) */
  time?: number
  /** seconds since boot (kernel log) */
  uptime?: number
  facility?: string
  level?: LogLevel | null
  tag?: string | null
  msg: string
}

export interface LogReply { source: LogSource; boot: number; lines: LogLine[] }

export interface IpRoute {
  type?: string
  dst: string
  gateway?: string
  dev?: string
  protocol?: string
  scope?: string
  prefsrc?: string
  metric?: number
  table?: string
  flags?: string[]
  pref?: string
}

export interface IpNeigh { dst: string; dev: string; lladdr?: string; router?: null; state?: string[] }

export interface RoutesReply { ipv4: IpRoute[]; ipv6: IpRoute[]; neigh: IpNeigh[] }

/** One conntrack entry; reply_* is the other direction (with NAT, reply_dst is the router's address). */
export interface Conn {
  family: 4 | 6
  proto: string
  state?: string
  /** seconds until the entry expires */
  timeout: number
  src: string; dst: string; sport?: number; dport?: number
  reply_src: string; reply_dst: string; reply_sport?: number; reply_dport?: number
  /** with net.netfilter.nf_conntrack_acct=1 only */
  bytes?: number; packets?: number; reply_bytes?: number; reply_packets?: number
  flags: string[]
  mark?: string
  /** conntrack helper (ftp, sip…): such flows stay on the CPU */
  helper?: string
  /** the direction(s) in the hardware offload's flow cache right now; age in ms since learned */
  offload?: { orig?: OffloadDir; reply?: OffloadDir }
}
export interface OffloadDir { in: string; out: string; age: number }
/** offload: null when the offload module isn't loaded (no per-flow state) */
export interface ConntrackReply { count: number; max: number; offload?: { ipv4: boolean; ipv6: boolean } | null; flows: Conn[] }

/** Why a connection isn't in the offload flow cache, as far as the router can tell (null: it is). */
export function slowPathReason(c: Conn, off: ConntrackReply['offload'], local: (ip: string) => boolean): string | null {
  if (c.offload?.orig || c.offload?.reply) return null
  if (!off) return 'Hardware offload is off'
  if (!(c.family === 6 ? off.ipv6 : off.ipv4)) return `IPv${c.family} offload is off`
  if (local(c.dst) || local(c.src)) return 'To or from the router itself: never offloaded'
  if (c.proto !== 'tcp' && c.proto !== 'udp') return 'Only TCP and UDP are offloaded'
  if (c.helper) return `Uses the ${c.helper} helper: stays on the CPU`
  if (c.proto === 'tcp' && c.state !== 'ESTABLISHED') return 'TCP is offloaded once established'
  if (c.flags.includes('UNREPLIED')) return 'No reply yet'
  return 'Idle for over ~16 s, or a firewall rule that inspects every packet (limit, log, …) keeps it on the CPU'
}

/** One bucket of er4-wanmon samples: mean RTT of the replies (null: none), loss 0..1. */
export interface WanSample { t: number; gw_rtt: number | null; gw_loss: number; inet_rtt: number | null; inet_loss: number }
export interface WanHealth { step: number; target: string; running: boolean; samples: WanSample[]; events: { t: number; action: string; iface: string }[] }

export type Tool = 'ping' | 'traceroute' | 'nslookup'
export interface ToolArgs { tool: Tool; host: string; family?: 4 | 6; count?: number; server?: string }
export interface ToolPoll { output: string; done: boolean; code: number | null }

const SEVERITY: LogLevel[] = ['emerg', 'alert', 'crit', 'err', 'warn', 'notice', 'info', 'debug']
/** 0 (emerg) .. 7 (debug); lines without a level count as info. */
export const severity = (l?: LogLevel | null) => (l ? SEVERITY.indexOf(l) : 6)

/** Same rules as the router (er4.uc host_ok): a name or an address, never an option. */
export const hostOk = (h: string) => /^[A-Za-z0-9][A-Za-z0-9.:_-]{0,252}$/.test(h)

async function checked<T>(p: Promise<T | { error: string }>): Promise<T> {
  const r = await p
  if (r && typeof r === 'object' && 'error' in r) throw new Error(r.error)
  return r as T
}

export const diag = {
  log: (source: LogSource, lines = 1000) => checked(api.call<LogReply | { error: string }>('er4', 'log', { source, lines })),
  routes: () => api.call<RoutesReply>('er4', 'routes'),
  start: (a: ToolArgs) => checked(api.call<{ id: string } | { error: string }>('er4', 'diag_start', { ...a })),
  poll: (id: string) => checked(api.call<ToolPoll | { error: string }>('er4', 'diag_poll', { id })),
  stop: (id: string) => api.call('er4', 'diag_stop', { id }),
  conntrack: (limit = 2000) => api.call<ConntrackReply>('er4', 'conntrack', { limit }),
  wanHealth: (window: 3600 | 86400) => api.call<WanHealth>('er4', 'wan_health', { window }),
  processes: () => api.call<{ processes: Proc[] }>('er4', 'processes').then((r) => r.processes),
  kill: (pid: number, signal: 'HUP' | 'TERM' | 'KILL') => checked(api.call<object | { error: string }>('er4', 'kill', { pid, signal })),
  captureStart: (a: { iface: string; filter: string; seconds: number; packets: number }) => checked(api.call<object | { error: string }>('er4', 'capture_start', a)),
  captureStatus: () => api.call<CaptureStatus>('er4', 'capture_status'),
  captureStop: () => api.call('er4', 'capture_stop'),
}

/** One process; cpu is the share of the whole machine since the previous poll (null on the first). */
export interface Proc { pid: number; ppid: number; user: string; state: string; cpu: number | null; rss: number; mem: number; command: string }
export interface CaptureStatus { running: boolean; size: number; log: string }
export const CAPTURE_PATH = '/tmp/er4-capture.pcap'

/** Fetch the capture through cgi-io and hand it to the browser as a .pcap. */
export async function downloadCapture(name: string) {
  let blob: Blob
  if (isMock) blob = new Blob([new Uint8Array([0xd4, 0xc3, 0xb2, 0xa1, 2, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0, 1, 0, 0, 0])], { type: 'application/vnd.tcpdump.pcap' })
  else {
    const res = await fetch('/cgi-bin/cgi-download', { method: 'POST', body: new URLSearchParams({ sessionid: sessionId(), path: CAPTURE_PATH, filename: name }) })
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`)
    blob = await res.blob()
  }
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

/** Ping summary from busybox ping's last lines, when it got that far. */
export function pingSummary(out: string): { sent: number; received: number; loss: number; min?: number; avg?: number; max?: number } | undefined {
  const p = /(\d+) packets transmitted, (\d+) packets received(?:, \+?\d+ duplicates)?, (\d+)% packet loss/.exec(out)
  if (!p) return undefined
  const rtt = /min\/avg\/max = ([\d.]+)\/([\d.]+)\/([\d.]+)/.exec(out)
  return { sent: +p[1], received: +p[2], loss: +p[3], ...(rtt && { min: +rtt[1], avg: +rtt[2], max: +rtt[3] }) }
}

/** A route's table ('main' when ip leaves it out) */
export const routeTable = (r: IpRoute) => r.table ?? 'main'
