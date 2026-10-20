// System-area calls: password, clock, firmware (whole-image updates), backup/restore,
// reboot. Router sources:
//   er4.set_password / er4.timezones / er4.set_localtime       ER-4 plugin (LuCI's luci.* equivalents)
//   uci.configs                                               rpcd built-in
//   /cgi-bin/cgi-upload, /cgi-bin/cgi-backup                  cgi-io (an er4-ui dependency)
//   er4.firmware_* / er4.boot_previous / er4.config_* / er4.factory_reset
//                                                             ER-4 plugin (see api/mock/ext/system.ts)
import { api, isMock } from './client'
import { mockFiles } from './mock/ext/system'

/** From the trailer the image build appends after the kernel: which build this is (every image
 *  says "OpenWrt 25.12.5 r33051", so that can't tell them apart). null for images built before. */
export interface FirmwareBuild { rev: string; kernel: string; built: number }
export interface FirmwareImage {
  build: FirmwareBuild | null
  /** OpenWrt release; the router knows it only for the running image */
  version?: string
  installed?: number // unix seconds
  size?: number // bytes
}
/** The router keeps the boot image and the previous one. An install copies the running image to
 *  "previous" and writes the new one, which boots next; "Boot previous" swaps the two and reboots. */
export interface FirmwareInfo {
  board: string
  running: FirmwareImage
  /** installed since this boot: starts at the next reboot (the running one is then the previous) */
  next: FirmwareImage | null
  /** what Boot previous would start (null while an install waits for its reboot, or none kept) */
  previous: FirmwareImage | null
  /** GitHub repo ("owner/name") for the release check; null until releases are published */
  channel: string | null
}
export interface FirmwareRelease {
  version: string
  revision: string
  tag: string
  published: number
  size: number
  sha256: string
  url: string
  notes: string
}
export interface FirmwareCheck {
  current: string
  latest?: FirmwareRelease
  update_available: boolean
  checked: number
}
export interface VerifyCheck { id: string; label: string; ok: boolean | null; detail?: string }
export interface FirmwareVerify {
  valid: boolean
  checks: VerifyCheck[]
  image?: { build: FirmwareBuild | null; version?: string | null; size: number; sha256: string }
}
export interface FirmwareStatus {
  state: 'idle' | 'downloading' | 'writing' | 'ready' | 'error'
  progress: number // 0..1
  message?: string
  path?: string
}
export interface ConfigInspect {
  valid: boolean
  hostname?: string
  version?: string
  created?: number
  files: string[]
  error?: string
}

/** Where uploads land on the router (tmpfs). */
export const FIRMWARE_PATH = '/tmp/firmware.bin'
export const BACKUP_PATH = '/tmp/backup.tar.gz'

export interface SshKey { line: string; type: string; key: string; comment: string | null; options: string | null }

/** Same rules as the router (er4.uc parse_key): [options] type base64 [comment]. */
const KEY_TYPES = ['ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'sk-ssh-ed25519@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com']
export function parseSshKey(line: string): SshKey | undefined {
  const l = line.trim()
  if (!l || l.startsWith('#')) return undefined
  const f = l.split(/[ \t]+/)
  for (let i = 0; i < f.length - 1; i++) {
    if (KEY_TYPES.includes(f[i]) && /^[A-Za-z0-9+/]+={0,3}$/.test(f[i + 1]))
      return { line: l, type: f[i], key: f[i + 1], comment: f.slice(i + 2).join(' ') || null, options: i ? f.slice(0, i).join(' ') : null }
  }
  return undefined
}

/** An init script (procd's rc list): running is missing for one-shot scripts. */
export interface Service { name: string; start?: number; stop?: number; enabled: boolean; running?: boolean }
export type ServiceAction = 'start' | 'stop' | 'restart' | 'reload' | 'enable' | 'disable'

export const system = {
  setPassword: (username: string, password: string) => api.call<{ result: boolean }>('er4', 'set_password', { username, password }),
  // First-boot setup, callable before login: a factory-fresh router has no root password and
  // refuses every login until setup_password sets one (it refuses once one is set)
  setupStatus: () => api.call<{ password_set: boolean }>('er4', 'setup_status'),
  setupPassword: (password: string) => api.call<{ result: boolean; error?: string }>('er4', 'setup_password', { password }),
  timezones: () => api.call<Record<string, { tzstring: string }>>('er4', 'timezones'),
  setLocaltime: (localtime: number) => api.call<{ result: boolean }>('er4', 'set_localtime', { localtime }),
  configs: async () => (await api.call<{ configs: string[] }>('uci', 'configs')).configs,

  services: async () => Object.entries(await api.call<Record<string, Omit<Service, 'name'>>>('rc', 'list'))
    .map(([name, s]) => ({ name, ...s }) as Service).sort((a, b) => a.name.localeCompare(b.name)),
  service: (name: string, action: ServiceAction) => api.call('rc', 'init', { name, action }),

  /** root's authorized SSH keys (dropbear); set replaces the whole list, immediately (not UCI) */
  sshKeys: async () => (await api.call<{ keys: SshKey[] }>('er4', 'ssh_keys')).keys,
  setSshKeys: async (lines: string[]) => {
    const r = await api.call<{ keys?: SshKey[]; error?: string }>('er4', 'ssh_keys_set', { keys: lines })
    if (r.error) throw new Error(r.error)
    return r.keys!
  },

  /** root's crontab (busybox crond); set writes it, enables and restarts cron, immediately (not UCI) */
  crontab: () => api.call<{ text: string; enabled: boolean; running: boolean }>('er4', 'crontab'),
  setCrontab: async (text: string) => {
    const r = await api.call<{ error?: string; line?: number }>('er4', 'crontab_set', { text })
    if (r.error) throw new Error(r.line ? `Line ${r.line}: ${r.error}` : r.error)
  },

  firmwareInfo: () => api.call<FirmwareInfo>('er4', 'firmware_info'),
  firmwareCheck: () => api.call<FirmwareCheck>('er4', 'firmware_check'),
  firmwareDownload: (url: string) => api.call<FirmwareStatus>('er4', 'firmware_download', { url, path: FIRMWARE_PATH }),
  firmwareVerify: (path = FIRMWARE_PATH) => api.call<FirmwareVerify>('er4', 'firmware_verify', { path }),
  firmwareInstall: (path = FIRMWARE_PATH) => api.call<FirmwareStatus>('er4', 'firmware_install', { path }),
  firmwareStatus: () => api.call<FirmwareStatus>('er4', 'firmware_status'),
  bootPrevious: () => api.call<object>('er4', 'boot_previous'),

  configInspect: (path = BACKUP_PATH) => api.call<ConfigInspect>('er4', 'config_inspect', { path }),
  configRestore: (path = BACKUP_PATH) => api.call('er4', 'config_restore', { path }),
  factoryReset: () => api.call('er4', 'factory_reset'),
  reboot: () => api.call('er4', 'reboot'),
}

export function sessionId() {
  return sessionStorage.getItem('er4.session') ?? ''
}

/**
 * Upload a file to the router through cgi-io (what LuCI's flash/restore pages use).
 * The mock stores nothing; it just reports progress and records the name for verify.
 */
export function upload(file: File, path: string, onProgress: (p: number) => void): Promise<void> {
  if (isMock) {
    return new Promise((resolve) => {
      let p = 0
      const t = setInterval(() => {
        p = Math.min(1, p + 0.08 + Math.random() * 0.08)
        onProgress(p)
        if (p >= 1) {
          clearInterval(t)
          mockFiles[path] = file.name
          resolve()
        }
      }, 120)
    })
  }
  return new Promise((resolve, reject) => {
    const fd = new FormData()
    fd.append('sessionid', sessionId())
    fd.append('filename', path)
    fd.append('filemode', '0600')
    fd.append('filedata', file)
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/cgi-bin/cgi-upload')
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total)
    xhr.onload = () => (xhr.status === 200 ? resolve() : reject(new Error(`Upload failed: HTTP ${xhr.status}`)))
    xhr.onerror = () => reject(new Error('Upload failed: connection lost'))
    xhr.send(fd)
  })
}

/** Download a config backup (sysupgrade -b via cgi-backup) and hand it to the browser. */
export async function downloadBackup(hostname: string) {
  let blob: Blob
  if (isMock) {
    blob = new Blob([`mock backup of ${hostname}\n(etc/config/*, etc/passwd, etc/shadow, etc/dropbear/*)\n`], { type: 'application/gzip' })
    await new Promise((r) => setTimeout(r, 600))
  } else {
    const fd = new URLSearchParams({ sessionid: sessionId() })
    const res = await fetch('/cgi-bin/cgi-backup', { method: 'POST', body: fd })
    if (!res.ok) throw new Error(`Backup failed: HTTP ${res.status}`)
    blob = await res.blob()
  }
  const d = new Date()
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `backup-${hostname}-${stamp}.tar.gz`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}
