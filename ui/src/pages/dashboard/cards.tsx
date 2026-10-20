// Dashboard cards: WAN, system.
import type { ComponentChildren } from 'preact'
import { resolvers, type DnsModel } from '../../api/dns'
import type { BoardInfo, DeviceStatus, NetInterface, SystemInfo } from '../../api/types'
import { bps, bytes, duration, linkSpeed, pct } from '../../components/format'
import { Icon } from '../../components/icons'
import { KV, Meter } from '../../components/readouts'
import { Trend } from '../../components/trend'
import { Badge, Card, ErrorBox } from '../../components/ui'
import type { Derived } from './live'

type Rate = NonNullable<Derived['rates'][number]>

const dash = <span class="muted">–</span>

function Loading() {
  return <div class="card-loading muted">Loading…</div>
}

// ---- WAN ---------------------------------------------------------------------------------
export function WanCard({ ifaces, dns, eth0, rate, error }: { ifaces?: NetInterface[]; dns?: DnsModel; eth0?: DeviceStatus; rate?: Rate['ports'][string]; error?: Error }) {
  const wan = ifaces?.find((i) => i.interface === 'wan')
  const wan6 = ifaces?.find((i) => i.interface === 'wan6')
  const gw = wan?.route?.find((r) => r.target === '0.0.0.0' && r.mask === 0)?.nexthop
  const v4 = wan?.['ipv4-address']?.[0]
  const v6 = wan6?.['ipv6-address']?.[0]
  const pfx = wan6?.['ipv6-prefix']?.[0]
  const carrier = eth0?.carrier
  // what dnsmasq forwards to, not just what the ISP offered
  const isp = wan?.['dns-server'] ?? []
  const used = dns ? resolvers(dns, isp) : isp.map((s) => ({ s, isp: true }))
  const ispUnused = !!dns && !dns.useIsp && isp.length > 0
  let status = <Badge>…</Badge>
  if (wan) {
    status = wan.up ? <Badge status="good">up</Badge>
      : carrier === false ? <Badge status="critical">down · no carrier</Badge>
      : <Badge status="warning">{wan.pending ? 'connecting' : 'down'}</Badge>
  }
  return (
    <Card title={<><Icon name="globe" size={13} class="head-icon" /> WAN</>} actions={status} class="wan-card">
      {error ? <ErrorBox error={error} /> : !wan ? <Loading /> : (
        <>
          <div class="wan-ip">
            <span class="label">Public IPv4</span>
            <span class="value mono">{v4 ? v4.address : <span class="muted">none</span>}</span>
            {v4 && <span class="muted mono">/{v4.mask}</span>}
          </div>
          {!wan.up && (
            <p class="wan-hint">
              {carrier === false
                ? 'eth0 has no link: check the cable to the modem/ONT, and that the modem is powered.'
                : `Waiting for ${wan.proto.toUpperCase()} on eth0…`}
            </p>
          )}
          <KV rows={[
            ['Gateway', gw ? <span class="mono">{gw}</span> : dash],
            ['DNS', used.length
              ? <a href="#/dns/upstream" class="wan-dns" title={isp.length ? `The ISP offers ${isp.join(', ')}${ispUnused ? ' (not used)' : ''}` : undefined}>
                  <span class="mono">{used.map((x) => x.s).join(', ')}</span>
                  {/* your own servers need no label; say when the ISP's are in use */}
                  {!dns?.upstream.length ? <span class="muted"> · ISP</span> : used.some((x) => x.isp) && <span class="muted"> · with the ISP's</span>}
                </a>
              : dash, used.map((x) => x.s).join(', ')],
            ['IPv6', v6 ? <span class="mono">{v6.address}/{v6.mask}</span> : <span class="muted">{wan6?.up ? 'no address' : wan6 ? 'down' : 'not configured'}</span>, v6?.address],
            pfx && ['IPv6 prefix', <span class="mono">{pfx.address}/{pfx.mask}</span>, `${pfx.address}/${pfx.mask}`],
            ['Protocol', <>{wan.proto.toUpperCase()}{wan6 ? <span class="muted"> · {wan6.proto.toUpperCase()}</span> : null}</>],
            ['Uptime', wan.up && wan.uptime != null ? duration(wan.uptime) : dash],
            ['Link', <span class="mono">{wan.l3_device ?? wan.device} <span class="muted">{eth0 ? linkSpeed(eth0.carrier ? eth0.speed : undefined) : ''}</span></span>],
            ['Now', wan.up && rate ? <span class="num">↓ {bps(rate.rxBps)} <span class="muted">·</span> ↑ {bps(rate.txBps)}</span> : dash],
            ['Since boot', eth0 ? <span class="num">↓ {bytes(eth0.statistics.rx_bytes)} <span class="muted">·</span> ↑ {bytes(eth0.statistics.tx_bytes)}</span> : dash],
          ]} />
        </>
      )}
    </Card>
  )
}

// ---- System -------------------------------------------------------------------------------
/** All cores as one CPU row (average, history on the right); one core far above the rest (a
 *  stuck single-threaded process) is called out, the per-core values are in the tooltip. */
function cpuRow(cores: number[], rates: (Rate | null)[]): [string, ComponentChildren] {
  const ok = cores.filter((c) => isFinite(c))
  const avg = ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : NaN
  const max = ok.length ? Math.max(...ok) : NaN
  const mean = (r: Rate | null) => (r ? r.cpu.reduce((a, b) => a + b, 0) / r.cpu.length : null)
  return ['CPU', (
    <span class="cpu-row" title={ok.length ? cores.map((c, i) => `cpu${i} ${pct(c)}`).join(' · ') : undefined}>
      <Meter value={avg / 100} thin status={avg > 90 ? 'critical' : avg > 75 ? 'warning' : undefined} label="CPU, all cores">
        {isFinite(avg) ? pct(avg) : '–'}{max - avg > 25 && <span class="muted"> · busiest core {pct(max)}</span>}
      </Meter>
      <Trend values={rates.slice(-60).map(mean)} width={64} height={16} max={100} />
    </span>
  )]
}

export function SystemCard({ board, info, rates, latest, error }: { board?: BoardInfo; info?: SystemInfo; rates: (Rate | null)[]; latest?: Rate; error?: Error }) {
  const mem = info?.memory
  const memUsed = mem ? (mem.total - mem.available) / mem.total : NaN
  const root = info?.root
  const rootUsed = root ? root.used / root.total : NaN
  const cores = latest?.cpu ?? [NaN, NaN, NaN, NaN]
  return (
    <Card title={<><Icon name="chip" size={13} class="head-icon" /> System</>} class="system-card"
      actions={info && <span class="muted num" title="Uptime">up {duration(info.uptime)}</span>}>
      {error ? <ErrorBox error={error} /> : !info || !board ? <Loading /> : (
        <div class="sys-grid">
          <KV rows={[
            cpuRow(cores, rates),
            ['Memory', <span title={mem ? `In use ${bytes(mem.total - mem.available)} · cache ${bytes(mem.cached)} · buffers ${bytes(mem.buffered)} · shared ${bytes(mem.shared)} · free ${bytes(mem.free)} · no swap` : undefined}>
              <Meter value={memUsed} thin status={memUsed > 0.9 ? 'critical' : memUsed > 0.8 ? 'warning' : undefined} label="Memory used">
                {mem ? `${bytes(mem.total - mem.available)} / ${bytes(mem.total)}` : '–'}
              </Meter></span>],
            ['Storage', <span title={`Root file system${info.tmp ? `; /tmp ${bytes(info.tmp.used * 1024)} of ${bytes(info.tmp.total * 1024)}` : ''}. Both live in RAM; settings are kept on the eMMC.`}>
              <Meter value={rootUsed} thin status={rootUsed > 0.9 ? 'critical' : undefined} label="Overlay used">
                {root ? `${bytes(root.used * 1024)} / ${bytes(root.total * 1024)}` : '–'}
              </Meter></span>],
            ['Load', <span class="num">{info.load.map((l) => (l / 65536).toFixed(2)).join('  ')} <span class="muted">/ 4 cores</span></span>],
            ['Firmware', <span title={board.release.description}>{board.release.distribution} {board.release.version} <span class="muted mono">{board.release.revision}</span></span>, board.release.description],
            ['Kernel', <span class="mono">{board.kernel}</span>],
            ['Model', board.model],
          ]} />
        </div>
      )}
    </Card>
  )
}
