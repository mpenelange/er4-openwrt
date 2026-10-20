// Dashboard reads that aren't in router.ts (kept here so router.ts stays small and shared).
import { api } from './client'
import type { Er4Stats } from './types'

export type HistoryWindow = 300 | 3600 | 86400

export interface Er4History {
  /** Seconds between samples. */
  step: number
  /** Oldest first; cumulative counters like er4.stats. */
  samples: Er4Stats[]
}

/** er4.history (ER-4 plugin, see api/mock/ext/dashboard.ts): the last `window` seconds of er4.stats. */
export const history = (window: HistoryWindow) => api.call<Er4History>('er4', 'history', { window })
