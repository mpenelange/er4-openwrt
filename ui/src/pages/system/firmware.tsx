// System > Firmware. The ER-4 is only ever updated by replacing the whole image. The boot
// partition holds the boot image and the previous one: an install keeps the running image as the
// previous one and writes the new one, which starts at the next reboot. "Boot previous" swaps
// them back. Images are told apart by the build ID in their trailer (rev, kernel, build time).
import type { ComponentChildren } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { useAsync } from '../../api/store'
import { FIRMWARE_PATH, system, upload, type FirmwareBuild, type FirmwareCheck, type FirmwareImage, type FirmwareStatus, type FirmwareVerify } from '../../api/system'
import { bytes } from '../../components/format'
import { Icon } from '../../components/icons'
import { Meter } from '../../components/readouts'
import { Badge, Button, Card, ErrorBox, Modal } from '../../components/ui'
import { ago, agoRouter, Dropzone, fmtDate, RebootWait } from './common'

type Step =
  | { k: 'choose' }
  | { k: 'uploading'; name: string; p: number }
  | { k: 'downloading'; p: number }
  | { k: 'verifying'; name: string }
  | { k: 'verified'; name: string; v: FirmwareVerify }
  | { k: 'installing'; p: number }
  | { k: 'ready' }
  | { k: 'error'; message: string; at: 'upload' | 'download' | 'install' }

export function Firmware() {
  const info = useAsync(system.firmwareInfo, [], ['applied'])
  const [step, setStep] = useState<Step>({ k: 'choose' })
  const [check, setCheck] = useState<FirmwareCheck>()
  const [checking, setChecking] = useState(false)
  const [checkErr, setCheckErr] = useState<unknown>()
  const [confirm, setConfirm] = useState<'reboot' | 'previous'>()
  const [rebooting, setRebooting] = useState<string>()

  // Resume a running install/download after navigating away
  useEffect(() => {
    system.firmwareStatus().then((s) => {
      if (s.state === 'writing') { setStep({ k: 'installing', p: s.progress }); poll('install') }
      else if (s.state === 'downloading') { setStep({ k: 'downloading', p: s.progress }); poll('download') }
      else if (s.state === 'ready') setStep({ k: 'ready' })
    }, () => {})
  }, [])

  const d = info.data
  const next = d?.next

  function poll(kind: 'install' | 'download') {
    const t = setInterval(async () => {
      let s: FirmwareStatus
      try { s = await system.firmwareStatus() } catch { return }
      if (s.state === 'error') { clearInterval(t); setStep({ k: 'error', message: s.message ?? 'failed', at: kind }); info.reload(); return }
      if (kind === 'install') {
        if (s.state === 'ready') { clearInterval(t); setStep({ k: 'ready' }); info.reload() }
        else setStep({ k: 'installing', p: s.progress })
      } else {
        if (s.state !== 'downloading') { clearInterval(t); verify('downloaded release') }
        else setStep({ k: 'downloading', p: s.progress })
      }
    }, 400)
  }

  async function verify(name: string) {
    setStep({ k: 'verifying', name })
    try {
      setStep({ k: 'verified', name, v: await system.firmwareVerify(FIRMWARE_PATH) })
    } catch (e) {
      setStep({ k: 'error', message: (e as Error).message, at: 'upload' })
    }
  }

  async function onFile(f: File) {
    setStep({ k: 'uploading', name: f.name, p: 0 })
    try {
      await upload(f, FIRMWARE_PATH, (p) => setStep({ k: 'uploading', name: f.name, p }))
      await verify(f.name)
    } catch (e) {
      setStep({ k: 'error', message: (e as Error).message, at: 'upload' })
    }
  }

  async function doCheck() {
    setChecking(true)
    setCheckErr(undefined)
    try { setCheck(await system.firmwareCheck()) } catch (e) { setCheckErr(e) } finally { setChecking(false) }
  }

  async function download() {
    if (!check?.latest) return
    try {
      await system.firmwareDownload(check.latest.url)
      setStep({ k: 'downloading', p: 0 })
      poll('download')
    } catch (e) {
      setStep({ k: 'error', message: (e as Error).message, at: 'download' })
    }
  }

  async function install() {
    try {
      const s = await system.firmwareInstall()
      setStep({ k: 'installing', p: s.progress })
      poll('install')
    } catch (e) {
      setStep({ k: 'error', message: (e as Error).message, at: 'install' })
    }
  }

  const stepIndex = { choose: 0, uploading: 0, downloading: 0, verifying: 1, verified: 1, installing: 2, ready: 3, error: -1 }[step.k]
  // after an install the page may not have reloaded firmware_info yet: the step says it's ready
  const pending = next ?? (step.k === 'ready' ? {} as FirmwareImage : null)

  return (
    <div class="stack-3">
      {rebooting && <RebootWait reason={rebooting} />}
      <Card title="Images" flush>
        {info.error ? <div class="card-body"><ErrorBox error={info.error} /></div> : !d ? <div class="card-body muted">Loading…</div> : (
          <div class="fw-images">
            {next && <ImageRow role="next" img={next} />}
            <ImageRow role="running" img={d.running} />
            {!next && (d.previous
              ? <ImageRow role="previous" img={d.previous} action={<Button icon="undo" onClick={() => setConfirm('previous')}>Boot previous</Button>} />
              : <div class="fw-row"><Badge>previous</Badge><span class="muted">none kept</span></div>)}
          </div>
        )}
      </Card>

      <Card title="Update" actions={<Stepper index={stepIndex} />}>
        {step.k === 'choose' && (
          <div class="stack-3">
            <Dropzone accept=".bin" onFile={onFile} title="Drop a firmware image, or click to choose" hint="er4-openwrt-….bin" />
            {d?.channel && (
              <>
                <div class="update-check">
                  <Button icon="download" disabled={checking} onClick={doCheck}>{checking ? 'Checking…' : 'Check for a release'}</Button>
                  <span class="muted">github.com/{d.channel}</span>
                </div>
                {checkErr ? <ErrorBox error={checkErr} /> : null}
                {check && (check.update_available && check.latest ? (
                  <div class="release">
                    <div class="row">
                      <Badge status="accent">new</Badge>
                      <b>OpenWrt {check.latest.version}</b>
                      <span class="muted">{check.latest.tag} · published {ago(check.latest.published)} · {bytes(check.latest.size)}</span>
                      <span class="spacer" />
                      <Button variant="primary" icon="download" onClick={download}>Download & verify</Button>
                    </div>
                    <pre class="notes">{check.latest.notes}</pre>
                  </div>
                ) : (
                  <div class="row"><Badge status="good">up to date</Badge><span class="muted">checked {new Date(check.checked * 1000).toLocaleTimeString()}</span></div>
                ))}
              </>
            )}
          </div>
        )}

        {(step.k === 'uploading' || step.k === 'downloading') && (
          <Progress label={step.k === 'uploading' ? `Uploading ${step.name}` : 'Router downloading the release'} p={step.p} />
        )}

        {step.k === 'verifying' && <Progress label={`Verifying ${step.name}`} p={NaN} />}

        {step.k === 'verified' && (
          <div class="stack-3">
            <ul class="checks">
              {step.v.checks.map((c) => (
                <li class={c.ok === false ? 'bad' : ''}>
                  {c.ok === true ? <Badge status="good">ok</Badge> : c.ok === false ? <Badge status="critical">fail</Badge> : <Badge status="warning">note</Badge>}
                  <span class="check-label">{c.label}</span>
                  <span class={`muted${c.id === 'sha256' ? ' mono hash' : ''}`}>{c.detail}</span>
                </li>
              ))}
            </ul>
            {step.v.valid && step.v.image ? (
              <div class="row fw-new">
                <span class="muted">New image</span>
                <BuildId build={step.v.image.build} version={step.v.image.version ?? undefined} />
                <span class="spacer" />
                <Button variant="ghost" onClick={() => setStep({ k: 'choose' })}>Cancel</Button>
                <Button variant="primary" icon="arrowDown" onClick={install}>Install</Button>
              </div>
            ) : (
              <div class="row">
                <span class="secondary">This image can't be installed. Nothing was written.</span>
                <span class="spacer" />
                <Button onClick={() => setStep({ k: 'choose' })}>Choose another image</Button>
              </div>
            )}
          </div>
        )}

        {step.k === 'installing' && <Progress label="Writing the image" p={step.p} />}

        {step.k === 'ready' && (
          <div class="row">
            <Badge status="good">installed</Badge>
            <span class="secondary">starts at the next reboot</span>
            <span class="spacer" />
            <Button variant="primary" icon="power" onClick={() => setConfirm('reboot')}>Reboot now</Button>
          </div>
        )}

        {step.k === 'error' && (
          <div class="stack-3">
            <ErrorBox error={step.message} />
            <div class="row">
              <span class="secondary">{step.at === 'install' ? 'The running image is untouched.' : 'Nothing was installed.'}</span>
              <span class="spacer" />
              <Button onClick={() => setStep({ k: 'choose' })}>Start over</Button>
            </div>
          </div>
        )}
      </Card>

      {confirm && (
        <Modal title={confirm === 'reboot' ? 'Reboot into the new image?' : 'Boot the previous image?'} onClose={() => setConfirm(undefined)} footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(undefined)}>Cancel</Button>
            <Button variant="primary" icon="power" onClick={async () => {
              const kind = confirm
              setConfirm(undefined)
              // the wait screen first: the router may go down before its answer gets here
              setRebooting(kind === 'reboot' ? 'Rebooting into the new image' : 'Booting the previous image')
              try {
                if (kind === 'reboot') await system.reboot()
                else await system.bootPrevious()
              } catch (e) {
                setRebooting(undefined)
                setStep({ k: 'error', message: (e as Error).message, at: 'install' })
              }
            }}>Reboot now</Button>
          </>
        }>
          <p style={{ margin: 0 }}>
            {confirm === 'reboot'
              ? <>About 90 s offline, then running {pending?.build ? <span class="mono">{pending.build.rev}</span> : 'the new image'}.</>
              : <>About 90 s offline, then running {d?.previous?.build ? <span class="mono">{d.previous.build.rev}</span> : 'the previous image'}. Settings stay as they are now.</>}
          </p>
        </Modal>
      )}
    </div>
  )
}

const ROLE = { running: <Badge status="good">running</Badge>, next: <Badge status="accent">boots next</Badge>, previous: <Badge>previous</Badge> }

function ImageRow({ role, img, action }: { role: keyof typeof ROLE; img: FirmwareImage; action?: ComponentChildren }) {
  return (
    <div class="fw-row">
      {ROLE[role]}
      <BuildId build={img.build} version={img.version} />
      <span class="muted fw-installed" title={img.installed ? fmtDate(img.installed) : undefined}>{img.installed ? `installed ${agoRouter(img.installed)}` : ''}</span>
      <span class="fw-action">{action}</span>
    </div>
  )
}

function BuildId({ build, version }: { build: FirmwareBuild | null; version?: string }) {
  if (!build) return <span class="fw-build"><span class="muted">build unknown</span>{version && <span class="muted"> · OpenWrt {version}</span>}</span>
  return (
    <span class="fw-build" title={`repo ${build.rev}, kernel ${build.kernel}`}>
      <b class="mono">{build.rev}</b>
      <span class="muted"> · kernel <span class="mono">{build.kernel}</span></span>
      <span class="muted"> · built {fmtDate(build.built)}</span>
      {version && <span class="muted"> · OpenWrt {version}</span>}
    </span>
  )
}

function Progress({ label, p }: { label: string; p: number }) {
  return (
    <div class="stack">
      <div class="row"><span>{label}</span><span class="spacer" /><span class="num muted">{isFinite(p) ? `${Math.round(p * 100)}%` : ''}</span></div>
      {isFinite(p) ? <Meter value={p} label={label} /> : <div class="indeterminate"><div /></div>}
    </div>
  )
}

function Stepper({ index }: { index: number }) {
  const steps = ['Image', 'Verify', 'Install', 'Reboot']
  return (
    <ol class="stepper">
      {steps.map((s, i) => (
        <li class={i < index ? 'done' : i === index ? 'on' : ''}>
          <span class="n">{i < index ? <Icon name="check" size={10} /> : i + 1}</span>{s}
        </li>
      ))}
    </ol>
  )
}
