// UCI through rpcd, with LuCI's safe-apply flow:
//   set/add/delete stage changes in the session (nothing live yet);
//   apply({rollback: true, timeout}) makes them live and arms a rollback timer on the router;
//   confirm() within the timeout keeps them, otherwise rpcd reverts everything by itself.
// So a change that cuts off the browser (wrong VLAN, firewall rule, IP) undoes itself.
import type { UciChanges, UciConfig, UciSection, UciValue } from './types'
import { api } from './client'
import { UBUS_STATUS, UbusError } from './ubus'
import { emit } from './store'

export const ROLLBACK_SECONDS = 60

export const uci = {
  async get(config: string): Promise<UciConfig> {
    const r = await api.call<{ values: UciConfig }>('uci', 'get', { config })
    return r.values
  },

  async section(config: string, section: string): Promise<UciSection | undefined> {
    const all = await uci.get(config)
    return all[section]
  },

  /** Sections of one type, in config order (anonymous ones included). */
  async sections(config: string, type: string): Promise<UciSection[]> {
    const all = await uci.get(config)
    return Object.values(all)
      .filter((s) => s['.type'] === type)
      .sort((a, b) => (a['.index'] ?? 0) - (b['.index'] ?? 0))
  },

  /** Set options. An empty list removes the option (rpcd rejects a set with an empty array). */
  async set(config: string, section: string, values: Record<string, UciValue>) {
    const empty = Object.keys(values).filter((k) => Array.isArray(values[k]) && !values[k].length)
    const rest = Object.fromEntries(Object.entries(values).filter(([k]) => !empty.includes(k)))
    if (Object.keys(rest).length) await api.call('uci', 'set', { config, section, values: rest })
    if (empty.length) await removeOptions(config, section, empty)
    emit('changes')
  },

  /** Adds a section; returns its name (generated for anonymous sections). */
  async add(config: string, type: string, values: Record<string, UciValue> = {}, name?: string): Promise<string> {
    const r = await api.call<{ section: string }>('uci', 'add', { config, type, name, values })
    emit('changes')
    return r.section
  },

  /** Delete a section, or some of its options (options that aren't set are fine). */
  async remove(config: string, section: string, options?: string[]) {
    if (options) await removeOptions(config, section, options)
    else await api.call('uci', 'delete', { config, section })
    emit('changes')
  },

  /**
   * Reorder sections (rpcd uci.order). rpcd places the listed sections at positions 0..n-1
   * of the config, so pass EVERY section of the config in the wanted order (as LuCI does);
   * see orderWithin() for permuting one type in place.
   */
  async order(config: string, sections: string[]) {
    await api.call('uci', 'order', { config, sections })
    emit('changes')
  },

  async changes(): Promise<UciChanges> {
    const r = await api.call<{ changes?: UciChanges }>('uci', 'changes', {})
    return r.changes ?? {}
  },

  async revert(config: string) {
    await api.call('uci', 'revert', { config })
    emit('changes')
  },

  async revertAll() {
    const ch = await uci.changes()
    await Promise.all(Object.keys(ch).map((c) => api.call('uci', 'revert', { config: c })))
    emit('changes')
  },

  /** Make staged changes live with an armed rollback (call confirm() to keep them), or, with
   *  rollback false, for good at once. */
  async apply(timeout = ROLLBACK_SECONDS, rollback = true) {
    await api.call('uci', 'apply', rollback ? { rollback: true, timeout } : { rollback: false })
    emit('changes')
  },

  async confirm() {
    await api.call('uci', 'confirm', {})
    emit('changes')
  },

  /** Abort a pending apply now instead of waiting for the timer. */
  async rollback() {
    await api.call('uci', 'rollback', {})
    emit('changes')
  },
}

// rpcd answers NOT_FOUND when none of the options exist: already the wanted state
async function removeOptions(config: string, section: string, options: string[]) {
  try {
    await api.call('uci', 'delete', { config, section, options })
  } catch (e) {
    if (!(e instanceof UbusError && e.code === UBUS_STATUS.NOT_FOUND)) throw e
  }
}

/** Full section order of `config` with the sections in `reordered` (all of one type) permuted
 *  into their own slots, everything else left where it is. Feed the result to uci.order(). */
export function orderWithin(all: UciConfig, reordered: string[]): string[] {
  const names = Object.values(all).sort((a, b) => (a['.index'] ?? 0) - (b['.index'] ?? 0)).map((x) => x['.name'])
  const set = new Set(reordered)
  let i = 0
  return names.map((n) => (set.has(n) ? reordered[i++] : n))
}
