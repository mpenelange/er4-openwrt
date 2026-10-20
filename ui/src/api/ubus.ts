// ubus over HTTP JSON-RPC (uhttpd's /ubus handler + rpcd), the same API LuCI uses.
// Every call carries the session id from session.login; rpcd's ACLs (acl.d) decide what a
// session may call. In development the transport is the in-browser mock (api/mock).

export type UbusArgs = Record<string, unknown>
export type Transport = (session: string, object: string, method: string, args: UbusArgs) => Promise<unknown>

// rpcd status codes (libubus UBUS_STATUS_*)
export const UBUS_STATUS = {
  OK: 0,
  INVALID_COMMAND: 1,
  INVALID_ARGUMENT: 2,
  METHOD_NOT_FOUND: 3,
  NOT_FOUND: 4,
  NO_DATA: 5,
  PERMISSION_DENIED: 6,
  TIMEOUT: 7,
} as const

/** uhttpd's answer to session.login while this address is locked out after failed logins (ER-4 patch) */
export const LOGIN_THROTTLED = -32004

export class UbusError extends Error {
  constructor(public object: string, public method: string, public code: number, detail?: string) {
    super(`${object}.${method}: ${detail ?? `ubus status ${code}`}`)
  }
}

const NULL_SESSION = '00000000000000000000000000000000'
const SESSION_KEY = 'er4.session'
let seq = 0

export function httpTransport(url = '/ubus'): Transport {
  return async (session, object, method, args) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'call', params: [session, object, method, args] }),
    })
    if (!res.ok) throw new UbusError(object, method, -1, `HTTP ${res.status}`)
    const body = await res.json()
    if (body.error) {
      // -32002 = access denied (bad or expired session)
      const code = body.error.code === -32002 ? UBUS_STATUS.PERMISSION_DENIED : body.error.code === LOGIN_THROTTLED ? LOGIN_THROTTLED : -1
      throw new UbusError(object, method, code, body.error.message)
    }
    const [code, data] = body.result as [number, unknown?]
    if (code !== UBUS_STATUS.OK) throw new UbusError(object, method, code)
    return data ?? {}
  }
}

type Listener = () => void

export class Ubus {
  private session = sessionStorage.getItem(SESSION_KEY) ?? NULL_SESSION
  private listeners = new Set<Listener>()

  constructor(private transport: Transport) {}

  get loggedIn() {
    return this.session !== NULL_SESSION
  }

  /** Called when the session is gone (logout, expiry, permission denied on a fresh login). */
  onLogout(fn: Listener) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  async login(username: string, password: string) {
    const r = (await this.transport(NULL_SESSION, 'session', 'login', { username, password, timeout: 3600 })) as {
      ubus_rpc_session: string
    }
    this.session = r.ubus_rpc_session
    sessionStorage.setItem(SESSION_KEY, this.session)
  }

  logout() {
    const s = this.session
    this.session = NULL_SESSION
    sessionStorage.removeItem(SESSION_KEY)
    this.transport(s, 'session', 'destroy', {}).catch(() => {})
    this.listeners.forEach((fn) => fn())
  }

  async call<T = unknown>(object: string, method: string, args: UbusArgs = {}): Promise<T> {
    try {
      return (await this.transport(this.session, object, method, args)) as T
    } catch (e) {
      if (e instanceof UbusError && e.code === UBUS_STATUS.PERMISSION_DENIED && object !== 'session') {
        // uhttpd says "access denied" both for a dead session and for a method the session's
        // ACL doesn't grant: only the first is a reason to log out
        if (await this.sessionAlive()) throw new UbusError(object, method, e.code, `not permitted (rpcd ACL has no ${object}.${method})`)
        this.logout()
      }
      throw e
    }
  }

  private async sessionAlive() {
    try {
      await this.transport(this.session, 'session', 'access', {})
      return true
    } catch {
      return false
    }
  }
}
