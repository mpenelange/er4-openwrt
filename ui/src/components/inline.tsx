// Click-to-edit text for table cells and drawers: shows the value; click (or Enter) turns it
// into an input; Enter or blur saves when valid and changed, Escape cancels. The save only
// stages (uci.set), so there's no confirm step.
import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { px } from './format'
import { Icon } from './icons'
import './inline.css'

export function InlineEdit({ value, display, validate, onSave, placeholder = 'Set…', mono, width, label, disabled, secret }: {
  value: string
  /** what to show when not editing (defaults to value) */
  display?: ComponentChildren
  /** error message or undefined */
  validate?: (v: string) => string | undefined
  onSave: (v: string) => unknown
  placeholder?: string
  mono?: boolean
  width?: number
  label: string
  disabled?: boolean
  /** a password: masked, typed into a password field, never in the accessible name */
  secret?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!editing || !input.current) return
    // set here, not as a prop: preact's typings don't take a text-or-password type
    if (secret) Object.assign(input.current, { type: 'password', autocomplete: 'new-password' })
    input.current.focus()
    input.current.select()
  }, [editing])
  const err = editing && draft !== value ? validate?.(draft.trim()) : undefined

  // Enter saves, and then the input blurs as it is disabled/removed: save only once
  const saving = useRef(false)
  const save = async () => {
    if (saving.current) return
    const v = draft.trim()
    if (v === value || err) return setEditing(false)
    saving.current = true
    setBusy(true)
    try { await onSave(v) } finally { saving.current = false; setBusy(false); setEditing(false) }
  }

  if (!editing) {
    return (
      <button type="button" class={`inline-edit${mono ? ' mono' : ''}${value ? '' : ' empty'}`} disabled={disabled} aria-label={`${label}: ${value ? (secret ? 'set' : value) : 'not set'}. Edit`}
        onClick={(e) => { e.stopPropagation(); setDraft(value); setEditing(true) }}>
        <span class="v">{value ? display ?? (secret ? '••••••••' : value) : placeholder}</span>
        {!disabled && <Icon name="edit" size={12} class="pen" />}
      </button>
    )
  }
  return (
    <span class="inline-edit-wrap" onClick={(e) => e.stopPropagation()}>
      <input ref={input} class={`input${mono ? ' mono' : ''}${err ? ' invalid' : ''}`} style={width ? { width: px(width) } : undefined} value={draft} disabled={busy}
        aria-label={label} title={err}
        onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { e.stopPropagation(); setEditing(false) } }}
        onBlur={save} aria-invalid={!!err} />
      {err && <span class="inline-err">{err}</span>}
    </span>
  )
}
