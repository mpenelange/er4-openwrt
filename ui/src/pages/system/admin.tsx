// System > Admin: root password (er4.set_password, immediate: it is not a UCI change).
import { useState } from 'preact/hooks'
import { system } from '../../api/system'
import { Meter } from '../../components/readouts'
import { Badge, Button, Card, ErrorBox, Field } from '../../components/ui'
import type { Status } from '../../components/ui'

/** Rough strength: length + character classes, penalising repeats. 0..4. */
function strength(pw: string): { score: number; word: string; status?: Status } {
  if (!pw) return { score: 0, word: '' }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((r) => r.test(pw)).length
  const unique = new Set(pw).size
  let score = 0
  if (pw.length >= 8) score++
  if (pw.length >= 12) score++
  if (pw.length >= 16 || (pw.length >= 12 && classes >= 3)) score++
  if (classes >= 3 && unique > 6) score++
  if (unique < 4) score = 0
  const words: [string, Status | undefined][] = [['too weak', 'critical'], ['weak', 'serious'], ['fair', 'warning'], ['good', undefined], ['strong', undefined]]
  return { score, word: words[score][0], status: words[score][1] }
}

export function Admin() {
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  const [done, setDone] = useState<Date>()
  const st = strength(pw)
  const mismatch = pw2.length > 0 && pw !== pw2
  const ok = pw.length >= 8 && pw === pw2
  const submit = async (e: Event) => {
    e.preventDefault()
    if (!ok) return
    setBusy(true)
    setError(undefined)
    try {
      const r = await system.setPassword('root', pw)
      if (r && r.result === false) throw new Error('The router refused the password')
      setDone(new Date())
      setPw('')
      setPw2('')
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div class="sys-cols">
      <Card title="Password for root">
        <form class="stack-3" onSubmit={submit}>
          <p class="secondary" style={{ margin: 0 }}>
            Used by this UI and SSH (unless SSH is key-only). Takes effect immediately; it is not
            part of the staged changes and can't be undone by the 60 s rollback.
          </p>
          <Field label="New password" hint="At least 8 characters; a long passphrase beats symbols.">
            <div class="row">
              <input class="input mono" style={{ flex: 1 }} type={(show ? 'text' : 'password') as 'text'} autoComplete="new-password" value={pw}
                onInput={(e) => { setPw((e.target as HTMLInputElement).value); setDone(undefined) }} />
              <Button variant="ghost" onClick={() => setShow(!show)} aria-pressed={show}>{show ? 'Hide' : 'Show'}</Button>
            </div>
          </Field>
          {pw && (
            <Meter value={(st.score + 1) / 5} status={st.status} label="Password strength">
              {st.word} · {pw.length} chars
            </Meter>
          )}
          <Field label="Repeat" error={mismatch ? "doesn't match" : undefined}>
            <input class={`input mono${mismatch ? ' invalid' : ''}`} type={(show ? 'text' : 'password') as 'text'} autoComplete="new-password" value={pw2}
              onInput={(e) => setPw2((e.target as HTMLInputElement).value)} />
          </Field>
          {error ? <ErrorBox error={error} /> : null}
          <div class="row">
            <Button variant="primary" type="submit" icon="check" disabled={!ok || busy}>{busy ? 'Saving…' : 'Change password'}</Button>
            {done && <Badge status="good">changed at {done.toLocaleTimeString()}</Badge>}
            {pw && pw.length < 8 && <span class="muted">{8 - pw.length} more characters</span>}
          </div>
        </form>
      </Card>
      <Card title="Sessions & access">
        <ul class="plain-list">
          <li><span class="secondary">Logged-in sessions stay valid after a password change until they expire (1 h idle) or you log out.</span></li>
          <li><span class="secondary">Locked out? Boot failsafe from the serial console (press f, Enter during boot) and run passwd.</span></li>
        </ul>
      </Card>
    </div>
  )
}
