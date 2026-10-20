// Devices: one card per network. Its DHCP pool (drag the handles, or focus one and use the
// arrow keys) sits above that network's devices, whose addresses are the bar's ticks. Direct
// actions: click a name to rename, "Reserve" pins the current IP, click a reserved IP to change
// it, the trash icon drops the reservation. DHCPv6 addresses join their device's row (matched by
// MAC, else hostname); a lease no device claims shows under "Other".
import { useMemo, useState } from 'preact/hooks'
import type { PageProps } from '../../app'
import { useAsync } from '../../api/store'
import { router } from '../../api/router'
import type { Dhcp6Lease, UciSection } from '../../api/types'
import { uci } from '../../api/uci'
import { changedSections, inSubnet, list, loadModel, pool, setDhcp, str, type Net, type NetModel } from '../../api/net'
import {
  checkReservedIp, devicesApi, displayName, HOSTNAME_RE, ipSortKey, mergeDevices, renameDevice, reserve, setReservedIp, unreserve,
  type DeviceRow,
} from '../../api/devices'
import { PoolBar } from '../../components/poolbar'
import { InlineEdit } from '../../components/inline'
import { duration } from '../../components/format'
import { Icon } from '../../components/icons'
import { Badge, Button, Card, Empty, ErrorBox, Field, Modal, PageHead, Segmented, Toggle } from '../../components/ui'
import '../network/network.css'
import './devices.css'

type Filter = 'all' | 'online' | 'reserved' | 'dynamic'
type SortKey = 'status' | 'name' | 'ip' | 'lease'
type Sort = { key: SortKey; dir: 1 | -1 }
interface V6 { lease: Dhcp6Lease; addrs: string[] }

export default function Devices(_props: PageProps) {
  const model = useAsync(loadModel)
  const leases = useAsync(devicesApi.leases, [], ['applied'])
  const hints = useAsync(devicesApi.hints, [], ['applied'])
  const neigh = useAsync(devicesApi.neighbors, [], ['applied'])
  const leases6 = useAsync(router.leases6, [], ['applied'])
  const changes = useAsync(uci.changes)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [sort, setSort] = useState<Sort>({ key: 'ip', dir: 1 })
  const [adding, setAdding] = useState(false)

  const m = model.data
  const rows = useMemo(
    () => (m ? mergeDevices(m, leases.data ?? [], hints.data ?? {}, neigh.data ?? []) : []),
    [m, leases.data, hints.data, neigh.data],
  )
  // DHCPv6 leases onto their devices
  const { v6, orphans } = useMemo(() => {
    const v6 = new Map<DeviceRow, V6[]>()
    const orphans: V6[] = []
    for (const l of leases6.data ?? []) {
      const addrs = l.ip6addrs?.length ? l.ip6addrs.map((a) => a.replace(/\/128$/, '')) : l.ip6addr ? [l.ip6addr] : []
      const r = (l.macaddr && rows.find((x) => x.mac === l.macaddr!.toLowerCase()))
        || (l.hostname && rows.find((x) => displayName(x)?.toLowerCase() === l.hostname!.toLowerCase())) || undefined
      if (r) v6.set(r, [...(v6.get(r) ?? []), { lease: l, addrs }])
      else orphans.push({ lease: l, addrs })
    }
    return { v6, orphans }
  }, [rows, leases6.data])
  const changed = changedSections((changes.data ?? {}) as never).dhcp ?? new Set<string>()
  const ready = m && (leases.data || leases.error) && (hints.data || hints.error)

  const shown = rows
    .filter((r) => filter === 'all' || (filter === 'online' ? r.online === 'online' : filter === 'reserved' ? !!r.reservedIp : !r.reservedIp))
    .filter((r) => !q || [displayName(r), r.ip, r.reservedIp, r.mac, r.net?.name, ...(v6.get(r) ?? []).flatMap((x) => x.addrs)].some((x) => x?.toLowerCase().includes(q.toLowerCase())))
  const sortVal = (r: DeviceRow): string | number => {
    switch (sort.key) {
      case 'status': return r.online === 'online' ? 0 : r.online === 'idle' ? 1 : 2
      case 'name': return (displayName(r) ?? '\uffff').toLowerCase()
      case 'ip': return ipSortKey(r.reservedIp ?? r.ip)
      case 'lease': return r.reservedIp ? -1 : r.lease ? r.lease.expires : 1e12
    }
  }
  shown.sort((a, b) => {
    const x = sortVal(a), y = sortVal(b)
    return (x < y ? -1 : x > y ? 1 : 0) * sort.dir
  })

  const online = rows.filter((r) => r.online === 'online').length
  const reserved = rows.filter((r) => r.reservedIp).length
  // every network that serves addresses or has devices; then devices on no known network
  const nets = m ? m.nets.filter((n) => (n.proto === 'static' && n.subnet && n.where.kind !== 'virtual') || rows.some((r) => r.net === n)) : []
  const others = shown.filter((r) => !r.net)
  // a lease no device claims has no online state or reservation of its own
  const orphans6 = orphans.filter((o) => (filter === 'all' || filter === 'dynamic') && (!q || [o.lease.hostname, ...o.addrs].some((x) => x?.toLowerCase().includes(q.toLowerCase()))))

  return (
    <div class="page devices-page">
      <PageHead title="Devices">
        {ready && <span class="secondary num">{rows.length} devices · {online} online · {reserved} reserved</span>}
        {m && <Button icon="plus" onClick={() => setAdding(true)}>Add reservation</Button>}
      </PageHead>
      <div class="row dev-toolbar">
        <span class="search">
          <Icon name="search" size={14} />
          <input class="input" type="search" placeholder="Name, IP, MAC…" value={q} aria-label="Search devices" onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        </span>
        <Segmented value={filter} onChange={setFilter} options={[
          { value: 'all', label: 'All' }, { value: 'online', label: 'Online' }, { value: 'reserved', label: 'Reserved' }, { value: 'dynamic', label: 'Dynamic' },
        ]} />
      </div>
      {adding && m && <AddReservation m={m} rows={rows} onClose={() => setAdding(false)} />}
      {model.error && <ErrorBox error={model.error} />}
      {leases.error && <ErrorBox error={new Error(`Couldn't read DHCP leases (${leases.error.message}). Showing reservations and known hosts only.`)} />}
      {neigh.error && <div class="muted small">Online state unavailable ({neigh.error.message}).</div>}
      {!ready ? <Empty>Loading devices…</Empty> : <>
        {nets.map((n) => <NetCard m={m!} n={n} rows={rows} shown={shown.filter((r) => r.net === n)} v6={v6} sort={sort} setSort={setSort} changed={changed} searching={!!q || filter !== 'all'} />)}
        {(others.length > 0 || orphans6.length > 0) && (
          <Card flush title="Other">
            <DeviceTable m={m!} rows={rows} shown={others} v6={v6} orphans={orphans6} sort={sort} setSort={setSort} changed={changed} />
          </Card>
        )}
        {!rows.length && !orphans.length && <Empty>No devices yet</Empty>}
        {rows.length > 0 && !shown.length && !orphans6.length && <Empty>No device matches “{q}”{filter !== 'all' ? ` among ${filter} devices` : ''}</Empty>}
      </>}
    </div>
  )
}

// ---- one network: its pool, then its devices ------------------------------------------------
const LEASE_RE = /^(\d+[smhdw]?|infinite)$/

function NetCard({ m, n, rows, shown, v6, sort, setSort, changed, searching }: {
  m: NetModel; n: Net; rows: DeviceRow[]; shown: DeviceRow[]; v6: Map<DeviceRow, V6[]>; sort: Sort; setSort: (s: Sort) => void; changed: Set<string>; searching: boolean
}) {
  const mine = rows.filter((r) => r.net === n)
  const serves = n.proto === 'static' && !!n.subnet && n.where.kind !== 'virtual'
  const p = serves ? pool(n) : undefined
  if (searching && !shown.length) return null
  const setRange = (start: number, limit: number) => uci.set('dhcp', n.dhcp!['.name'], { start: String(start), limit: String(limit) })
  return (
    <Card flush class={`net-card${n.dhcpOn ? '' : ' dhcp-off'}`} title={
      <span class="row nowrap">
        {serves && <Toggle label={`DHCP server on ${n.name}`} on={n.dhcpOn} onChange={(on) => setDhcp(n, on)} />}
        <span class="swatch" style={{ background: `var(--series-${n.slot})` }} />
        <span class="net-name">{n.name}</span>
        {n.subnet && <span class="mono muted small">{n.ipaddr}/{n.prefix}</span>}
        {n.dhcp && changed.has(n.dhcp['.name']) && <Badge status="accent">unapplied</Badge>}
      </span>
    } actions={<>
      {p && n.dhcpOn && n.dhcp && (
        <span class="row nowrap small"><span class="muted">lease</span>
          <InlineEdit mono label={`${n.name} lease time`} value={p.leasetime} width={70} validate={(v) => (LEASE_RE.test(v) ? undefined : 'e.g. 12h, 30m, 7d')}
            onSave={(v) => uci.set('dhcp', n.dhcp!['.name'], { leasetime: v })} />
        </span>
      )}
      <span class="muted small num">{mine.length} device{mine.length === 1 ? '' : 's'} · {mine.filter((r) => r.online === 'online').length} online</span>
    </>}>
      {serves && (n.dhcpOn && n.dhcp && p ? (
        <div class="net-pool">
          <PoolBar subnet={n.subnet!} router={n.ipaddr} start={p.start} limit={p.limit} onChange={setRange}
            leased={mine.filter((r) => !r.reservedIp && r.lease && r.ip).map((r) => ({ ip: r.ip!, label: displayName(r) ?? r.mac }))}
            reserved={mine.filter((r) => r.reservedIp).map((r) => ({ ip: r.reservedIp!, label: displayName(r) ?? r.mac }))} />
        </div>
      ) : <div class="net-pool muted small">DHCP server off</div>)}
      {shown.length > 0 && <DeviceTable m={m} rows={rows} shown={shown} v6={v6} sort={sort} setSort={setSort} changed={changed} />}
    </Card>
  )
}

function DeviceTable({ m, rows, shown, v6, orphans = [], sort, setSort, changed }: {
  m: NetModel; rows: DeviceRow[]; shown: DeviceRow[]; v6: Map<DeviceRow, V6[]>; orphans?: V6[]
  sort: Sort; setSort: (s: Sort) => void; changed: Set<string>
}) {
  const [error, setError] = useState<unknown>()
  const run = (p: Promise<unknown>) => p.then(() => setError(undefined), setError)
  const th = (key: SortKey, label: string, cls = '') => (
    <th class={`sortable ${cls}`} aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}
      onClick={() => setSort({ key, dir: sort.key === key ? (-sort.dir as 1 | -1) : 1 })}>
      {label}{sort.key === key && <Icon name={sort.dir === 1 ? 'arrowUp' : 'arrowDown'} size={11} style={{ marginLeft: 4, verticalAlign: -1 }} />}
    </th>
  )
  return (
    <>
      {error ? <div class="dev-banner"><ErrorBox error={error} /></div> : null}
      <table class="table devtable">
        <colgroup><col class="c-status" /><col /><col class="c-addr" /><col class="c-lease" /><col class="c-act" /></colgroup>
        <thead>
          <tr>{th('status', 'Status')}{th('name', 'Name')}{th('ip', 'Address')}{th('lease', 'Lease', 'num')}<th class="num"><span class="sr-only">Actions</span></th></tr>
        </thead>
        <tbody>
          {shown.map((r) => <DeviceRowView key={r.mac} m={m} rows={rows} r={r} v6={v6.get(r) ?? []} run={run} unapplied={!!r.host && changed.has(r.host['.name'])} />)}
          {orphans.map((o) => (
            <tr>
              <td><span class="muted small">IPv6 only</span></td>
              <td>{o.lease.hostname ?? <span class="muted">unnamed</span>}</td>
              <td><V6Lines list={[o]} m={m} run={run} /></td>
              <td class="num">{o.lease.expires === 0 ? <span class="muted">static</span> : <span class="secondary">{duration(o.lease.expires)}</span>}</td>
              <td />
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

function DeviceRowView({ m, rows, r, v6, run, unapplied }: { m: NetModel; rows: DeviceRow[]; r: DeviceRow; v6: V6[]; run: (p: Promise<unknown>) => void; unapplied: boolean }) {
  const name = displayName(r)
  const leaseIp = r.lease?.ipaddr
  const moved = r.reservedIp && leaseIp && leaseIp !== r.reservedIp
  return (
    <tr class={r.online === 'offline' ? 'offline' : ''}>
      <td>
        {r.online === 'online' ? <Badge status="good">online</Badge> : r.online === 'idle' ? <Badge>idle</Badge> : <span class="muted small">offline</span>}
      </td>
      <td title={r.mac}>
        <span class="row nowrap">
          <InlineEdit label={`Name of ${r.mac}`} value={r.host ? str(r.host.name) ?? '' : name ?? ''} placeholder="unnamed"
            display={name ? <>{name}{!r.host && r.name === undefined && r.hintName && <span class="muted small"> (seen)</span>}</> : <span class="mono muted">{r.mac}</span>}
            validate={(v) => (!HOSTNAME_RE.test(v) ? 'Letters, digits and -; up to 63' : undefined)} onSave={(v) => renameDevice(r, v)} />
          {unapplied && <Badge status="accent">unapplied</Badge>}
        </span>
      </td>
      <td>
        {r.reservedIp ? (
          <span class="row nowrap">
            <InlineEdit mono label={`Reserved IP of ${name ?? r.mac}`} value={r.reservedIp} width={130}
              validate={(v) => checkReservedIp(m, rows, r, v)} onSave={(v) => setReservedIp(r, v)} />
            {rows.some((x) => x !== r && x.reservedIp === r.reservedIp) && <Badge status="critical">duplicate</Badge>}
            {moved && <span class="muted small" title="current lease; the device moves on renewal">now {leaseIp}</span>}
          </span>
        ) : <span class="mono">{r.ip ?? '–'}</span>}
        {v6.length > 0 && <V6Lines list={v6} m={m} row={r} run={run} />}
      </td>
      <td class="num">
        {r.reservedIp ? <Badge status="accent">reserved</Badge>
          : r.lease ? r.lease.expires > 0 ? <span class="secondary" title={`${duration(r.lease.expires)} left`}>{duration(r.lease.expires).split(' ')[0]}</span> : r.lease.expires === 0 ? <span class="muted">expired</span> : <span class="muted">static</span>
          : <span class="muted" title="seen on the network, no DHCP lease (static IP on the device)">none</span>}
      </td>
      <td class="num">
        <span class="row nowrap actions">
          {!r.reservedIp && r.ip && r.net && (
            <Button variant="ghost" icon="pin" aria-label={`Reserve ${r.ip} for ${name ?? r.mac}`} title={`Always give ${name ?? r.mac} ${r.ip}`} onClick={() => reserve(r)} />
          )}
          {r.host && (
            <Button variant="ghost" icon="trash" aria-label={`Remove reservation for ${name ?? r.mac}`}
              title={r.reservedIp ? 'Remove reservation (and name pin)' : 'Remove name pin'} onClick={() => unreserve(r)} />
          )}
        </span>
      </td>
    </tr>
  )
}

/** A device's DHCPv6 addresses, each with its reservation (odhcpd DUID + host ID) */
function V6Lines({ list: l6, m, row, run }: { list: V6[]; m: NetModel; row?: DeviceRow; run: (p: Promise<unknown>) => void }) {
  const hostOf = (l: Dhcp6Lease) => Object.values(m.dhcp).find((s) => s['.type'] === 'host' && list(s.duid).includes(l.duid))
  return (
    <>
      {l6.flatMap(({ lease, addrs }) => (addrs.length ? addrs : ['–']).map((a, i) => (
        <span class="row nowrap v6-line" title={`DUID ${lease.duid}`}>
          <span class="mono small secondary">{a}</span>
          {i === 0 && <Reserve6 l={lease} host={hostOf(lease)} row={row} addr={addrs[0]} run={run} />}
        </span>
      )))}
    </>
  )
}

const MAC_RE = /^[0-9a-f]{2}([:-]?[0-9a-f]{2}){5}$/i
const normMac = (v: string) => v.replace(/[^0-9a-f]/gi, '').toLowerCase().replace(/(..)(?!$)/g, '$1:')

/** Reserve an address for a device the router hasn't seen yet (type its MAC). */
function AddReservation({ m, rows, onClose }: { m: NetModel; rows: DeviceRow[]; onClose: () => void }) {
  const [name, setName] = useState('')
  const [mac, setMac] = useState('')
  const [ip, setIp] = useState('')
  const [tried, setTried] = useState(false)
  const nm = name.trim(), mc = mac.trim(), a = ip.trim()
  const known = MAC_RE.test(mc) ? rows.find((r) => r.mac.toLowerCase() === normMac(mc)) : undefined
  const nameErr = !nm ? 'Required' : !HOSTNAME_RE.test(nm) ? 'Letters, digits and hyphens' : undefined
  const macErr = !mc ? 'Required' : !MAC_RE.test(mc) ? 'e.g. 02:00:00:9b:10:42'
    : parseInt(normMac(mc).slice(0, 2), 16) & 1 ? 'Not a multicast address'
    : known?.reservedIp ? `Already reserved: ${displayName(known) ?? known.mac} at ${known.reservedIp}` : undefined
  const ipErr = !a ? 'Required' : checkReservedIp(m, rows, { mac: normMac(mc), online: 'offline' }, a)
  const err = nameErr || macErr || ipErr
  const net = a && !ipErr ? m.nets.find((n) => n.subnet && inSubnet(n.subnet, a)) : undefined
  const show = (e: string | undefined, v: string) => (e && (tried || (v && e !== 'Required')) ? e : undefined)
  const save = async () => {
    setTried(true)
    if (err) return
    // a device we already know (a lease, a name pin) keeps its host section
    if (known?.host) await uci.set('dhcp', known.host['.name'], { name: nm, ip: a })
    else await uci.add('dhcp', 'host', { name: nm, mac: normMac(mc), ip: a })
    onClose()
  }
  return (
    <Modal title="Add reservation" onClose={onClose} footer={<>
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" onClick={save} disabled={tried && !!err}>Reserve</Button>
    </>}>
      <form class="stack gap3" onSubmit={(e) => { e.preventDefault(); save() }}>
        <Field label="Name" error={show(nameErr, nm)}>
          <input class="input" value={name} autocomplete="off" spellcheck={false} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="MAC address" error={show(macErr, mc)} hint={known && !macErr ? `Known as ${displayName(known) ?? 'an unnamed device'}${known.ip ? ` (${known.ip})` : ''}` : undefined}>
          <input class="input mono" value={mac} autocomplete="off" spellcheck={false} onInput={(e) => setMac((e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="IP address" error={show(ipErr, a)} hint={net ? `on ${net.name}` : undefined}>
          <input class="input mono" value={ip} autocomplete="off" spellcheck={false} onInput={(e) => setIp((e.target as HTMLInputElement).value)} />
        </Field>
      </form>
    </Modal>
  )
}

/** odhcpd hostid: up to 32 bits of interface ID, hex */
const hostIdOf = (addr?: string) => {
  const [head, tail] = (addr ?? '').split('::')
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : []
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t]
  return groups.slice(-2).map((x) => x.padStart(4, '0')).join('').replace(/^0+/, '') || '1'
}

function Reserve6({ l, host, row, addr, run }: { l: Dhcp6Lease; host?: UciSection; row?: DeviceRow; addr?: string; run: (p: Promise<unknown>) => void }) {
  const label = row ? displayName(row) ?? row.mac : l.hostname ?? 'device'
  if (host) {
    const id = str(host.hostid) ?? ''
    return (
      <span class="row nowrap" style={{ justifyContent: 'flex-end' }}>
        <InlineEdit mono label={`IPv6 host ID of ${label}`} value={id} placeholder="any" width={90} display={<>::{id || <span class="muted">any</span>}</>}
          validate={(v) => (v && !/^[0-9a-f]{1,8}$/i.test(v) ? 'Hex, up to 8 digits' : undefined)}
          onSave={(v) => run(v ? uci.set('dhcp', host['.name'], { hostid: v.toLowerCase() }) : uci.remove('dhcp', host['.name'], ['hostid']))} />
        <Button variant="ghost" icon="trash" aria-label={`Remove IPv6 reservation for ${label}`}
          onClick={() => run(list(host.duid).length > 1 ? uci.set('dhcp', host['.name'], { duid: list(host.duid).filter((d) => d !== l.duid) })
            // a host section that only held this reservation goes entirely
            : !host.mac && !host.ip ? uci.remove('dhcp', host['.name'])
            : uci.remove('dhcp', host['.name'], ['duid', 'hostid']))} />
      </span>
    )
  }
  const reserve = () => {
    const v = { duid: l.duid, hostid: hostIdOf(addr) }
    if (row?.host) return run(uci.set('dhcp', row.host['.name'], v))
    const name = (row && displayName(row)) ?? l.hostname ?? `host-${l.duid.slice(-6)}`
    return run(uci.add('dhcp', 'host', { name: name.replace(/[^A-Za-z0-9-]/g, '-'), ...(row ? { mac: row.mac } : {}), ...v }))
  }
  return <Button variant="ghost" icon="pin" aria-label={`Reserve ${addr ?? 'IPv6'} for ${label}`} title={`Always give ${label} ${addr ?? 'the same address'}`} onClick={reserve} />
}
