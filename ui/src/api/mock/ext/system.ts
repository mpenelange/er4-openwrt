// System mocks: password, clock, firmware A/B updates, config backup/restore, reboot.
//
// Available on the router already (mocked here with the same reply shapes):
//   er4.set_password {username, password}  -> {result}       ER-4 plugin (was luci.setPassword)
//   er4.setup_status {}                     -> {password_set}  first boot, before login
//   er4.setup_password {password}           -> {result, error?} only while no password is set
//   er4.timezones {}                        -> {zone: {tzstring, active?}}
//   er4.set_localtime {localtime}           -> {result}
//   uci.configs {}                          -> {configs: [...]}  rpcd built-in
//   uploads: POST /cgi-bin/cgi-upload (sessionid, filename, filemode, filedata), cgi-io
//   backup:  POST /cgi-bin/cgi-backup (sessionid) -> sysupgrade -b tar.gz, cgi-io
//
// er4 plugin, firmware: the whole image is replaced. The boot partition holds the boot image
// (vmlinux.64) and the previous one (.prev); stock U-Boot always boots vmlinux.64, with no
// fallback. Each image carries a build ID in a trailer after the kernel (er4-build=rev krev time).
//   er4.firmware_info {}  -> {board, channel, running, next, previous}: FirmwareImage = {build:
//        {rev, kernel, built}|null, version? (running only), installed, size}. next: installed
//        since this boot; previous: what boot_previous starts (null while next is set)
//   er4.firmware_check {} -> {current, update_available, checked, latest?: {...}} (GitHub
//        releases of `channel`; the UI offers it only when channel is set)
//   er4.firmware_download {url, path} -> FirmwareStatus (state 'downloading'; poll firmware_status)
//   er4.firmware_verify {path} -> {valid, checks: [{id, label, ok: true|false|null, detail}],
//        image?: {build, version?, size, sha256}}: format (MIPS64 ELF), board name, sha256,
//        size (fits the boot partition)
//   er4.firmware_install {path} -> FirmwareStatus; running image -> .prev, new -> vmlinux.64;
//        /etc lives on p2 and is kept
//   er4.firmware_status {} -> {state: 'idle'|'downloading'|'writing'|'ready'|'error', progress, message?, path?}
//   er4.boot_previous {} -> {}; swaps vmlinux.64 and .prev, then reboots
//   er4.reboot {} -> {}; reboots two seconds after it answers
//   er4.config_inspect {path} -> {valid, hostname?, version?, created?, files[], error?}
//        (lists a sysupgrade -b archive before restoring it)
//   er4.config_restore {path} -> {}; sysupgrade -r <path>, then reboots
//   er4.factory_reset {} -> {}; firstboot -y && reboot (wipes the overlay of the running slot)
//
// Scenarios (../scenario.ts): update-available, verify-fail, install-fail, no-previous, slow,
// no-password (first-boot setup on the login page).
// A reboot (er4.reboot, boot_previous, config_restore, factory_reset) makes every call
// fail for ~8 s, like the real router going away; a staged firmware becomes the running one.
import { UBUS_STATUS, UbusError } from '../../ubus'
import { mockUci, objects, registerMock } from '../registry'
import { scenario, wrapMock } from '../scenario'
import { parseSshKey } from '../../system'

/** Names of files "uploaded" to the mock, by router path (set by api/system.ts upload()). */
export const mockFiles: Record<string, string> = {}

const DAY = 86400
const now = () => Math.round(Date.now() / 1000)

type Build = { rev: string; kernel: string; built: number }
type Img = { build: Build | null; version: string; size: number; sha256: string; installed?: number }
const img = (rev: string, kernel: string, daysAgo: number, version: string, size: number, sha256: string): Img =>
  ({ build: { rev, kernel, built: now() - daysAgo * DAY }, version, size, sha256 })
const images = {
  current: img('16c64b6', 'bdc66dd', 6, '25.12.5', 26_572_341, '9f2c4e0b1a7d63e58c0f4b2d9a1e6c3f70b8d5a2e4c1f9037b6d8e2a5c4f1b90'),
  previous: img('b3c537e', 'bdc66dd', 34, '25.12.5', 26_480_112, '3b7e1d9c0a4f28e6b5c3d1a09e7f6b4c2d8a5e3f1c0b9d7a6e4f2c8b1a3d5e70'),
  latest: img('5e0a91c', 'bdc66dd', 2, '25.12.6', 26_611_840, 'c41f0e9b8d7a6c5e4f3b2a1d0c9e8f7a6b5d4c3e2f1a0b9c8d7e6f5a4b3c2d1e'),
  local: img('a1b2c3d', 'bdc66dd', 0, '25.12.5', 26_590_002, 'e0b1c2d3a4f5968778695a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d'),
}

// the boot partition, and the image this boot came from
const fw: { boot: Img; prev: Img | null; booted: Img } = {
  boot: { ...images.current, installed: now() - 6 * DAY + 3600 },
  prev: { ...images.previous, installed: now() - 34 * DAY + 7200 },
  booted: images.current,
}
fw.booted = fw.boot
let status: { state: string; progress: number; message?: string; path?: string } = { state: 'idle', progress: 0 }
let job: number | undefined
let downloaded: Img | undefined // image sitting in /tmp/firmware.bin
let rebootUntil = 0
let rebootAt = 0

const shown = (i: Img | null, running = false) => i && ({ build: i.build, installed: i.installed, size: i.size, ...(running ? { version: i.version } : {}) })

function info() {
  const prev = scenario('no-previous') ? null : fw.prev
  // an install since this boot: vmlinux.64 is the next image, .prev the running one
  if (fw.boot !== fw.booted) return { running: shown(fw.prev ?? fw.booted, true), next: shown(fw.boot), previous: null }
  return { running: shown(fw.boot, true), next: null, previous: shown(prev) }
}

function reboot() {
  rebootUntil = Date.now() + 8000
  rebootAt = rebootUntil
  fw.booted = fw.boot // stock U-Boot boots vmlinux.64
  status = { state: 'idle', progress: 0 }
}

function runJob(kind: 'downloading' | 'writing', ms: number, done: () => void, failAt?: number) {
  clearInterval(job)
  const t0 = Date.now()
  status = { ...status, state: kind, progress: 0, message: undefined }
  job = window.setInterval(() => {
    const p = Math.min(1, (Date.now() - t0) / ms)
    if (failAt != null && p >= failAt) {
      clearInterval(job)
      status = { ...status, state: 'error', progress: p, message: 'writing the image failed; the running image is untouched' }
      return
    }
    status = { ...status, progress: p }
    if (p >= 1) {
      clearInterval(job)
      done()
    }
  }, 200)
}

const TZ: Record<string, string> = {
  UTC: 'UTC0', 'Africa/Johannesburg': 'SAST-2', 'Africa/Lagos': 'WAT-1', 'America/Anchorage': 'AKST9AKDT,M3.2.0,M11.1.0',
  'America/Chicago': 'CST6CDT,M3.2.0,M11.1.0', 'America/Denver': 'MST7MDT,M3.2.0,M11.1.0', 'America/Los_Angeles': 'PST8PDT,M3.2.0,M11.1.0',
  'America/Mexico_City': 'CST6', 'America/New_York': 'EST5EDT,M3.2.0,M11.1.0', 'America/Sao_Paulo': '<-03>3', 'America/Toronto': 'EST5EDT,M3.2.0,M11.1.0',
  'America/Vancouver': 'PST8PDT,M3.2.0,M11.1.0', 'Asia/Bangkok': '<+07>-7', 'Asia/Dubai': '<+04>-4', 'Asia/Hong_Kong': 'HKT-8', 'Asia/Jerusalem': 'IST-2IDT,M3.4.4/26,M10.5.0',
  'Asia/Kolkata': 'IST-5:30', 'Asia/Seoul': 'KST-9', 'Asia/Shanghai': 'CST-8', 'Asia/Singapore': '<+08>-8', 'Asia/Tokyo': 'JST-9',
  'Atlantic/Reykjavik': 'GMT0', 'Australia/Adelaide': 'ACST-9:30ACDT,M10.1.0,M4.1.0/3', 'Australia/Brisbane': 'AEST-10', 'Australia/Perth': 'AWST-8',
  'Australia/Sydney': 'AEST-10AEDT,M10.1.0,M4.1.0/3', 'Europe/Amsterdam': 'CET-1CEST,M3.5.0,M10.5.0/3', 'Europe/Athens': 'EET-2EEST,M3.5.0/3,M10.5.0/4',
  'Europe/Berlin': 'CET-1CEST,M3.5.0,M10.5.0/3', 'Europe/Brussels': 'CET-1CEST,M3.5.0,M10.5.0/3', 'Europe/Dublin': 'IST-1GMT0,M10.5.0,M3.5.0/1',
  'Europe/Helsinki': 'EET-2EEST,M3.5.0/3,M10.5.0/4', 'Europe/Istanbul': '<+03>-3', 'Europe/Lisbon': 'WET0WEST,M3.5.0/1,M10.5.0', 'Europe/London': 'GMT0BST,M3.5.0/1,M10.5.0',
  'Europe/Madrid': 'CET-1CEST,M3.5.0,M10.5.0/3', 'Europe/Moscow': 'MSK-3', 'Europe/Oslo': 'CET-1CEST,M3.5.0,M10.5.0/3', 'Europe/Paris': 'CET-1CEST,M3.5.0,M10.5.0/3',
  'Europe/Prague': 'CET-1CEST,M3.5.0,M10.5.0/3', 'Europe/Rome': 'CET-1CEST,M3.5.0,M10.5.0/3', 'Europe/Stockholm': 'CET-1CEST,M3.5.0,M10.5.0/3',
  'Europe/Vienna': 'CET-1CEST,M3.5.0,M10.5.0/3', 'Europe/Warsaw': 'CET-1CEST,M3.5.0,M10.5.0/3', 'Europe/Zurich': 'CET-1CEST,M3.5.0,M10.5.0/3',
  'Pacific/Auckland': 'NZST-12NZDT,M9.5.0,M4.1.0/3', 'Pacific/Honolulu': 'HST10',
}

// procd init scripts (rc list / rc init): running is left out for one-shot scripts
const rc: Record<string, { start: number; stop?: number; enabled: boolean; running?: boolean }> = {
  boot: { start: 10, stop: 10, enabled: true }, cron: { start: 50, enabled: false, running: false },
  dnsmasq: { start: 19, stop: 10, enabled: true, running: true }, done: { start: 95, enabled: true },
  dropbear: { start: 19, stop: 50, enabled: true, running: true }, firewall: { start: 19, enabled: true, running: true },
  gpio_switch: { start: 98, enabled: true }, led: { start: 96, enabled: true }, log: { start: 12, enabled: true, running: true },
  network: { start: 20, stop: 90, enabled: true, running: true }, odhcpd: { start: 35, stop: 85, enabled: true, running: true },
  offload: { start: 21, enabled: true, running: true }, packet_steering: { start: 25, enabled: true },
  rpcd: { start: 12, enabled: true, running: true }, sysctl: { start: 11, enabled: true },
  swanctl: { start: 90, stop: 10, enabled: false, running: false },
  sysfixtime: { start: 0, enabled: true }, sysntpd: { start: 98, enabled: true, running: true },
  system: { start: 10, enabled: true }, uhttpd: { start: 50, enabled: true, running: true },
  umount: { stop: 90, start: 0, enabled: true }, urandom_seed: { start: 99, enabled: true }, urngd: { start: 0, enabled: true, running: true },
}
registerMock('rc', {
  list: () => JSON.parse(JSON.stringify(rc)),
  init: ({ name, action }) => {
    const s = rc[String(name)]
    if (!s) throw new UbusError('rc', 'init', UBUS_STATUS.NOT_FOUND)
    if (!['start', 'stop', 'restart', 'reload', 'enable', 'disable'].includes(String(action))) throw new UbusError('rc', 'init', UBUS_STATUS.INVALID_ARGUMENT)
    if (action === 'enable' || action === 'disable') s.enabled = action === 'enable'
    else if (s.running !== undefined) s.running = action !== 'stop'
    return {}
  },
})

// root's authorized_keys (er4.ssh_keys / ssh_keys_set)
let sshKeys: string[] = ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK3m0ckPubKeyForTheMockRouterOnlyAAAAAAAAAA admin@desktop']
registerMock('er4', {
  ssh_keys: () => ({ keys: sshKeys.map((l) => parseSshKey(l)!).filter(Boolean) }),
  ssh_keys_set: ({ keys }) => {
    if (!Array.isArray(keys) || keys.length > 64) return { error: 'bad arguments' }
    for (const l of keys) if (typeof l !== 'string' || l.includes('\n') || !parseSshKey(l)) return { error: `not a public key: ${String(l).slice(0, 40)}` }
    sshKeys = keys.map((l) => (l as string).trim())
    return { keys: sshKeys.map((l) => parseSshKey(l)!) }
  },
})

// no-password: like the patched rpcd, no login works until setup_password sets one
let passwordSet = false
wrapMock('session', 'login', (orig) => (args) => {
  if (scenario('no-password') && !passwordSet) throw new UbusError('session', 'login', UBUS_STATUS.PERMISSION_DENIED)
  return orig(args)
})
registerMock('er4', {
  setup_status: () => ({ password_set: passwordSet || !scenario('no-password') }),
  setup_password: ({ password }) => {
    if (passwordSet || !scenario('no-password')) return { result: false, error: 'a password is already set' }
    if (typeof password !== 'string' || password.length < 8 || password.includes('\n')) return { result: false, error: 'bad password' }
    passwordSet = true
    return { result: true }
  },
  // the router answers {result: false} (not a ubus error) for an unknown user or a bad password
  set_password: ({ username, password }) => ({ result: username === 'root' && typeof password === 'string' && !!password && !password.includes('\n') }),
  timezones: () => {
    const active = String(Object.values(mockUci.live.system ?? {}).find((x) => x['.type'] === 'system')?.zonename ?? 'UTC')
    return Object.fromEntries(Object.entries(TZ).map(([k, v]) => [k, k === active ? { tzstring: v, active: true } : { tzstring: v }]))
  },
  set_localtime: ({ localtime }) => {
    clockSkew = Number(localtime) - Date.now() / 1000
    return { result: true }
  },
})

// The mock router's clock runs 47 s late until "Sync with browser" (set_localtime)
let clockSkew = -47
wrapMock('system', 'info', (orig) => async (args) => {
  const r = (await orig(args)) as { localtime: number; uptime: number }
  // rpcd: localtime = UTC epoch + the zone's offset (wall clock)
  const zone = String(Object.values(mockUci.live.system ?? {}).find((x) => x['.type'] === 'system')?.zonename ?? 'UTC')
  const d = new Date(); d.setMilliseconds(0)
  let off = 0
  try { off = (new Date(d.toLocaleString('en-US', { timeZone: zone })).getTime() - new Date(d.toLocaleString('en-US', { timeZone: 'UTC' })).getTime()) / 1000 } catch { /* unknown zone */ }
  r.localtime = Math.round(Date.now() / 1000 + clockSkew + off)
  if (rebootAt) r.uptime = Math.round((Date.now() - rebootAt) / 1000) + 40
  return r
})

registerMock('uci', {
  configs: () => ({ configs: Object.keys(mockUci.live).concat(['dropbear', 'rpcd', 'ucitrack', 'uhttpd']).sort() }),
})

registerMock('er4', {
  firmware_info: () => ({ board: 'ubnt,edgerouter-4', channel: scenario('update-available') ? 'example/er4-openwrt' : null, ...info() }),

  firmware_check: async () => {
    await new Promise((r) => setTimeout(r, 900))
    const cur = fw.booted
    const avail = scenario('update-available') && cur.version !== images.latest.version
    const l = images.latest
    return {
      current: cur.version,
      update_available: avail,
      checked: now(),
      latest: avail
        ? {
            version: l.version, revision: l.build!.rev, size: l.size, sha256: l.sha256, tag: `v${l.version}-er4`, published: l.build!.built + 3 * 3600,
            url: `https://github.com/example/er4-openwrt/releases/download/v${l.version}-er4/er4-openwrt-${l.version}.bin`,
            notes: 'OpenWrt 25.12.6 point release (security fixes in dnsmasq, openssl).\nOffload: IPv6 flows no longer bypass fw4 flowtable counters.\nWireGuard: handshake timeout tuned for CGNAT.',
          }
        : undefined,
    }
  },

  firmware_download: ({ url, path }) => {
    if (!url) throw new UbusError('er4', 'firmware_download', UBUS_STATUS.INVALID_ARGUMENT)
    status = { state: 'downloading', progress: 0, path: String(path) }
    runJob('downloading', 4000, () => {
      downloaded = images.latest
      mockFiles[String(path)] = `er4-openwrt-${images.latest.version}.bin`
      status = { state: 'idle', progress: 1, path: String(path), message: 'downloaded' }
    })
    return status
  },

  firmware_verify: async ({ path }) => {
    await new Promise((r) => setTimeout(r, 1100))
    const name = mockFiles[String(path)]
    if (!name) return { valid: false, checks: [{ id: 'format', label: 'MIPS64 big-endian ELF kernel image', ok: false, detail: 'file missing' }] }
    const bad = scenario('verify-fail') || /edgeos|er-e300|\.tar$/i.test(name)
    const i = downloaded ?? images.local
    downloaded = bad ? undefined : i
    const release = i === images.latest
    const checks = [
      { id: 'format', label: 'MIPS64 big-endian ELF kernel image', ok: true, detail: 'ok' },
      { id: 'board', label: 'Built for ubnt,edgerouter-4', ok: !bad, detail: bad ? 'board name not found' : 'board name found in the image' },
      { id: 'sha256', label: 'SHA-256', ok: null, detail: i.sha256 },
      { id: 'size', label: 'Fits on the boot partition', ok: true, detail: `${Math.round(i.size / 1048576)} MB` },
    ]
    return { valid: !bad, checks, image: bad ? undefined : { build: i.build, version: release ? i.version : null, size: i.size, sha256: i.sha256 } }
  },

  firmware_install: () => {
    if (!downloaded) throw new UbusError('er4', 'firmware_install', UBUS_STATUS.NO_DATA)
    const i = downloaded
    status = { state: 'writing', progress: 0.5 }
    runJob('writing', 6000, () => {
      fw.prev = fw.booted === fw.boot ? fw.boot : fw.prev // the running image becomes the previous one
      fw.boot = { ...i, installed: now() }
      downloaded = undefined
      status = { state: 'ready', progress: 1 }
    }, scenario('install-fail') ? 0.55 : undefined)
    return status
  },

  firmware_status: () => status,

  boot_previous: () => {
    if (!fw.prev || scenario('no-previous')) throw new UbusError('er4', 'boot_previous', UBUS_STATUS.NOT_FOUND)
    ;[fw.boot, fw.prev] = [fw.prev, fw.boot]
    setTimeout(reboot, 300)
    return {}
  },

  config_inspect: async ({ path }) => {
    await new Promise((r) => setTimeout(r, 700))
    const name = mockFiles[String(path)]
    if (!name) return { valid: false, files: [], error: `${path} not found` }
    if (!/\.(tar\.gz|tgz)$/i.test(name)) return { valid: false, files: [], error: 'Not a sysupgrade backup (expected a .tar.gz from "Download backup")' }
    return {
      valid: true, hostname: 'er4', version: '25.12.4', created: now() - 12 * DAY,
      files: ['etc/config/dhcp', 'etc/config/dropbear', 'etc/config/firewall', 'etc/config/network', 'etc/config/offload', 'etc/config/system', 'etc/config/uhttpd', 'etc/dropbear/authorized_keys', 'etc/group', 'etc/passwd', 'etc/shadow', 'etc/sysupgrade.conf'],
    }
  },
  reboot: () => { setTimeout(reboot, 300); return {} },
  config_restore: () => { setTimeout(reboot, 300); return {} },
  factory_reset: () => { setTimeout(reboot, 300); return {} },
})

// The running image's version is what system.board reports
wrapMock('system', 'board', (orig) => async (args) => {
  const b = (await orig(args)) as { release: { version: string; revision: string; description: string } }
  const v = fw.booted.version
  if (v !== b.release.version) b.release = { ...b.release, version: v, description: `OpenWrt ${v} (ER-4 offload build)` }
  return b
})

// While "rebooting", the router is unreachable (like a fetch that fails)
queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => {
  for (const [obj, methods] of Object.entries(objects)) {
    for (const [m, fn] of Object.entries(methods)) {
      methods[m] = (a) => {
        if (Date.now() < rebootUntil) {
          throw new UbusError(obj, m, -1, 'router unreachable (rebooting)')
        }
        return fn(a)
      }
    }
  }
})))

// root's crontab (er4.crontab / crontab_set)
let cron = ''
const CRON_FIELD = /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/
registerMock('er4', {
  crontab: () => ({ text: cron, enabled: rc.cron.enabled, running: !!rc.cron.running }),
  crontab_set: ({ text }) => {
    if (typeof text !== 'string') return { error: 'bad arguments' }
    const lines = text.split('\n')
    for (const [i, l] of lines.entries()) {
      const t = l.trim()
      if (!t || t.startsWith('#')) continue
      const f = t.split(/\s+/)
      if (f.length < 6 || f.slice(0, 5).some((x) => !CRON_FIELD.test(x))) return { error: 'not a cron line', line: i + 1 }
    }
    cron = text.trim() ? `${text.trim()}\n` : ''
    const any = lines.some((l) => l.trim() && !l.trim().startsWith('#'))
    rc.cron.enabled = any
    rc.cron.running = any
    return {}
  },
})
