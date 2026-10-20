// Shared by the core mock (index.ts) and the per-area extensions (ext/*.ts); kept separate so
// extensions don't import index.ts (which loads them: that would be an import cycle).
import type { UbusArgs } from '../ubus'
import type { UciConfig } from '../types'

export type MockHandler = (args: UbusArgs) => unknown

export const objects: Record<string, Record<string, MockHandler>> = {}

/** Add or extend a mock ubus object. Merges per method, so several files can add to one object. */
export function registerMock(object: string, methods: Record<string, MockHandler>) {
  objects[object] = { ...objects[object], ...methods }
}

/** UCI state of the mock: live = applied, staged = the session's view (live + unapplied changes). */
export const mockUci: { live: Record<string, UciConfig>; staged: Record<string, UciConfig> } = { live: {}, staged: {} }
