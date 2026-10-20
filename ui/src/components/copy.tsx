// Copy-to-clipboard and download-as-file buttons. navigator.clipboard needs a secure context;
// the router serves plain http, so fall back to a hidden textarea + execCommand.
import { useState } from 'preact/hooks'
import { Button } from './ui'

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch { /* insecure context: fall back */ }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  document.execCommand('copy')
  ta.remove()
}

export function CopyButton({ text, label, variant = 'ghost' }: { text: string; label?: string; variant?: 'ghost' }) {
  const [done, setDone] = useState(false)
  return (
    <Button variant={label ? undefined : variant} icon={done ? 'check' : 'copy'} aria-label={label ?? 'Copy'} title={done ? 'Copied' : 'Copy to clipboard'}
      onClick={async () => { await copyText(text); setDone(true); setTimeout(() => setDone(false), 1500) }}>
      {label && (done ? 'Copied' : label)}
    </Button>
  )
}

export function downloadText(filename: string, text: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
