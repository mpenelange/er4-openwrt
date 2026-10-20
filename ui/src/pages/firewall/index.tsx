// Firewall (fw4 / UCI firewall): #/firewall/zones (map, matrix, policies), #/firewall/rules
// (readable, drag to reorder), #/firewall/forwards (port forwards), #/firewall/nat (source NAT). A section id after the tab
// opens its editor: #/firewall/rules/cfg0992bd, #/firewall/forwards/new.
// Everything is staged (uci.set/add/remove/order); applying happens from the top bar.
import type { PageProps } from '../../app'
import { uci } from '../../api/uci'
import { useAsync } from '../../api/store'
import { firewallStatus, ofType, stagedSections, zones } from '../../api/firewall'
import { Button, ErrorBox, PageHead } from '../../components/ui'
import { Tabs } from '../../components/tabs'
import { FwCtx, type FwData } from './parts'
import { ZonesView } from './zones'
import { RulesView } from './rules'
import { ForwardsView } from './forwards'
import { NatView } from './nat'
import './firewall.css'

/** Path segments without a trailing "?scenario=..." (mock/demo query in the hash). */
export const cleanPath = (path: string[]) => path.map((p) => p.replace(/\?.*$/, '')).filter(Boolean)

const TABS = ['zones', 'rules', 'forwards', 'nat'] as const

export default function Firewall({ path }: PageProps) {
  const [tab0, id] = cleanPath(path)
  const tab = (TABS as readonly string[]).includes(tab0) ? (tab0 as (typeof TABS)[number]) : 'zones'
  const data = useAsync<FwData>(async () => {
    const [fw, net, staged] = await Promise.all([uci.get('firewall'), uci.get('network').catch(() => ({})), stagedSections()])
    return { fw, net, zones: zones(fw), staged: staged.firewall ?? new Set() }
  })
  const status = useAsync(() => firewallStatus().catch(() => undefined), [], ['applied'])
  const d = data.data && { ...data.data, hits: status.data?.counters }
  const count = (t: string) => (d ? ofType(d.fw, t).length : undefined)

  return (
    <div class="page fw">
      <PageHead title="Firewall">
        {data.loading && d && <span class="muted" style={{ fontSize: 'var(--fs-sm)' }}>refreshing…</span>}
      </PageHead>
      <Tabs active={tab} items={[
        { id: 'zones', label: 'Zones', href: '#/firewall/zones', count: d?.zones.length },
        { id: 'rules', label: 'Traffic rules', href: '#/firewall/rules', count: count('rule') },
        { id: 'forwards', label: 'Port forwards', href: '#/firewall/forwards', count: count('redirect') },
        { id: 'nat', label: 'NAT', href: '#/firewall/nat', count: count('nat') },
      ]} />
      {data.error && (
        <div class="row">
          <ErrorBox error={`Couldn't read the firewall configuration: ${data.error.message}`} />
          <Button icon="undo" onClick={data.reload}>Retry</Button>
        </div>
      )}
      {!d && data.loading && <div class="fw-skeleton" aria-busy="true"><div /><div /><div /></div>}
      {d && (
        <FwCtx.Provider value={d}>
          {tab === 'zones' && <ZonesView openId={id} />}
          {tab === 'rules' && <RulesView openId={id} />}
          {tab === 'forwards' && <ForwardsView openId={id} />}
          {tab === 'nat' && <NatView openId={id} />}
        </FwCtx.Provider>
      )}
    </div>
  )
}
