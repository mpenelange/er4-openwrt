// DNS (dnsmasq, UCI 'dhcp'): the lookup path a query takes (local names → domain forwards →
// upstream), drawn like the firewall zone map, and every record in one table. Routes:
//   #/dns                 overview          #/dns/new        add a record
//   #/dns/<section>       edit host/alias   #/dns/fwd:<dom>  edit a domain forward   #/dns/addr:<dom>  wildcard/block
//   #/dns/upstream        upstream servers, ISP toggle   #/dns/domain  the local domain
// Everything is staged; applying happens from the top bar.
import { useState } from 'preact/hooks'
import type { PageProps } from '../../app'
import { go } from '../../app'
import { uci } from '../../api/uci'
import { router } from '../../api/router'
import { useAsync } from '../../api/store'
import { stagedSections } from '../../api/firewall'
import { dns, dnsModel, isIp, isIp6, nameClash, nameError, resolveChain, resolvers, serverError, type DnsModel, type DnsRecord, type RecordKind } from '../../api/dns'
import { DevicePicker, useKnownDevices, type KnownDevice } from '../../components/device-picker'
import { Badge, Button, Card, Drawer, Empty, ErrorBox, Field, PageHead, Segmented, Toggle } from '../../components/ui'
import { Chips } from '../../components/chips'
import { Icon } from '../../components/icons'
import './dns.css'

type Filter = 'all' | 'local' | 'forward'
const plural = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`
const routeId = (r: DnsRecord) => (r.kind === 'forward' ? `fwd:${r.name}` : r.kind === 'address' ? `addr:${r.name}` : r.id)
const ORDER: RecordKind[] = ['host', 'cname', 'address', 'forward', 'dhcp']
const wild = (r: DnsRecord) => r.kind === 'forward' || r.kind === 'address'

export default function Dns({ path }: PageProps) {
  const [id] = path.map((p) => p.replace(/\?.*$/, '')).filter(Boolean)
  const devices = useKnownDevices()
  const data = useAsync(async () => {
    const [dhcp, staged, ifaces] = await Promise.all([uci.get('dhcp'), stagedSections(), router.interfaces().catch(() => [])])
    return { dhcp, staged: staged.dhcp ?? new Set<string>(), ispDns: ifaces.find((i) => i.interface === 'wan')?.['dns-server'] ?? [] }
  })
  const [filter, setFilter] = useState<Filter>('all')
  const [q, setQ] = useState('')
  const d = data.data
  const m = d && dnsModel(d.dhcp, devices.data ?? [])
  const close = () => go('dns')
  const editing = m && id && id !== 'new' && id !== 'upstream' && id !== 'domain' ? m.records.find((r) => routeId(r) === id && r.kind !== 'dhcp') : undefined

  return (
    <div class="page dns-page">
      <PageHead title="DNS">
        {m && <Button icon="globe" title="The domain local names answer under" onClick={() => go('dns', 'domain')}>Domain: <span class="mono">{m.domain}</span></Button>}
        <Button variant="primary" icon="plus" onClick={() => go('dns', 'new')}>Add record</Button>
      </PageHead>
      {data.error && <ErrorBox error={`Couldn't read the DNS configuration: ${data.error.message}`} />}
      {!m && !data.error && <Empty>Loading DNS configuration…</Empty>}
      {m && d && (
        <>
          <Card title="Lookup path">
            <LookupPath m={m} ispDns={d.ispDns} serversStaged={d.staged.has(m.section)} onFilter={setFilter} />
          </Card>
          <Card flush title={`Records · ${m.records.length}`} actions={<>
            <input class="input dns-search" type="search" placeholder="Search" aria-label="Search records" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
            <Segmented value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'local', label: 'Local' }, { value: 'forward', label: 'Forwards' }]} />
          </>}>
            <Records m={m} staged={d.staged} filter={filter} q={q} />
          </Card>
        </>
      )}
      {m && id === 'new' && <RecordDrawer m={m} devices={devices.data ?? []} onClose={close} />}
      {m && editing && <RecordDrawer m={m} rec={editing} devices={devices.data ?? []} onClose={close} />}
      {m && d && id === 'upstream' && <UpstreamDrawer m={m} ispDns={d.ispDns} onClose={close} />}
      {m && id === 'domain' && <DomainDrawer m={m} onClose={close} />}
    </div>
  )
}

// ---- lookup path ----------------------------------------------------------------------------
function LookupPath({ m, ispDns, serversStaged, onFilter }: { m: DnsModel; ispDns: string[]; serversStaged: boolean; onFilter: (f: Filter) => void }) {
  const n = (k: RecordKind) => m.records.filter((r) => r.kind === k).length
  const blocked = m.records.filter((r) => r.kind === 'address' && !r.value).length
  const fwd = m.records.filter((r) => r.kind === 'forward')
  const servers = resolvers(m, ispDns)
  return (
    <div class="lookup" aria-label="How a DNS query is answered">
      <div class="lk-query"><Icon name="search" size={14} /> query</div>
      <Arrow />
      <button type="button" class="lk-node" onClick={() => onFilter('local')}>
        <span class="lk-title">Local names <b class="num">{n('host') + n('cname') + n('dhcp') + n('address')}</b></span>
        <span class="lk-line mono">*.{m.domain}{!m.localOnly && <span class="muted"> · rest upstream</span>}</span>
        <span class="lk-line muted">{plural(n('host'), 'hostname')} · {plural(n('cname'), 'alias', 'aliases')} · {n('dhcp')} DHCP</span>
        {n('address') > 0 && <span class="lk-line muted">{plural(blocked, 'blocked domain')} · {plural(n('address') - blocked, 'wildcard')}</span>}
      </button>
      <Arrow label="else" />
      <button type="button" class="lk-node" onClick={() => onFilter('forward')}>
        <span class="lk-title">Domain forwards <b class="num">{fwd.length}</b></span>
        {fwd.slice(0, 3).map((f) => <span class="lk-line mono">{f.name} → {f.value}</span>)}
        {fwd.length > 3 && <span class="lk-line muted">+{fwd.length - 3} more</span>}
        {!fwd.length && <span class="lk-line muted">none</span>}
      </button>
      <Arrow label="else" />
      <button type="button" class="lk-node" onClick={() => go('dns', 'upstream')}>
        <span class="lk-title">Upstream {serversStaged && <Badge status="accent">unapplied</Badge>}</span>
        {servers.map((x) => <span class="lk-line mono">{x.s}{x.isp && <span class="muted"> ISP</span>}</span>)}
        {!servers.length && <span class="lk-line"><Badge status="warning">none</Badge> <span class="muted">only local names resolve</span></span>}
      </button>
    </div>
  )
}

function Arrow({ label }: { label?: string }) {
  return <span class="lk-arrow" aria-hidden="true">{label && <span class="lk-arrow-label">{label}</span>}<i /></span>
}

// ---- records table ----------------------------------------------------------------------------
const TYPE: Record<RecordKind, (r: DnsRecord) => string> = {
  host: (r) => (isIp6(r.value) ? 'AAAA' : 'A'), dhcp: () => 'A', cname: () => 'CNAME', forward: () => 'FORWARD',
  address: (r) => (r.value ? 'WILDCARD' : 'BLOCK'),
}

function Records({ m, staged, filter, q }: { m: DnsModel; staged: Set<string>; filter: Filter; q: string }) {
  const s = q.trim().toLowerCase()
  const rows = m.records
    .filter((r) => filter === 'all' || (filter === 'forward' ? r.kind === 'forward' : r.kind !== 'forward'))
    .filter((r) => !s || r.fqdn.toLowerCase().includes(s) || r.value.toLowerCase().includes(s))
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.fqdn.localeCompare(b.fqdn))
  if (!rows.length) return <Empty>{m.records.length ? 'No record matches.' : 'No DNS records yet.'}</Empty>
  return (
    <table class="table dns-table">
      <thead><tr><th>Type</th><th>Name</th><th>Value</th><th>From</th></tr></thead>
      <tbody>
        {rows.map((r) => {
          const unapplied = wild(r) ? staged.has(m.section) : staged.has(r.id)
          return (
            <tr class="clickable" onClick={() => (r.kind === 'dhcp' ? go('devices') : go('dns', routeId(r)))}
              title={r.kind === 'dhcp' ? 'From DHCP: edit on the Devices page' : undefined}>
              <td><span class={`rtype ${r.kind}`}>{TYPE[r.kind](r)}</span></td>
              <td class="mono">{wild(r) ? `*.${r.name}` : r.fqdn} {unapplied && <Badge status="accent">unapplied</Badge>}</td>
              <td><Value m={m} r={r} /></td>
              <td class="muted">{r.from === 'manual' ? 'manual' : r.from === 'reservation' ? 'reservation' : 'DHCP lease'}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function Value({ m, r }: { m: DnsModel; r: DnsRecord }) {
  if (r.kind === 'forward') return <span class="mono">asks {r.value}</span>
  if (r.kind === 'address') return r.value ? <span class="mono">{r.value}</span> : <span class="muted">no such domain (blocked)</span>
  if (r.kind !== 'cname') return <span class="mono">{r.value}</span>
  const chain = resolveChain(m, r.value)
  return chain
    ? <span class="mono">→ {chain.join(' → ')}</span>
    : <span class="row nowrap"><span class="mono">→ {r.value}</span><Badge status="warning">no such local name</Badge></span>
}

// ---- add / edit a record ---------------------------------------------------------------------
type EditKind = 'host' | 'cname' | 'forward' | 'address'

function RecordDrawer({ m, rec, devices, onClose }: { m: DnsModel; rec?: DnsRecord; devices: KnownDevice[]; onClose: () => void }) {
  const [kind, setKind] = useState<EditKind>((rec?.kind as EditKind) ?? 'host')
  const [name, setName] = useState(rec?.name ?? '')
  const [value, setValue] = useState(rec?.value ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  const fq = name.includes('.') || kind === 'forward' || kind === 'address' ? name : `${name}.${m.domain}`
  const forwards = dns.forwardsOf(m)
  const addresses = dns.addressesOf(m)
  const [block, setBlock] = useState(rec?.kind === 'address' && !rec.value)

  const clash = kind !== 'forward' && kind !== 'address' && name ? nameClash(m, name, rec?.id) : undefined
  const chain = kind === 'cname' && value ? resolveChain(m, value) : undefined
  const errs = {
    name: nameError(name) ?? (clash && clash.kind !== 'dhcp' ? `${clash.fqdn} already exists (${clash.kind === 'cname' ? 'alias' : 'hostname'})` : undefined)
      ?? (kind === 'forward' && forwards.some((f) => f.domain === name && f.domain !== rec?.name) ? `${name} is already forwarded` : undefined)
      ?? (kind === 'address' && addresses.some((f) => f.domain === name && f.domain !== rec?.name) ? `${name} already has an override` : undefined),
    value: kind === 'host' ? (!value ? 'Pick a device or type an address' : !isIp(value) ? 'Not an IPv4 or IPv6 address' : undefined)
      : kind === 'cname' ? (nameError(value) ?? (value === name ? 'An alias can’t point to itself' : undefined))
      : kind === 'address' ? (block ? undefined : !value ? 'An address, or Block' : !isIp(value) ? 'Not an IPv4 or IPv6 address' : undefined)
      : serverError(value),
  }
  const invalid = Object.values(errs).some(Boolean)

  const save = async () => {
    setBusy(true)
    try {
      if (kind === 'forward') {
        const rest = forwards.filter((f) => f.domain !== rec?.name)
        await dns.setServers(m, [...rest, { domain: name, server: value }], m.upstream)
      } else if (kind === 'address') {
        await dns.setAddresses(m, [...addresses.filter((f) => f.domain !== rec?.name), { domain: name, ip: block ? '' : value }])
      } else if (rec) await dns.update(rec.id, kind === 'host' ? { name, ip: value } : { cname: name, target: value })
      else await (kind === 'host' ? dns.addHost(name, value) : dns.addCname(name, value))
      onClose()
    } catch (e) { setError(e); setBusy(false) }
  }
  const remove = async () => {
    try {
      if (rec!.kind === 'forward') await dns.setServers(m, forwards.filter((f) => f.domain !== rec!.name), m.upstream)
      else if (rec!.kind === 'address') await dns.setAddresses(m, addresses.filter((f) => f.domain !== rec!.name))
      else await dns.remove(rec!.id)
      onClose()
    } catch (e) { setError(e) }
  }
  const localNames = m.records.filter((r) => !wild(r) && r.id !== rec?.id).map((r) => r.fqdn)

  return (
    <Drawer title={rec ? (kind === 'forward' ? `Forward ${rec.name}` : kind === 'address' ? `*.${rec.name}` : rec.fqdn) : 'New DNS record'} onClose={onClose} footer={<>
      {rec && <Button variant="danger" icon="trash" onClick={remove}>Delete</Button>}
      <span style={{ flex: 1 }} />
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" icon="check" disabled={busy || invalid} onClick={save}>{rec ? 'Stage changes' : 'Add record'}</Button>
    </>}>
      <div class="stack">
        <div class="preview-box" aria-live="polite">
          <span class="label">Preview</span>
          <span class="mono">
            {kind === 'forward' ? `*.${name || 'example.com'} → asks ${value || 'server'}`
              : kind === 'address' ? `${name || 'example.com'} and *.${name || 'example.com'} → ${block ? 'no such domain' : value || 'address'}`
              : kind === 'cname' ? `${fq || 'alias'} → ${chain ? chain.join(' → ') : value || 'target'}`
              : `${fq || 'name'} → ${value || 'address'}`}
          </span>
          {clash?.kind === 'dhcp' && <div class="warn-line"><Icon name="info" size={13} /> {clash.fqdn} is also a DHCP name ({clash.value}); this record answers instead.</div>}
          {kind === 'cname' && value && !chain && !errs.value && <div class="warn-line"><Icon name="warning" size={13} /> {value} isn’t a local name, so dnsmasq won’t answer this alias.</div>}
        </div>
        {error ? <ErrorBox error={error} /> : null}
        {!rec && (
          <Field label="Type">
            <Chips value={kind} onChange={(k) => { setKind(k); setValue('') }} label="Record type" options={[
              { value: 'host', label: 'Hostname' }, { value: 'cname', label: 'Alias (CNAME)' }, { value: 'forward', label: 'Forward a domain' },
              { value: 'address', label: 'Wildcard or block' },
            ]} />
          </Field>
        )}
        <Field label={kind === 'forward' || kind === 'address' ? 'Domain' : kind === 'cname' ? 'Alias' : 'Name'} error={name ? errs.name : undefined}
          hint={kind === 'forward' || kind === 'address' ? 'It and all its subdomains' : name && !name.includes('.') ? `Answers as ${fq}` : undefined}>
          <input class={`input mono${name && errs.name ? ' invalid' : ''}`} value={name} placeholder={kind === 'forward' ? 'corp.example' : kind === 'address' ? 'ads.example.com' : kind === 'cname' ? 'files' : 'printer'}
            onInput={(e) => setName((e.target as HTMLInputElement).value.trim().toLowerCase())} />
        </Field>
        {kind === 'host' && (
          <Field label="Address" error={undefined}>
            <DevicePicker value={value} devices={devices} onChange={(ip, dev) => { setValue(ip); if (!name && dev?.name) setName(dev.name.toLowerCase()) }} />
          </Field>
        )}
        {kind === 'cname' && (
          <Field label="Points to" error={value ? errs.value : undefined}>
            <input class={`input mono${value && errs.value ? ' invalid' : ''}`} list="dns-local-names" value={value} placeholder="nas"
              onInput={(e) => setValue((e.target as HTMLInputElement).value.trim().toLowerCase())} />
          </Field>
        )}
        {kind === 'address' && (
          <Field label="Answer" error={!block && value ? errs.value : undefined}>
            <div class="stack">
              <Segmented value={block ? 'block' : 'addr'} onChange={(v) => setBlock(v === 'block')} options={[{ value: 'addr', label: 'An address' }, { value: 'block', label: 'Block' }]} />
              {!block && <input class={`input mono${value && errs.value ? ' invalid' : ''}`} value={value} placeholder="192.168.1.20" aria-label="Answer address"
                onInput={(e) => setValue((e.target as HTMLInputElement).value.trim())} />}
            </div>
          </Field>
        )}
        {kind === 'cname' && <datalist id="dns-local-names">{localNames.map((n) => <option value={n} />)}</datalist>}
        {kind === 'forward' && (
          <Field label="DNS server" error={value ? errs.value : undefined}>
            <input class={`input mono${value && errs.value ? ' invalid' : ''}`} value={value} placeholder="10.8.0.1"
              onInput={(e) => setValue((e.target as HTMLInputElement).value.trim())} />
          </Field>
        )}
      </div>
    </Drawer>
  )
}

// ---- upstream servers, ISP toggle, local domain ----------------------------------------------
const PRESETS = [
  { label: 'Cloudflare', servers: ['1.1.1.1', '1.0.0.1'] },
  { label: 'Quad9', servers: ['9.9.9.9', '149.112.112.112'] },
  { label: 'Google', servers: ['8.8.8.8', '8.8.4.4'] },
]

// ---- local domain ------------------------------------------------------------------------------
function DomainDrawer({ m, onClose }: { m: DnsModel; onClose: () => void }) {
  const [domain, setDomain] = useState(m.domain)
  const [localOnly, setLocalOnly] = useState(m.localOnly)
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const d = domain.trim().toLowerCase().replace(/\.$/, '')
  const err = nameError(d)
  const changed = d !== m.domain || localOnly !== m.localOnly
  // a few real local names for the preview
  const names = [...new Set(m.records.filter((r) => (r.kind === 'host' || r.kind === 'dhcp' || r.kind === 'cname') && !r.name.includes('.')).map((r) => r.name))].slice(0, 3)
  const save = async () => {
    setBusy(true)
    try { await dns.setDomain(m, d, localOnly); onClose() } catch (e) { setError(e) } finally { setBusy(false) }
  }
  return (
    <Drawer title="Local domain" onClose={onClose} footer={<>
      <span style={{ flex: 1 }} />
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" icon="check" disabled={busy || !!err || !changed} onClick={save}>Stage changes</Button>
    </>}>
      <div class="stack">
        {error ? <ErrorBox error={error} /> : null}
        <p class="secondary" style={{ margin: 0 }}>
          Devices on your networks get names under this domain: from DHCP, reservations and the records on this page.
          It's also the search domain DHCP hands out, so a bare <span class="mono">nas</span> works too.
        </p>
        <Field label="Domain" error={domain && err ? err : undefined} hint="lan is OpenWrt's default; a domain you own works too (e.g. home.example.com or example.com)">
          <input class="input mono" value={domain} placeholder="lan" spellcheck={false} autocapitalize="off"
            onInput={(e) => setDomain((e.target as HTMLInputElement).value)} onKeyDown={(e) => { if (e.key === 'Enter' && !err && changed) save() }} />
        </Field>
        {!err && (
          <div class="dns-domain-preview">
            {(names.length ? names : ['nas', 'printer']).map((n) => <span class="mono">{n}.<b>{d}</b></span>)}
          </div>
        )}
        <Field label="Other names under this domain">
          <div class="stack">
            <Segmented value={localOnly ? 'local' : 'upstream'} onChange={(v) => setLocalOnly(v === 'local')}
              options={[{ value: 'local', label: 'Not found' }, { value: 'upstream', label: 'Ask upstream' }]} />
            <span class="secondary small">
              {localOnly
                ? <>A name under <span class="mono">{d || m.domain}</span> that isn't local gets "no such name", and queries for it never leave your network. Right for a private domain.</>
                : <>Local names are answered here; anything else under <span class="mono">{d || m.domain}</span> (a website, mail) is looked up upstream as usual. Right for a domain you own that also has public DNS records.</>}
            </span>
          </div>
        </Field>
        {changed && <div class="note"><Icon name="info" /> Devices pick up a new domain when they renew their DHCP lease; reconnecting does it at once.</div>}
      </div>
    </Drawer>
  )
}

function UpstreamDrawer({ m, ispDns, onClose }: { m: DnsModel; ispDns: string[]; onClose: () => void }) {
  const [adding, setAdding] = useState('')
  const [error, setError] = useState<unknown>()
  const forwards = dns.forwardsOf(m)
  const run = (p: Promise<unknown>) => p.catch(setError)
  const setUp = (list: string[]) => run(dns.setServers(m, forwards, list))
  const addErr = adding ? serverError(adding) ?? (m.upstream.includes(adding) ? 'Already in the list' : undefined) : undefined
  const add = () => { if (adding && !addErr) { setUp([...m.upstream, adding]); setAdding('') } }
  // The switch picks one source: the ISP's servers, or your own list. Turning it on clears your
  // list (dnsmasq would otherwise use both); turning it off again brings that list back.
  const [stash, setStash] = useState<string[]>([])
  const setIsp = async (on: boolean) => {
    try {
      if (on && m.upstream.length) { setStash(m.upstream); await dns.setServers(m, forwards, []) }
      await dns.setUseIsp(m, on)
      if (!on && !m.upstream.length && stash.length) await dns.setServers(m, forwards, stash)
    } catch (e) { setError(e) }
  }
  const [allow, setAllow] = useState('')
  const allowErr = allow ? nameError(allow) ?? (m.rebindAllow.includes(allow) ? 'Already allowed' : undefined) : undefined
  const addAllow = () => { if (allow && !allowErr) { run(dns.setRebindAllow(m, [...m.rebindAllow, allow])); setAllow('') } }

  return (
    <Drawer title="Upstream DNS" onClose={onClose} footer={<><span style={{ flex: 1 }} /><Button onClick={onClose}>Close</Button></>}>
      <div class="stack">
        {error ? <ErrorBox error={error} /> : null}
        {!m.useIsp && !m.upstream.length && <div class="note warn"><Icon name="warning" /> No upstream server: only local names resolve.</div>}
        <Field label="Servers">
          <div class="stack dns-servers">
            <label class="row">
              <Toggle on={m.useIsp} label="Use the ISP’s DNS servers" onChange={setIsp} />
              <span>Use the ISP’s DNS servers</span>
            </label>
            {m.useIsp && (
              <>
                {ispDns.map((s) => (
                  <div class="row dns-server locked" title="Offered by the ISP: turn off the switch to use your own">
                    <span class="mono">{s}</span>
                    <span style={{ flex: 1 }} />
                    <Badge>ISP</Badge>
                  </div>
                ))}
                {!ispDns.length && <span class="muted small">The ISP hasn’t offered any (is the WAN up?)</span>}
                {/* set before this switch existed in this form: dnsmasq uses these alongside the ISP's */}
                {m.upstream.map((s) => (
                  <div class="row dns-server">
                    <span class="mono">{s}</span>
                    <span class="muted small">also used</span>
                    <span style={{ flex: 1 }} />
                    <Button variant="ghost" icon="trash" aria-label={`Remove ${s}`} onClick={() => setUp(m.upstream.filter((x) => x !== s))} />
                  </div>
                ))}
              </>
            )}
            {!m.useIsp && (
              <>
                {m.upstream.map((s) => (
                  <div class="row dns-server">
                    <span class="mono">{s}</span>
                    <span style={{ flex: 1 }} />
                    <Button variant="ghost" icon="trash" aria-label={`Remove ${s}`} onClick={() => setUp(m.upstream.filter((x) => x !== s))} />
                  </div>
                ))}
                <div class="row">
                  <input class={`input mono${addErr ? ' invalid' : ''}`} placeholder="1.1.1.1" aria-label="Add a DNS server" value={adding}
                    onInput={(e) => setAdding((e.target as HTMLInputElement).value.trim())} onKeyDown={(e) => e.key === 'Enter' && add()} />
                  <Button icon="plus" disabled={!adding || !!addErr} onClick={add}>Add</Button>
                </div>
                {addErr && <span class="error small">{addErr}</span>}
                <div class="chips">
                  {PRESETS.map((p) => {
                    const on = p.servers.every((s) => m.upstream.includes(s))
                    return (
                      <button type="button" class={`chip${on ? ' on' : ''}`} aria-pressed={on}
                        onClick={() => setUp(on ? m.upstream.filter((s) => !p.servers.includes(s)) : [...m.upstream, ...p.servers.filter((s) => !m.upstream.includes(s))])}>
                        {p.label}<span class="chip-hint">{p.servers[0]}</span>
                      </button>
                    )
                  })}
                </div>
              </>
            )}
          </div>
        </Field>
        <Field label="Rebind protection">
          <div class="stack">
            <label class="row">
              <Toggle on={m.rebind} label="Rebind protection" onChange={(on) => run(dns.setRebind(m, on))} />
              <span>Drop internet answers that point to private addresses</span>
            </label>
            {m.rebind && (
              <div class="stack dns-servers" aria-label="Allowed to answer with private addresses">
                {m.rebindAllow.map((dmn) => (
                  <div class="row dns-server">
                    <span class="mono">{dmn}</span>
                    <span style={{ flex: 1 }} />
                    <Button variant="ghost" icon="trash" aria-label={`Remove ${dmn}`} onClick={() => run(dns.setRebindAllow(m, m.rebindAllow.filter((x) => x !== dmn)))} />
                  </div>
                ))}
                <div class="row">
                  <input class={`input mono${allowErr ? ' invalid' : ''}`} placeholder="plex.direct" aria-label="Allow a domain" value={allow}
                    onInput={(e) => setAllow((e.target as HTMLInputElement).value.trim().toLowerCase())} onKeyDown={(e) => e.key === 'Enter' && addAllow()} />
                  <Button icon="plus" disabled={!allow || !!allowErr} onClick={addAllow}>Allow</Button>
                </div>
                {allowErr && <span class="error small">{allowErr}</span>}
              </div>
            )}
          </div>
        </Field>
        <label class="row">
          <Toggle on={m.logQueries} label="Log every query" onChange={(on) => run(dns.setLogQueries(m, on))} />
          <span>Log every query to the system log</span>
        </label>
      </div>
    </Drawer>
  )
}
