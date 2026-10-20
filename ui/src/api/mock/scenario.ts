// Mock scenarios: switch the mock router into edge states to check every screen state.
// Set with a query flag in the URL or in the hash (so screenshots can set it per route):
//   ?mock&scenario=wan-down,eth2-nolink        #/dashboard?scenario=stats-error
// or from the dev menu (stored in localStorage 'er4.mock.scenario'). Read on every call, so
// switching takes effect on the next poll.
import { mockUci, objects, type MockHandler } from './registry'
import type { UciConfig, UciSection, UciValue } from '../types'

export const SCENARIOS = {
  'wan-down': 'WAN has no carrier, no lease',
  'eth2-nolink': 'eth2 unplugged',
  'eth3-100m': 'SFP negotiated 100M half',
  'stats-error': 'er4.stats fails (plugin missing)',
  slow: 'every call takes ~1.5 s (loading states)',
  'offload-off': 'offload module not loaded',
  'conntrack-full': 'conntrack table nearly full',
  'no-leases': 'no DHCP clients',
  'update-available': 'GitHub has a newer release',
  'verify-fail': 'uploaded image fails verification',
  'install-fail': 'writing the image fails half-way',
  'no-previous': 'no previous image kept',
  // network/devices states (one at a time, see netScenario)
  empty: 'no devices, leases or extra networks',
  fresh: 'factory defaults: lan on eth1 only, eth2/eth3 unassigned, no bridge',
  many: '~60 devices, several VLANs, a dedicated port',
  error: 'interface dump and lease reads fail',
  staged: 'some changes staged at startup',
  loading: 'interface and lease reads never return',
  // firewall / VPN pages
  'fw-many': 'many zones, rules and port forwards',
  'fw-empty': 'no rules or port forwards',
  'fw-error': 'firewall config read fails',
  'fw-staged': 'firewall changes staged at startup',
  'vpn-none': 'no WireGuard interface (setup wizard)',
  'vpn-empty': 'WireGuard with no peers',
  'vpn-many': 'many WireGuard peers',
  'vpn-error': 'WireGuard status read fails',
  'vpn-staged': 'WireGuard changes staged at startup',
  'ts-none': 'Tailscale not downloaded yet (fresh router)',
  'clock-behind': "router clock 105 days behind (no NTP): its timestamps aren't the browser's",
  'no-password': 'factory-fresh: root has no password (login page asks to set one)',
} as const
export type Scenario = keyof typeof SCENARIOS

const KEY = 'er4.mock.scenario'

function fromQuery(q: string): string[] {
  const v = new URLSearchParams(q).get('scenario')
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []
}

export function activeScenarios(): Set<string> {
  const hashQ = location.hash.includes('?') ? location.hash.slice(location.hash.indexOf('?') + 1) : ''
  const list = [...fromQuery(location.search), ...fromQuery(hashQ), ...(localStorage.getItem(KEY) ?? '').split(',').filter(Boolean)]
  return new Set(list)
}

export function scenario(name: Scenario): boolean {
  return activeScenarios().has(name)
}

export function setStoredScenarios(list: string[]) {
  if (list.length) localStorage.setItem(KEY, list.join(','))
  else localStorage.removeItem(KEY)
}

export function storedScenarios(): string[] {
  return (localStorage.getItem(KEY) ?? '').split(',').filter(Boolean)
}

/**
 * Wrap an existing mock method (e.g. one from the core mock) once all mocks are registered.
 * ext/*.ts load before the core registers its objects, so the wrap is deferred a microtask.
 */
export function wrapMock(object: string, method: string, wrap: (orig: MockHandler) => MockHandler) {
  queueMicrotask(() => {
    const orig = objects[object]?.[method]
    if (!orig) throw new Error(`[mock] wrapMock: ${object}.${method} not registered`)
    objects[object][method] = wrap(orig)
  })
}

/** The mock router's clock, unix seconds: 105 days behind with the 'clock-behind' scenario. */
export const mockNow = () => Date.now() / 1000 - (scenario('clock-behind') ? 105 * 86400 : 0)

/** Delay a reply when the 'slow' scenario is on (shows loading states). */
export async function maybeSlow<T>(v: T | Promise<T>): Promise<T> {
  if (scenario('slow')) await new Promise((r) => setTimeout(r, 1200 + Math.random() * 600))
  return v
}

// ---- network/devices pages: one whole-router state at a time -------------------------
export type NetScenario = 'empty' | 'fresh' | 'many' | 'error' | 'staged' | 'loading' | undefined
const NET: NetScenario[] = ['empty', 'fresh', 'many', 'error', 'staged', 'loading']

/** The active network/devices scenario, if any (first one wins). */
export function netScenario(): NetScenario {
  for (const s of activeScenarios()) if ((NET as string[]).includes(s)) return s as NetScenario
  return undefined
}

/** Run after the core mock (index.ts) has registered its objects and initial UCI state:
 *  ext modules are evaluated before index.ts's body, so overrides of core methods and
 *  edits to the initial state must be deferred. */
export const afterCore = (fn: () => void) => queueMicrotask(fn)

/** A promise that never settles, for the loading state. */
export const never = () => new Promise<never>(() => {})

// ---- firewall/VPN mock helpers ---------------------------------------------------------
/** Ext files load before the core mock initialises its state; run fn right after it does. */
export const afterInit = afterCore

const cloneCfg = <T>(v: T): T => JSON.parse(JSON.stringify(v))

/** Edit the applied ("live") state of the mock before the UI starts; staged follows. */
export function editLive(fn: (live: Record<string, UciConfig>) => void) {
  fn(mockUci.live)
  for (const c of Object.values(mockUci.live)) {
    Object.values(c).sort((a, b) => (a['.index'] ?? 0) - (b['.index'] ?? 0)).forEach((s, i) => { s['.index'] = i })
  }
  mockUci.staged = cloneCfg(mockUci.live)
}

export function section(type: string, name: string, opts: Record<string, string | string[]>, anonymous = true): UciSection {
  return { '.anonymous': anonymous, '.type': type, '.name': name, '.index': 1e6, ...opts }
}

export function removeWhere(c: UciConfig, pred: (s: UciSection) => boolean) {
  for (const [k, s] of Object.entries(c)) if (pred(s)) delete c[k]
}

/** Stage changes through the mock's own uci handlers, so they show up as unapplied changes. */
export const stage = {
  set: (config: string, section: string, values: Record<string, UciValue>) => objects.uci.set({ config, section, values }),
  add: (config: string, type: string, values: Record<string, UciValue>, name?: string) =>
    (objects.uci.add({ config, type, values, name }) as { section: string }).section,
  remove: (config: string, section: string, options?: string[]) => objects.uci.delete(options ? { config, section, options } : { config, section }),
  order: (config: string, sections: string[]) => objects.uci.order({ config, sections }),
}
