// System > SSH: dropbear instances (UCI 'dropbear', staged like everything else) and root's
// authorized keys (er4.ssh_keys / ssh_keys_set: a file, so changes are immediate).
import { useState } from 'preact/hooks'
import { useAsync } from '../../api/store'
import { parseSshKey, system, type SshKey } from '../../api/system'
import type { UciSection } from '../../api/types'
import { uci } from '../../api/uci'
import { Icon } from '../../components/icons'
import { Badge, Button, Card, Empty, ErrorBox, Toggle } from '../../components/ui'
import { Dropzone, InlineInput, Unapplied, useStaged } from './common'

const on = (v: unknown, def: boolean) => (v === undefined || v === '' ? def : ['on', '1', 'yes', 'true'].includes(String(v).toLowerCase()))

export function Ssh() {
  const cfg = useAsync(async () => {
    const [db, net] = await Promise.all([uci.get('dropbear'), uci.get('network').catch(() => ({}))])
    return { db, nets: Object.values(net).filter((s) => s['.type'] === 'interface' && s['.name'] !== 'loopback').map((s) => s['.name']) }
  })
  const keys = useAsync(system.sshKeys, [], [])
  const staged = useStaged('dropbear')
  if (cfg.error) return <ErrorBox error={cfg.error} />
  if (!cfg.data) return <div class="muted">Loading…</div>
  const inst = Object.values(cfg.data.db).filter((s) => s['.type'] === 'dropbear').sort((a, b) => (a['.index'] ?? 0) - (b['.index'] ?? 0))
  const enabled = inst.filter((s) => on(s.enable, true))
  const passwords = enabled.some((s) => on(s.PasswordAuth, true) && on(s.RootPasswordAuth, true))
  const lockedOut = enabled.length > 0 && !passwords && keys.data !== undefined && keys.data.length === 0
  return (
    <div class="sys-cols wide-left">
      <Card flush title="SSH server" actions={
        <Button icon="plus" onClick={() => uci.add('dropbear', 'dropbear', { PasswordAuth: 'on', RootPasswordAuth: 'on', Port: String(nextPort(inst)) })}>Add instance</Button>
      }>
        {lockedOut && <div class="note warn ssh-note"><Icon name="warning" /> Password login is off and there are no keys: nobody can log in over SSH. This page still works.</div>}
        {!enabled.length && inst.length > 0 && <div class="note ssh-note"><Icon name="info" /> SSH is off.</div>}
        {!inst.length ? <Empty>No SSH server. <Button icon="plus" onClick={() => uci.add('dropbear', 'dropbear', { PasswordAuth: 'on', RootPasswordAuth: 'on', Port: '22' })}>Add one on port 22</Button></Empty> : (
          <div class="table-wrap">
            <table class="table ssh-table">
              <thead><tr><th>Port</th><th>Listens on</th><th title="Password login">Password</th><th title="Root may log in with the password">Root</th><th>On</th><th /></tr></thead>
              <tbody>{inst.map((s) => <Instance s={s} nets={cfg.data!.nets} all={inst} staged={staged.has(s['.name'])} />)}</tbody>
            </table>
          </div>
        )}
      </Card>
      <Keys keys={keys.data} error={keys.error} reload={keys.reload} />
    </div>
  )
}

function nextPort(inst: UciSection[]) {
  const used = new Set(inst.map((s) => String(s.Port ?? '22')))
  let p = 22
  while (used.has(String(p))) p = p === 22 ? 2222 : p + 1
  return p
}

function Instance({ s, nets, all, staged }: { s: UciSection; nets: string[]; all: UciSection[]; staged: boolean }) {
  const name = s['.name']
  const set = (o: string) => (v: boolean) => uci.set('dropbear', name, { [o]: v ? 'on' : 'off' })
  const iface = s.Interface ? String(s.Interface) : ''
  const port = String(s.Port ?? '22')
  return (
    <tr class={on(s.enable, true) ? '' : 'disabled'}>
      <td>
        <span class="row nowrap">
          <InlineInput label="SSH port" value={port} mono width={70} validate={(v) => {
            const n = Number(v)
            if (!/^\d+$/.test(v) || n < 1 || n > 65535) return '1 to 65535'
            if (all.some((x) => x !== s && String(x.Port ?? '22') === v && (!x.Interface || !s.Interface || x.Interface === s.Interface))) return 'Another instance uses it'
            return ''
          }} onCommit={(v) => uci.set('dropbear', name, { Port: v })} />
          <Unapplied show={staged} />
        </span>
      </td>
      <td>
        <select class="select" aria-label="SSH listens on" value={iface} onChange={(e) => {
          const v = (e.target as HTMLSelectElement).value
          return v ? uci.set('dropbear', name, { Interface: v }) : uci.remove('dropbear', name, ['Interface'])
        }}>
          <option value="">every network</option>
          {nets.map((n) => <option value={n}>{n}</option>)}
          {iface && !nets.includes(iface) && <option value={iface}>{iface} (missing)</option>}
        </select>
      </td>
      <td><Toggle label="Password login" on={on(s.PasswordAuth, true)} onChange={set('PasswordAuth')} /></td>
      <td><Toggle label="Root password login" on={on(s.RootPasswordAuth, true)} onChange={set('RootPasswordAuth')} disabled={!on(s.PasswordAuth, true)} /></td>
      <td><Toggle label="SSH instance enabled" on={on(s.enable, true)} onChange={(v) => uci.set('dropbear', name, { enable: v ? '1' : '0' })} /></td>
      <td class="num"><Button variant="ghost" icon="trash" aria-label={`Delete SSH instance on port ${port}`} title="Delete" onClick={() => uci.remove('dropbear', name)} /></td>
    </tr>
  )
}

function Keys({ keys, error, reload }: { keys?: SshKey[]; error?: Error; reload: () => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<unknown>()
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  const bad = lines.filter((l) => !parseSshKey(l))
  const fresh = lines.filter((l) => parseSshKey(l) && !keys?.some((k) => k.key === parseSshKey(l)!.key))
  const save = async (next: string[]) => {
    setBusy(true)
    setErr(undefined)
    try { await system.setSshKeys(next); reload() } catch (e) { setErr(e) }
    setBusy(false)
  }
  const add = async () => {
    if (!keys || bad.length || !fresh.length) return
    await save([...keys.map((k) => k.line), ...fresh])
    setText('')
  }
  return (
    <Card title={`Authorized keys${keys ? ` · ${keys.length}` : ''}`}>
      {error && <ErrorBox error={`Couldn't read the keys: ${error.message}`} />}
      {keys && !keys.length && <p class="muted small" style={{ margin: 0 }}>No keys: root logs in with the password only.</p>}
      {keys && keys.length > 0 && (
        <ul class="ssh-keys">
          {keys.map((k) => (
            <li>
              <span class="ssh-type">{k.type.replace(/^ssh-|@openssh\.com$/g, '').replace('ecdsa-sha2-nistp', 'ecdsa-')}</span>
              <span class="ssh-id">
                <span class="ssh-comment">{k.comment ?? <span class="muted">no comment</span>}</span>
                <span class="mono muted small" title={k.key}>…{k.key.slice(-16)}{k.options && <> · {k.options}</>}</span>
              </span>
              <Button variant="ghost" icon="trash" aria-label={`Remove key ${k.comment ?? k.key.slice(-16)}`} title="Remove" disabled={busy}
                onClick={() => save(keys.filter((x) => x !== k).map((x) => x.line))} />
            </li>
          ))}
        </ul>
      )}
      <div class="stack ssh-add">
        <textarea class="input mono ssh-paste" rows={3} aria-label="Public keys to add" placeholder="ssh-ed25519 AAAA… you@laptop" spellcheck={false}
          value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
        <div class="row">
          <Button variant="primary" icon="plus" disabled={busy || !keys || !!bad.length || !fresh.length} onClick={add}>
            {fresh.length > 1 ? `Add ${fresh.length} keys` : 'Add key'}
          </Button>
          {bad.length > 0 && <Badge status="critical">{bad.length === 1 ? 'not a public key' : `${bad.length} lines aren't public keys`}</Badge>}
          {!bad.length && lines.length > 0 && !fresh.length && <span class="muted small">already there</span>}
        </div>
        <Dropzone accept=".pub,text/plain" title="Drop a .pub file" onFile={async (f) => { const add = (await f.text()).trim(); setText((t) => `${t.trim() ? `${t.trim()}\n` : ''}${add}`) }} />
        {err != null && <ErrorBox error={err} />}
      </div>
    </Card>
  )
}
