// System > Scheduled tasks: root's crontab (busybox crond). Each line is read back as a sentence
// ("every day at 04:00: reboot"); saving writes the file and (re)starts cron at once, not staged.
// /etc is kept on the eMMC, so the tasks survive reboots and image updates (keep settings).
import { useEffect, useState } from 'preact/hooks'
import { useAsync } from '../../api/store'
import { system } from '../../api/system'
import { Badge, Button, Card, ErrorBox } from '../../components/ui'

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const FIELD = /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/
const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]

const PRESETS = [
  { label: 'Reboot nightly', line: '0 4 * * * /sbin/reboot' },
  { label: 'Reboot weekly', line: '0 4 * * 0 /sbin/reboot' },
  { label: 'Restart the WAN daily', line: '30 4 * * * /sbin/ifup wan' },
]

const pad = (n: string) => n.padStart(2, '0')

/** A crontab line in words, or an error. Covers the common shapes; the rest is shown as is. */
export function cronText(line: string): { text?: string; error?: string } {
  const t = line.trim()
  if (!t || t.startsWith('#')) return {}
  const f = t.split(/\s+/)
  if (f.length < 6) return { error: 'needs 5 time fields and a command' }
  for (let i = 0; i < 5; i++) {
    if (!FIELD.test(f[i])) return { error: `field ${i + 1} (“${f[i]}”) isn't a cron value` }
    for (const n of f[i].split(/[^\d]+/).filter(Boolean)) if (+n < RANGES[i][0] || +n > RANGES[i][1]) return { error: `${n} is out of range in field ${i + 1}` }
  }
  const [mi, h, dom, mon, dow] = f
  const cmd = f.slice(5).join(' ')
  const num = (s: string) => /^\d+$/.test(s)
  let when: string
  const step = /^\*\/(\d+)$/
  if (mi === '*' && h === '*') when = 'every minute'
  else if (step.test(mi) && h === '*') when = `every ${step.exec(mi)![1]} minutes`
  else if (num(mi) && h === '*') when = `every hour at :${pad(mi)}`
  else if (num(mi) && step.test(h)) when = `every ${step.exec(h)![1]} hours at :${pad(mi)}`
  else if (num(mi) && num(h)) when = `at ${pad(h)}:${pad(mi)}`
  else when = `at ${mi} ${h}`
  const days = dow === '*' ? '' : dow.split(',').map((d) => (num(d) ? DAYS[+d % 7] : d)).join(', ')
  const scope = dom === '*' && mon === '*' ? (days ? `on ${days}` : num(mi) && num(h) ? 'every day' : '')
    : `${dom !== '*' ? `on day ${dom}` : ''}${mon !== '*' ? ` of month ${mon}` : ''}${days ? ` and ${days}` : ''}`
  return { text: `${[scope, when].filter(Boolean).join(' ')}: ${cmd}` }
}

export function Cron() {
  const cur = useAsync(system.crontab, [], [])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<unknown>()
  const [saved, setSaved] = useState(false)
  useEffect(() => { if (cur.data) setText(cur.data.text) }, [cur.data])
  const lines = text.split('\n')
  const read = lines.map(cronText)
  const bad = read.findIndex((r) => r.error)
  const dirty = !!cur.data && text.trim() !== cur.data.text.trim()
  const save = async () => {
    setBusy(true)
    try { await system.setCrontab(text); setErr(undefined); setSaved(true); cur.reload() } catch (e) { setErr(e) } finally { setBusy(false) }
  }
  const add = (l: string) => { setSaved(false); setText((x) => `${x.trim() ? `${x.trimEnd()}\n` : ''}${l}\n`) }
  const active = read.filter((r) => r.text).length
  return (
    <Card title="Scheduled tasks" actions={cur.data && (
      cur.data.running ? <Badge status="good">cron running</Badge> : active ? <Badge>cron stopped</Badge> : null
    )}>
      <div class="stack">
        {cur.error && <ErrorBox error={`Couldn't read the crontab: ${cur.error.message}`} />}
        {err != null && <ErrorBox error={err} />}
        <textarea class="input mono cron-text" rows={8} spellcheck={false} aria-label="Crontab" value={text}
          placeholder="# minute hour day month weekday command&#10;0 4 * * * /sbin/reboot"
          onInput={(e) => { setSaved(false); setText((e.target as HTMLTextAreaElement).value) }} />
        <ul class="cron-read" aria-label="What the tasks do">
          {read.map((r, i) => (r.text ? <li>{r.text}</li> : r.error ? <li class="error">Line {i + 1}: {r.error}</li> : null))}
        </ul>
        <div class="row" style={{ flexWrap: 'wrap' }}>
          {PRESETS.map((p) => <button type="button" class="chip" disabled={lines.some((l) => l.trim() === p.line)} onClick={() => add(p.line)}>{p.label}</button>)}
          <span style={{ flex: 1 }} />
          {saved && !dirty && <span class="muted small">Saved</span>}
          <Button variant="primary" icon="check" disabled={busy || !dirty || bad >= 0} onClick={save}>Save</Button>
        </div>
      </div>
    </Card>
  )
}
