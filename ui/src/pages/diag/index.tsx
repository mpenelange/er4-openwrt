// Diagnostics: #/diag[/logs|tools|routes]
//   logs    system log (logd) and kernel log (dmesg), level filter, search, follow
//   tools   ping, traceroute, DNS lookup run on the router; output streams in
//   routes  routing tables (main, or every table) and the neighbour table, per family
//   connections  the conntrack table: who talks to whom, NAT, state, traffic
//   wan     WAN health: RTT and loss to the gateway and the internet over time, up/down events
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { PageProps } from '../../app'
import { router } from '../../api/router'
import { useAsync, usePoll } from '../../api/store'
import type { WanSample } from '../../api/diag'
import { diag, downloadCapture, hostOk, pingSummary, routeTable, severity, slowPathReason, type CaptureStatus, type Proc, type Conn, type IpNeigh, type IpRoute, type LogLevel, type LogLine, type LogSource, type Tool, type ToolPoll } from '../../api/diag'
import { downloadText } from '../../components/copy'
import { useKnownDevices } from '../../components/device-picker'
import { Icon } from '../../components/icons'
import { history } from '../../api/dashboard'
import { firewallStatus } from '../../api/firewall'
import { system } from '../../api/system'
import { TimeSeries } from '../../components/charts'
import { bytes, duration, pct } from '../../components/format'
import { Tabs } from '../../components/readouts'
import '../../components/extras.css'
import { Badge, Button, Card, Empty, ErrorBox, Modal, PageHead, Segmented, Table, Toggle, type Column, type Status } from '../../components/ui'
import './diag.css'

const TABS = [
  { id: 'logs', label: 'Logs' },
  { id: 'tools', label: 'Tools' },
  { id: 'routes', label: 'Routes' },
  { id: 'connections', label: 'Connections' },
  { id: 'wan', label: 'WAN health' },
  { id: 'firewall', label: 'Firewall' },
  { id: 'processes', label: 'Processes' },
] as const

export default function Diag({ path }: PageProps) {
  const sub = (path[0] ?? 'logs').split('?')[0]
  const tab = TABS.find((t) => t.id === sub)?.id ?? 'logs'
  return (
    <div class="page diag-page">
      <PageHead title="Diagnostics" />
      <Tabs active={tab} tabs={TABS.map((t) => ({ id: t.id, label: t.label, href: `#/diag/${t.id}` }))} />
      {tab === 'logs' && <Logs />}
      {tab === 'tools' && <Tools />}
      {tab === 'routes' && <Routes />}
      {tab === 'connections' && <Connections />}
      {tab === 'wan' && <WanHealthTab />}
      {tab === 'firewall' && <FirewallTab />}
      {tab === 'processes' && <Processes />}
    </div>
  )
}

// ---- logs ---------------------------------------------------------------------------------
type MinLevel = 'all' | 'warn' | 'err'
const MIN: Record<MinLevel, number> = { all: 7, warn: 4, err: 3 }
const pad = (n: number) => String(n).padStart(2, '0')

/** 24 h clock; the date too when it isn't today */
function stamp(t: number, today: string) {
  const d = new Date(t * 1000)
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  return day === today ? hms : `${day.slice(5)} ${hms}`
}

const LEVEL_STATUS: Partial<Record<LogLevel, Status>> = { emerg: 'critical', alert: 'critical', crit: 'critical', err: 'critical', warn: 'warning' }

function Logs() {
  const [source, setSource] = useState<LogSource>('system')
  const [min, setMin] = useState<MinLevel>('all')
  const [q, setQ] = useState('')
  const [follow, setFollow] = useState(true)
  const log = useAsync(() => diag.log(source, 1000), [source], [])
  useEffect(() => {
    if (!follow) return
    const t = setInterval(log.reload, 3000)
    return () => clearInterval(t)
  }, [follow, source])

  const s = q.trim().toLowerCase()
  const shown = (l: LogLine) => severity(l.level) <= MIN[min] && (!s || l.msg.toLowerCase().includes(s) || (l.tag ?? '').toLowerCase().includes(s))
  const lines = useMemo(() => (log.data?.lines ?? []).filter(shown), [log.data, min, s])
  // the newest 5000 lines (the router's maximum), with the level and filter applied, as text
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState<unknown>()
  const download = async () => {
    setSaving(true); setSaveErr(undefined)
    try {
      const r = await diag.log(source, 5000)
      const text = r.lines.filter(shown).map((l) => logText(l, r.boot)).join('\n') + '\n'
      const d = new Date()
      downloadText(`er4-${source}-log-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.txt`, text)
    } catch (e) { setSaveErr(e) } finally { setSaving(false) }
  }
  const total = log.data?.lines.length ?? 0

  // Follow keeps the newest line in view, unless the reader scrolled up
  const box = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  useLayoutEffect(() => {
    const el = box.current
    if (el && follow && pinned.current) el.scrollTop = el.scrollHeight
  }, [lines, follow])

  const now = new Date()
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const boot = log.data?.boot ?? 0
  return (
    <Card flush class="log-card" title={`${source === 'system' ? 'System' : source === 'kernel' ? 'Kernel' : 'Saved'} log${log.data ? ` · ${lines.length === total ? total : `${lines.length} of ${total}`}` : ''}`} actions={<>
      <input class="input log-search" type="search" placeholder="Filter" aria-label="Filter log" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      <Segmented value={min} onChange={setMin} options={[{ value: 'all', label: 'All' }, { value: 'warn', label: 'Warnings' }, { value: 'err', label: 'Errors' }]} />
      <Segmented value={source} onChange={setSource} options={[{ value: 'system', label: 'System' }, { value: 'kernel', label: 'Kernel' }, { value: 'saved', label: 'Saved' }]} />
      <label class="row log-follow" title="Refresh every 3 s and keep the newest line in view">
        <Toggle on={follow} onChange={setFollow} label="Follow" /> Follow
      </label>
      <Button icon="download" disabled={saving || !!log.error} onClick={download}
        title={`Save the newest log lines (up to 5000) as a text file${min !== 'all' || s ? ', with the current level and filter' : ''}`}>Download</Button>
    </>}>
      {saveErr != null && <ErrorBox error={`Couldn't download the log: ${(saveErr as Error).message}`} />}
      {log.error && (source === 'saved' && /no log file/.test(log.error.message)
        ? <Empty>The log isn't kept on the eMMC. Turn it on in <a href="#/system/general">System → General → Logging</a>.</Empty>
        : <ErrorBox error={`Couldn't read the log: ${log.error.message}`} />)}
      {!log.data && !log.error && <Empty>Loading log…</Empty>}
      {log.data && !lines.length && <Empty>{total ? 'No line matches.' : 'The log is empty.'}</Empty>}
      {log.data && lines.length > 0 && (
        <div class="log" ref={box} role="log" aria-label={`${source} log`}
          onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24 }}>
          {lines.map((l) => <LogRow l={l} boot={boot} today={today} />)}
        </div>
      )}
    </Card>
  )
}

/** One line as text: local date and time, facility.level, tag, message (the kernel's own
 *  seconds-since-boot stamp is kept in front of its message). */
function logText(l: LogLine, boot: number) {
  const t = l.time ?? (l.uptime != null ? boot + l.uptime : undefined)
  const d = t != null ? new Date(t * 1000) : undefined
  const when = d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : ''
  const lvl = l.facility ? `${l.facility}.${l.level ?? ''}` : l.level ?? ''
  const msg = l.uptime != null ? `[${l.uptime.toFixed(6).padStart(13)}] ${l.msg.replace(/^\[\s*\d+\.\d+\]\s*/, '')}` : l.msg
  return [when, lvl, l.tag ? `${l.tag}:` : '', msg].filter(Boolean).join(' ')
}

function LogRow({ l, boot, today }: { l: LogLine; boot: number; today: string }) {
  const t = l.time ?? (l.uptime != null ? boot + l.uptime : undefined)
  const st = l.level ? LEVEL_STATUS[l.level] : undefined
  return (
    <div class={`log-row${st ? ` ${st}` : ''}`}>
      <span class="log-time num" title={l.uptime != null ? `${l.uptime.toFixed(3)} s after boot` : undefined}>{t != null ? stamp(t, today) : ''}</span>
      <span class="log-level">{st ? <Badge status={st}>{l.level}</Badge> : <span class="muted">{l.level ?? ''}</span>}</span>
      <span class="log-msg">{l.tag && <span class="log-tag">{l.tag}</span>}{l.tag === 'kernel' ? l.msg.replace(/^\[\s*\d+\.\d+\]\s*/, '') : l.msg}</span>
    </div>
  )
}

// ---- tools --------------------------------------------------------------------------------
const TOOLS: { value: Tool; label: string }[] = [
  { value: 'ping', label: 'Ping' },
  { value: 'traceroute', label: 'Traceroute' },
  { value: 'nslookup', label: 'DNS lookup' },
]

function Tools() {
  const [tool, setTool] = useState<Tool>('ping')
  const [host, setHost] = useState('')
  const [family, setFamily] = useState<'4' | '6'>('4')
  const [server, setServer] = useState('')
  const [run, setRun] = useState<{ id: string; label: string; tool: Tool } | null>(null)
  const [res, setRes] = useState<ToolPoll | null>(null)
  const [err, setErr] = useState<unknown>()
  const routes = useAsync(diag.routes, [], [])
  const gw = routes.data?.[family === '6' ? 'ipv6' : 'ipv4'].find((r) => r.dst === 'default' && routeTable(r) === 'main')?.gateway

  // Poll the running job until it ends
  useEffect(() => {
    if (!run) return
    let alive = true, timer = 0
    const tick = async () => {
      try {
        const r = await diag.poll(run.id)
        if (!alive) return
        setRes(r)
        if (!r.done) timer = window.setTimeout(tick, 500)
      } catch (e) {
        if (alive) setErr(e)
      }
    }
    tick()
    return () => { alive = false; clearTimeout(timer) }
  }, [run])

  const h = host.trim(), sv = server.trim()
  const running = !!run && !res?.done && !err
  const bad = (!!h && !hostOk(h)) || (tool === 'nslookup' && !!sv && !hostOk(sv))
  const start = async (target = h) => {
    if (!target || !hostOk(target) || running) return
    if (target !== h) setHost(target)
    setErr(undefined)
    setRes(null)
    const fam = tool === 'nslookup' ? undefined : (+family as 4 | 6)
    try {
      const { id } = await diag.start({ tool, host: target, ...(fam && { family: fam }), ...(tool === 'nslookup' && sv && { server: sv }) })
      const label = `${TOOLS.find((t) => t.value === tool)!.label} ${target}${fam === 6 ? ' (IPv6)' : ''}${tool === 'nslookup' && sv ? ` @ ${sv}` : ''}`
      setRun({ id, label, tool })
    } catch (e) {
      setErr(e)
    }
  }
  const stop = () => run && diag.stop(run.id).catch(() => {})

  const sum = run?.tool === 'ping' && res?.done ? pingSummary(res.output) : undefined
  return (
    <>
      <Card>
        <form class="tool-form" onSubmit={(e) => { e.preventDefault(); start() }}>
          <Segmented value={tool} onChange={setTool} options={TOOLS} />
          <input class={`input tool-host${bad ? ' invalid' : ''}`} placeholder={tool === 'nslookup' ? 'name' : 'host or address'} aria-label="Host"
            autocomplete="off" spellcheck={false} value={host} onInput={(e) => setHost((e.target as HTMLInputElement).value)} />
          {tool === 'nslookup'
            ? <input class="input tool-server" placeholder="server (router)" aria-label="DNS server" autocomplete="off" spellcheck={false}
                value={server} onInput={(e) => setServer((e.target as HTMLInputElement).value)} />
            : <Segmented value={family} onChange={setFamily} options={[{ value: '4', label: 'IPv4' }, { value: '6', label: 'IPv6' }]} />}
          {running
            ? <Button variant="danger" icon="close" onClick={stop}>Stop</Button>
            : <Button variant="primary" type="submit" disabled={!h || bad}>Run</Button>}
        </form>
        {tool !== 'nslookup' && (
          <div class="tool-quick">
            {gw && <button type="button" class="chip" disabled={running} onClick={() => start(gw)}>gateway <span class="mono">{gw}</span></button>}
            {(family === '6' ? ['2606:4700:4700::1111', 'one.one.one.one'] : ['1.1.1.1', 'one.one.one.one']).map((x) =>
              <button type="button" class="chip mono" disabled={running} onClick={() => start(x)}>{x}</button>)}
          </div>
        )}
      </Card>
      {err != null && <ErrorBox error={err} />}
      {run && (
        <Card flush title={run.label} actions={<>
          {sum && <PingBadge s={sum} />}
          {running && <Badge status="accent">running</Badge>}
          {res?.done && res.code === 143 && <Badge status="warning">stopped</Badge>}
          {res?.done && res.code !== 0 && res.code !== 143 && !sum && <Badge status="critical">failed (exit {res.code})</Badge>}
        </>}>
          <pre class="tool-out" aria-live="polite">{res?.output || (running ? '…' : '')}</pre>
        </Card>
      )}
      <Capture />
    </>
  )
}

/** tcpdump on the router into a .pcap for Wireshark; bounded by time, packets and 20 MB. */
function Capture() {
  const ifaces = useAsync(() => router.interfaces().catch(() => []), [], [])
  const devs = [...new Set(['eth0', 'eth1', 'eth2', 'eth3', ...(ifaces.data ?? []).map((i) => i.l3_device).filter((x): x is string => !!x)])].sort()
  const [iface, setIface] = useState('eth0')
  const [filter, setFilter] = useState('')
  const [secs, setSecs] = useState('30')
  const [st, setSt] = useState<CaptureStatus | null>(null)
  const [err, setErr] = useState<unknown>()
  const [started, setStarted] = useState(false)
  useEffect(() => {
    if (!started) return
    let alive = true, timer = 0
    const tick = async () => {
      try {
        const r = await diag.captureStatus()
        if (!alive) return
        setSt(r)
        if (r.running) timer = window.setTimeout(tick, 1000)
      } catch (e) { if (alive) setErr(e) }
    }
    tick()
    return () => { alive = false; clearTimeout(timer) }
  }, [started])
  const fltOk = /^[A-Za-z0-9 .:/()!&|=<>[\]_-]*$/.test(filter) && !/^\s*-/.test(filter)
  const secOk = /^\d+$/.test(secs) && +secs >= 1 && +secs <= 300
  const start = async () => {
    setErr(undefined)
    setSt(null)
    setStarted(false)
    try { await diag.captureStart({ iface, filter: filter.trim(), seconds: +secs, packets: 200000 }); setStarted(true) } catch (e) { setErr(e) }
  }
  const running = !!st?.running
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
  return (
    <Card title="Packet capture" actions={running ? <Badge status="accent">capturing · {bytes(st!.size)}</Badge> : st && st.size > 24 ? <Badge>{bytes(st.size)}</Badge> : null}>
      <form class="tool-form" onSubmit={(e) => { e.preventDefault(); start() }}>
        <select class="input" aria-label="Capture interface" value={iface} onChange={(e) => setIface((e.target as HTMLSelectElement).value)}>
          {devs.map((d) => <option value={d}>{d}</option>)}
          <option value="any">any</option>
        </select>
        <input class={`input tool-host${fltOk ? '' : ' invalid'}`} placeholder="filter, e.g. host 192.168.1.20 and port 443" aria-label="Capture filter"
          autocomplete="off" spellcheck={false} value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
        <input class={`input mono${secOk ? '' : ' invalid'}`} style={{ width: 70 }} aria-label="Seconds" value={secs} onInput={(e) => setSecs((e.target as HTMLInputElement).value.trim())} />
        <span class="muted small">s</span>
        {running
          ? <Button variant="danger" icon="close" onClick={() => diag.captureStop().catch(setErr)}>Stop</Button>
          : <Button variant="primary" type="submit" disabled={!fltOk || !secOk}>Capture</Button>}
        {!running && st && st.size > 24 && <Button icon="download" onClick={() => downloadCapture(`er4-${iface}-${stamp()}.pcap`).catch(setErr)}>Download .pcap</Button>}
      </form>
      <div class="warn-line"><Icon name="info" size={13} /> Offloaded connections pass the CPU only for their first packets; switch offload off to capture all of them.</div>
      {err != null && <ErrorBox error={err} />}
      {st?.log && !running && <pre class="tool-out">{st.log}</pre>}
    </Card>
  )
}

function PingBadge({ s }: { s: NonNullable<ReturnType<typeof pingSummary>> }) {
  const st: Status = s.loss === 0 ? 'good' : s.loss === 100 ? 'critical' : 'warning'
  return (
    <span class="row ping-sum">
      <Badge status={st}>{s.loss}% loss</Badge>
      <span class="num muted">{s.received}/{s.sent}{s.avg != null && <> · avg <b>{s.avg.toFixed(1)}</b> ms · max {s.max!.toFixed(1)} ms</>}</span>
    </span>
  )
}

// ---- routes -------------------------------------------------------------------------------
const NEIGH_STATUS: Record<string, Status | undefined> = { REACHABLE: 'good', PERMANENT: 'good', FAILED: 'critical', INCOMPLETE: 'warning' }

function Routes() {
  const [family, setFamily] = useState<'ipv4' | 'ipv6'>('ipv4')
  const [all, setAll] = useState(false)
  const data = useAsync(async () => {
    const [r, ifaces] = await Promise.all([diag.routes(), router.interfaces().catch(() => [])])
    const net: Record<string, string> = {}
    for (const i of ifaces) if (i.l3_device && i.interface !== 'loopback') net[i.l3_device] ??= i.interface
    return { ...r, net }
  }, [], ['applied'])
  const d = data.data
  const six = family === 'ipv6'
  const rows = (d?.[family] ?? []).filter((r) => all || routeTable(r) === 'main')
  const neigh = (d?.neigh ?? []).filter((n) => n.dst.includes(':') === six)
  const dev = (x?: string) => x && <>{x}{d?.net[x] && d.net[x] !== x && <span class="muted"> · {d.net[x]}</span>}</>

  const cols: Column<IpRoute>[] = [
    { key: 'dst', label: 'Destination', value: (r) => (r.dst === 'default' ? '' : r.dst), render: (r) => (
      <span class="mono">{r.dst === 'default' ? <Badge status="accent">default</Badge> : r.dst}{r.type && r.type !== 'unicast' && <span class="muted"> {r.type}</span>}</span>) },
    { key: 'gateway', label: 'Via', render: (r) => <span class="mono">{r.gateway ?? ''}</span>, value: (r) => r.gateway ?? '' },
    { key: 'dev', label: 'Interface', render: (r) => <>{dev(r.dev)}{r.flags?.includes('linkdown') && <> <Badge status="warning">link down</Badge></>}</> },
    { key: 'protocol', label: 'Source', render: (r) => <span class="muted">{r.protocol ?? ''}</span> },
    ...(all ? [{ key: 'table', label: 'Table', value: routeTable, render: (r: IpRoute) => <span class="muted">{routeTable(r)}</span> }] : []),
    { key: 'metric', label: 'Metric', num: true, value: (r) => r.metric ?? 0, render: (r) => (r.metric != null ? String(r.metric) : '') },
  ]
  const ncols: Column<IpNeigh>[] = [
    { key: 'dst', label: 'Address', render: (n) => <span class="mono">{n.dst}</span> },
    { key: 'lladdr', label: 'MAC', render: (n) => <span class="mono">{n.lladdr ?? ''}</span>, value: (n) => n.lladdr ?? '' },
    { key: 'dev', label: 'Interface', render: (n) => dev(n.dev) },
    { key: 'state', label: 'State', value: (n) => n.state?.[0] ?? '', render: (n) => {
      const s = n.state?.[0] ?? ''
      const st = NEIGH_STATUS[s]
      return <>{st ? <Badge status={st}>{s.toLowerCase()}</Badge> : <span class="muted">{s.toLowerCase()}</span>}{n.router !== undefined && <span class="muted"> router</span>}</>
    } },
  ]
  return (
    <>
      {data.error && <ErrorBox error={`Couldn't read the routing table: ${data.error.message}`} />}
      {!d && !data.error && <Empty>Loading routes…</Empty>}
      {d && (
        <>
          <Card flush title={`${six ? 'IPv6' : 'IPv4'} routes · ${rows.length}`} actions={<>
            <label class="row" title="Include the local, broadcast and policy tables">
              <Toggle on={all} onChange={setAll} label="All tables" /> All tables
            </label>
            <Segmented value={family} onChange={setFamily} options={[{ value: 'ipv4', label: 'IPv4' }, { value: 'ipv6', label: 'IPv6' }]} />
            <Button variant="ghost" icon="refresh" aria-label="Refresh" title="Refresh" onClick={data.reload} />
          </>}>
            <div class="table-wrap"><Table columns={cols} rows={rows} rowKey={(r) => `${routeTable(r)} ${r.type ?? ''} ${r.dst} ${r.dev} ${r.gateway ?? ''} ${r.metric ?? ''}`} empty="No routes." /></div>
          </Card>
          <Card flush title={`Neighbours · ${neigh.length}`}>
            <div class="table-wrap"><Table columns={ncols} rows={neigh} rowKey={(n) => `${n.dst} ${n.dev}`} empty="No neighbours." /></div>
          </Card>
        </>
      )}
    </>
  )
}

// ---- connections --------------------------------------------------------------------------
type ProtoFilter = 'all' | 'tcp' | 'udp' | 'other'
const CT_STATUS: Record<string, Status | undefined> = { UNREPLIED: 'warning', SYN_SENT: 'warning' }
const endpoint = (ip: string, port?: number) => (port != null ? (ip.includes(':') ? `[${ip}]:${port}` : `${ip}:${port}`) : ip)
const traffic = (c: Conn) => (c.bytes ?? 0) + (c.reply_bytes ?? 0)

function Connections() {
  const [proto, setProto] = useState<ProtoFilter>('all')
  const [q, setQ] = useState('')
  const ct = useAsync(() => diag.conntrack(), [], [])
  const devices = useKnownDevices()
  const own = useAsync(() => router.interfaces().catch(() => []), [], [])
  const names = useMemo(() => {
    const m = new Map((devices.data ?? []).filter((x) => x.name).map((x) => [x.ip, x.name!]))
    for (const i of own.data ?? []) for (const a of [...(i['ipv4-address'] ?? []), ...(i['ipv6-address'] ?? [])]) m.set(a.address, 'router')
    return m
  }, [devices.data, own.data])
  const d = ct.data
  const s = q.trim().toLowerCase()
  const rows = useMemo(() => (d?.flows ?? [])
    .filter((c) => proto === 'all' || (proto === 'other' ? c.proto !== 'tcp' && c.proto !== 'udp' : c.proto === proto))
    .filter((c) => !s || [c.src, c.dst, c.reply_dst, names.get(c.src) ?? '', names.get(c.dst) ?? '', String(c.sport ?? ''), String(c.dport ?? ''), c.state ?? '']
      .some((x) => x.toLowerCase().includes(s)))
    .sort((a, b) => traffic(b) - traffic(a) || b.timeout - a.timeout), [d, proto, s, names])
  const acct = !!d?.flows.some((c) => c.bytes != null)
  const local = (ip: string) => names.get(ip) === 'router'
  const fast = d?.flows.filter((c) => c.offload).length ?? 0
  const who = (ip: string, port?: number) => {
    const n = names.get(ip)
    return n ? <span title={endpoint(ip, port)}>{n}{port != null && <span class="muted">:{port}</span>}</span> : <span class="mono">{endpoint(ip, port)}</span>
  }
  const cols: Column<Conn>[] = [
    { key: 'proto', label: 'Proto', render: (c) => <>{c.proto}{c.family === 6 && <span class="muted"> v6</span>}</> },
    { key: 'src', label: 'From', value: (c) => names.get(c.src) ?? c.src, render: (c) => who(c.src, c.sport) },
    { key: 'dst', label: 'To', value: (c) => names.get(c.dst) ?? c.dst, render: (c) => (
      <span title={c.reply_dst !== c.src ? `NAT: the other side sees ${endpoint(c.reply_dst, c.reply_dport)}` : undefined}>
        {who(c.dst, c.dport)}{c.reply_dst !== c.src && c.reply_src === c.dst && <span class="muted ct-nat"> NAT</span>}
        {c.reply_src !== c.dst && <span class="muted ct-nat"> → {endpoint(c.reply_src, c.reply_sport)}</span>}
      </span>) },
    { key: 'state', label: 'State', value: (c) => `${c.offload ? 0 : 1}${c.state ?? c.flags[0] ?? ''}`, render: (c) => {
      const w = c.flags.includes('UNREPLIED') ? 'UNREPLIED' : c.state ?? ''
      const st = CT_STATUS[w]
      const label = w.toLowerCase().replace('_', ' ')
      const o = c.offload
      if (o) {
        // in the hardware offload's flow cache: one badge says so, the hover says which ports
        const via = (x?: { in: string; out: string }) => (x ? `${x.in} → ${x.out}` : 'CPU')
        return <span title={`${label}, offloaded in hardware. Outbound: ${via(o.orig)}. Return: ${via(o.reply)}.`}>
          <Badge status="good">{o.orig && o.reply ? 'offloaded' : o.orig ? 'offloaded ↑' : 'offloaded ↓'}</Badge></span>
      }
      const why = d?.offload !== undefined ? slowPathReason(c, d.offload, local) : null
      return <span title={why ? `On the CPU: ${why}` : undefined}>
        {st ? <Badge status={st}>{label}</Badge> : <span class="muted">{label || 'cpu'}</span>}</span>
    } },
    ...(acct ? [{ key: 'bytes', label: 'Traffic', num: true, value: traffic, render: (c: Conn) => bytes(traffic(c)) }] : []),
    { key: 'timeout', label: 'Expires', num: true, render: (c) => duration(c.timeout) },
  ]
  const full = d && d.max > 0 && d.count / d.max > 0.9
  return (
    <>
      <CountHistory />
      {ct.error && <ErrorBox error={`Couldn't read the connection table: ${ct.error.message}`} />}
      {!d && !ct.error && <Empty>Loading connections…</Empty>}
      {d && (
        <Card flush title={<>Connections · <span class="num">{d.count}</span>{d.max > 0 && <span class="muted num"> of {d.max}</span>}{d.offload && <span class="muted"> · <span class="num">{fast}</span> offloaded</span>}</>} actions={<>
          {full && <Badge status="critical">table nearly full</Badge>}
          <input class="input log-search" type="search" placeholder="Filter" aria-label="Filter connections" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
          <Segmented value={proto} onChange={setProto} options={[{ value: 'all', label: 'All' }, { value: 'tcp', label: 'TCP' }, { value: 'udp', label: 'UDP' }, { value: 'other', label: 'Other' }]} />
          <Button variant="ghost" icon="refresh" aria-label="Refresh" title="Refresh" onClick={ct.reload} />
        </>}>
          <div class="table-wrap ct-table">
            <Table columns={cols} rows={rows} rowKey={(c) => `${c.proto} ${endpoint(c.src, c.sport)} ${endpoint(c.dst, c.dport)}`}
              empty={d.flows.length ? 'No connection matches.' : 'No connections.'} />
          </div>
          {d.flows.length < d.count && <div class="ct-more muted">Showing the first {d.flows.length} of {d.count}.</div>}
        </Card>
      )}
    </>
  )
}

/** Tracked connections over the last hour (er4.history keeps er4.stats samples). */
function CountHistory() {
  const h = useAsync(() => history(3600), [], [])
  const pts = (h.data?.samples ?? []).filter((x) => x.conntrack)
  if (h.error || pts.length < 2) return null
  const peak = Math.max(...pts.map((x) => x.conntrack.count))
  return (
    <Card title={<>Tracked connections · last hour <span class="muted num">peak {peak}</span></>}>
      <TimeSeries times={pts.map((x) => x.time / 1000)} format={(v) => String(Math.round(v))} height={90}
        series={[{ label: 'connections', slot: 3, values: pts.map((x) => x.conntrack.count) }]} />
    </Card>
  )
}

// ---- WAN health ---------------------------------------------------------------------------------
const ms = (v: number) => `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`
const pctTxt = (v: number) => `${Math.round(v * 100)}%`

function WanHealthTab() {
  const [win, setWin] = useState<3600 | 86400>(3600)
  const h = useAsync(() => diag.wanHealth(win), [win], [])
  useEffect(() => {
    const t = setInterval(h.reload, 30_000)
    return () => clearInterval(t)
  }, [win])
  const d = h.data
  const s = d?.samples ?? []
  const avg = (f: (x: WanSample) => number | null) => {
    const v = s.map(f).filter((x): x is number => x != null)
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : undefined
  }
  const loss = s.length ? s.reduce((a, x) => a + x.inet_loss, 0) / s.length : undefined
  const outages = s.filter((x) => x.gw_loss === 1 && x.inet_loss === 1).length
  const now = new Date()
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  return (
    <>
      {h.error && <ErrorBox error={`Couldn't read WAN health: ${h.error.message}`} />}
      {!d && !h.error && <Empty>Loading WAN health…</Empty>}
      {d && (
        <>
          <Card title={<>WAN health {!d.running && <Badge status="warning">sampler not running</Badge>}</>} actions={
            <Segmented value={String(win)} onChange={(v) => setWin(Number(v) as 3600 | 86400)} options={[{ value: '3600', label: 'Last hour' }, { value: '86400', label: '24 hours' }]} />
          }>
            {!s.length ? <Empty>No samples yet: the router pings every 10 s once it's up.</Empty> : (
              <div class="stack">
                <div class="wan-sum">
                  <span><span class="muted">gateway</span> <b class="num">{avg((x) => x.gw_rtt) != null ? ms(avg((x) => x.gw_rtt)!) : '–'}</b></span>
                  <span><span class="muted">{d.target}</span> <b class="num">{avg((x) => x.inet_rtt) != null ? ms(avg((x) => x.inet_rtt)!) : '–'}</b></span>
                  <span><span class="muted">loss</span> <b class="num">{loss != null ? pctTxt(loss) : '–'}</b></span>
                  {outages > 0
                    ? <Badge status="critical">{outages * d.step >= 120 ? `down ${duration(outages * d.step)}` : 'dropouts'}</Badge>
                    : <Badge status="good">no outage</Badge>}
                </div>
                <TimeSeries times={s.map((x) => x.t)} format={ms} height={140} series={[
                  { label: 'gateway', slot: 2, values: s.map((x) => x.gw_rtt) },
                  { label: d.target, slot: 1, values: s.map((x) => x.inet_rtt) },
                ]} />
                <TimeSeries times={s.map((x) => x.t)} format={(v) => `${Math.round(v)}%`} height={70} series={[
                  { label: `loss to ${d.target}`, slot: 7, values: s.map((x) => x.inet_loss * 100) },
                ]} />
              </div>
            )}
          </Card>
          <Card flush title={`Up/down events · ${d.events.length}`}>
            {!d.events.length ? <Empty>None in this window.</Empty> : (
              <table class="table">
                <tbody>{[...d.events].reverse().map((e) => (
                  <tr>
                    <td class="num muted" style={{ width: '1%' }}>{stamp(e.t, today)}</td>
                    <td>{e.action === 'ifdown' ? <Badge status="critical">down</Badge> : e.action === 'ifup' ? <Badge status="good">up</Badge> : <Badge status="warning">{e.action}</Badge>}</td>
                    <td class="mono">{e.iface}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </Card>
        </>
      )}
    </>
  )
}

// ---- firewall -------------------------------------------------------------------------------
/** The nftables ruleset fw4 generated and loaded (what the kernel enforces), with live counters. */
function FirewallTab() {
  const st = useAsync(() => firewallStatus(), [], ['applied'])
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  const restart = async () => {
    setBusy(true)
    try { await system.service('firewall', 'restart'); setError(undefined); st.reload() } catch (e) { setError(e) } finally { setBusy(false) }
  }
  const s = q.trim().toLowerCase()
  const lines = (st.data?.ruleset ?? '').split('\n')
  const shown = s ? lines.filter((l) => l.toLowerCase().includes(s)) : lines
  return (
    <>
      {(st.error || error) && <ErrorBox error={error ?? `Couldn't read the firewall: ${st.error!.message}`} />}
      <Card flush title={<>Loaded ruleset{st.data && <span class="muted num"> · {lines.length} lines</span>}</>} actions={<>
        <input class="input log-search" type="search" placeholder="Filter" aria-label="Filter ruleset" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        <Button variant="ghost" icon="refresh" aria-label="Refresh" title="Refresh" onClick={st.reload} />
        <Button icon="refresh" disabled={busy} onClick={restart}>Restart firewall</Button>
      </>}>
        {!st.data && !st.error && <Empty>Loading…</Empty>}
        {st.data && <pre class="nft-text mono" aria-label="nftables ruleset">{shown.join('\n') || 'No line matches.'}</pre>}
      </Card>
    </>
  )
}

// ---- processes -------------------------------------------------------------------------------
function Processes() {
  const poll = usePoll(diag.processes, 3000)
  const [q, setQ] = useState('')
  const [kernel, setKernel] = useState(false)
  const [err, setErr] = useState<unknown>()
  const [asking, setAsking] = useState<Proc | null>(null)
  const procs = poll.samples[0]
  const s = q.trim().toLowerCase()
  const rows = (procs ?? [])
    .filter((p) => kernel || !p.command.startsWith('['))
    .filter((p) => !s || `${p.pid} ${p.user} ${p.command}`.toLowerCase().includes(s))
  const send = (p: Proc, sig: 'HUP' | 'TERM' | 'KILL') => diag.kill(p.pid, sig).then(() => { setErr(undefined); setAsking(null) }, setErr)
  const cols: Column<Proc>[] = [
    { key: 'pid', label: 'PID', num: true, value: (p) => p.pid, render: (p) => <span class="num">{p.pid}</span> },
    { key: 'user', label: 'User', value: (p) => p.user, render: (p) => <span class="muted">{p.user}</span> },
    { key: 'command', label: 'Command', value: (p) => p.command, render: (p) => <span class="mono proc-cmd" title={p.command}>{p.command}</span> },
    { key: 'cpu', label: 'CPU', num: true, value: (p) => p.cpu ?? -1, render: (p) => (p.cpu == null ? <span class="muted">–</span> : pct(p.cpu, 1)) },
    { key: 'mem', label: 'Memory', num: true, value: (p) => p.rss, render: (p) => (p.rss ? <span title={pct(p.mem, 1)}>{bytes(p.rss * 1024)}</span> : <span class="muted">–</span>) },
    { key: 'act', label: '', render: (p) => (p.pid > 1 && !p.command.startsWith('[')
      ? <Button variant="ghost" icon="close" aria-label={`Stop ${p.pid}`} title="Send a signal…" onClick={() => setAsking(p)} />
      : null) },
  ]
  return (
    <>
      {(poll.error || err) && <ErrorBox error={err ?? `Couldn't read the process list: ${poll.error!.message}`} />}
      <Card flush title={<>Processes{procs && <span class="muted num"> · {procs.length}</span>}</>} actions={<>
        <input class="input log-search" type="search" placeholder="Filter" aria-label="Filter processes" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        <label class="row log-follow"><Toggle on={kernel} label="Show kernel threads" onChange={setKernel} /> kernel threads</label>
      </>}>
        {!procs ? <Empty>Loading…</Empty> : (
          <div class="table-wrap">
            <Table columns={cols} rows={rows} rowKey={(p) => String(p.pid)} empty="No process matches." />
          </div>
        )}
      </Card>
      {asking && (
        <Modal title={`Process ${asking.pid}`} onClose={() => setAsking(null)} footer={<>
          <Button onClick={() => setAsking(null)}>Cancel</Button>
          <span style={{ flex: 1 }} />
          <Button onClick={() => send(asking, 'HUP')}>Reload (HUP)</Button>
          <Button variant="danger" onClick={() => send(asking, 'TERM')}>Stop (TERM)</Button>
          <Button variant="danger" onClick={() => send(asking, 'KILL')}>Kill</Button>
        </>}>
          <p class="mono" style={{ overflowWrap: 'anywhere' }}>{asking.command}</p>
          <p class="muted small">procd restarts the services it manages; use System → Services to stop one for good.</p>
        </Modal>
      )}
    </>
  )
}
