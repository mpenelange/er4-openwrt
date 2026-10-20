import { useEffect, useState } from 'preact/hooks'
import { api, isMock } from '../api/client'
import { system } from '../api/system'
import { LOGIN_THROTTLED, UbusError } from '../api/ubus'
import { Icon } from '../components/icons'
import { checkStale } from '../api/fresh'

export function Login({ onLogin }: { onLogin: () => void }) {
  // A factory-fresh router has no root password and refuses every login: set one first
  const [setup, setSetup] = useState(false)
  useEffect(() => {
    system.setupStatus().then((r) => setSetup(!r.password_set), () => {})
  }, [])
  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
      {setup ? <Setup onLogin={onLogin} /> : <Password onLogin={onLogin} />}
    </div>
  )
}

function Password({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: Event) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api.login('root', password)
      onLogin()
      checkStale()
    } catch (err) {
      setError(err instanceof UbusError && err.code === LOGIN_THROTTLED ? 'Too many failed attempts. Wait a minute, then try again.' : 'Wrong password')
    } finally {
      setBusy(false)
    }
  }
  return (
    <form class="card" style={{ width: '320px' }} onSubmit={submit}>
      <div class="card-head"><Icon name="bolt" /> <h3>EdgeRouter 4</h3></div>
      <div class="card-body stack">
        <div class="field">
          <label for="pw">Password for root</label>
          <input id="pw" class={`input${error ? ' invalid' : ''}`} type="password" autoFocus value={password}
            onInput={(e) => setPassword((e.target as HTMLInputElement).value)} />
          {error && <span class="error">{error}</span>}
          {isMock && <span class="hint">Mock backend: any password works</span>}
        </div>
        <button class="btn primary" type="submit" disabled={busy || !password}>Log in</button>
      </div>
    </form>
  )
}

function Setup({ onLogin }: { onLogin: () => void }) {
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const mismatch = pw2.length > 0 && pw !== pw2
  const ok = pw.length >= 8 && pw === pw2
  const submit = async (e: Event) => {
    e.preventDefault()
    if (!ok) return
    setBusy(true)
    setError('')
    try {
      const r = await system.setupPassword(pw)
      if (!r.result) throw new Error(r.error === 'a password is already set' ? 'A password has already been set. Reload to log in.' : 'The router refused the password')
      await api.login('root', pw)
      onLogin()
      checkStale()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form class="card" style={{ width: '360px' }} onSubmit={submit}>
      <div class="card-head"><Icon name="bolt" /> <h3>EdgeRouter 4: set a password</h3></div>
      <div class="card-body stack">
        <p class="secondary" style={{ margin: 0 }}>
          This router has no password yet, so nobody can log in. Choose the password for root.
          SSH accepts keys only; add yours under System &gt; SSH.
        </p>
        <div class="field">
          <label for="pw">New password</label>
          <input id="pw" class="input" type="password" autoComplete="new-password" autoFocus value={pw}
            onInput={(e) => setPw((e.target as HTMLInputElement).value)} />
          <span class="hint">At least 8 characters; a long passphrase beats symbols.</span>
        </div>
        <div class="field">
          <label for="pw2">Again</label>
          <input id="pw2" class={`input${mismatch ? ' invalid' : ''}`} type="password" autoComplete="new-password" value={pw2}
            onInput={(e) => setPw2((e.target as HTMLInputElement).value)} />
          {mismatch && <span class="error">Doesn't match</span>}
          {error && <span class="error">{error}</span>}
        </div>
        <button class="btn primary" type="submit" disabled={busy || !ok}>{busy ? 'Saving…' : 'Set password and log in'}</button>
      </div>
    </form>
  )
}
