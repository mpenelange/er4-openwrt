// App shell: login gate, sidebar, topbar, hash routing (#/dashboard, #/firewall/rules ...).
// Routes map to pages/<name>/index.tsx; a page owns everything under its first path segment.
import { useEffect, useState } from 'preact/hooks'
import type { ComponentType } from 'preact'
import { api, isMock } from './api/client'
import { router, routerClock } from './api/router'
import { useAsync } from './api/store'
import { Icon, type IconName } from './components/icons'
import { ChangesIndicator } from './components/changes'
import { Button } from './components/ui'
import { Login } from './pages/login'
import Dashboard from './pages/dashboard'
import Network from './pages/network'
import Dns from './pages/dns'
import Firewall from './pages/firewall'
import Devices from './pages/devices'
import Vpn from './pages/vpn'
import Diag from './pages/diag'
import System from './pages/system'

export interface PageProps {
  /** Path segments after the page's own, e.g. ['rules', 'cfg0992bd'] for #/firewall/rules/cfg0992bd */
  path: string[]
}

const PAGES: { id: string; label: string; icon: IconName; component: ComponentType<PageProps> }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard', component: Dashboard },
  { id: 'network', label: 'Network', icon: 'network', component: Network },
  { id: 'dns', label: 'DNS', icon: 'dns', component: Dns },
  { id: 'firewall', label: 'Firewall', icon: 'firewall', component: Firewall },
  { id: 'devices', label: 'Devices', icon: 'devices', component: Devices },
  { id: 'vpn', label: 'VPN', icon: 'vpn', component: Vpn },
  { id: 'diag', label: 'Diagnostics', icon: 'pulse', component: Diag },
  { id: 'system', label: 'System', icon: 'system', component: System },
]

/** Navigate: go('firewall', 'rules') -> #/firewall/rules */
export function go(...segments: string[]) {
  location.hash = '#/' + segments.map(encodeURIComponent).join('/')
}

function useHashPath() {
  const read = () => location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
  const [path, setPath] = useState(read)
  useEffect(() => {
    const h = () => setPath(read())
    addEventListener('hashchange', h)
    return () => removeEventListener('hashchange', h)
  }, [])
  return path
}

function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState(params.get('theme') ?? localStorage.getItem('er4.theme') ?? 'auto')
  useEffect(() => {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('er4.theme', theme)
  }, [theme])
  const next = () => setTheme((t) => (t === 'auto' ? 'dark' : t === 'dark' ? 'light' : 'auto'))
  return [theme, next]
}

const params = new URLSearchParams(location.search)

export function App() {
  const [loggedIn, setLoggedIn] = useState(api.loggedIn)
  useEffect(() => api.onLogout(() => setLoggedIn(false)), [])
  // Screenshots / demos: ?mock&autologin skips the login form (mock backend only)
  useEffect(() => {
    if (isMock && params.has('autologin') && !api.loggedIn) api.login('root', 'mock').then(() => setLoggedIn(true))
  }, [])
  if (!loggedIn) return isMock && params.has('autologin') ? null : <Login onLogin={() => setLoggedIn(true)} />
  return <Shell />
}

function Shell() {
  const path = useHashPath()
  const [theme, nextTheme] = useTheme()
  const board = useAsync(router.board, [], [])
  // Narrow screens: the sidebar is hidden and opens as an overlay from the topbar's menu button
  const [navOpen, setNavOpen] = useState(false)
  useEffect(() => {
    if (!navOpen) return
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setNavOpen(false) }
    addEventListener('keydown', esc)
    return () => removeEventListener('keydown', esc)
  }, [navOpen])
  // router timestamps are compared with the router's clock, which may be off (no NTP yet)
  useEffect(() => {
    const sync = () => routerClock.sync().catch(() => {})
    sync()
    const t = setInterval(sync, 300_000)
    return () => clearInterval(t)
  }, [])
  const page = PAGES.find((p) => p.id === path[0]) ?? PAGES[0]
  const Page = page.component
  return (
    <div class="shell">
      {navOpen && <div class="backdrop nav-backdrop" onClick={() => setNavOpen(false)} />}
      <aside class={`sidebar${navOpen ? ' open' : ''}`}>
        <div class="brand"><Icon name="bolt" size={18} /> {board.data?.hostname ?? 'ER-4'}</div>
        <nav onClick={() => setNavOpen(false)}>
          {PAGES.map((p) => (
            <a href={`#/${p.id}`} class={p.id === page.id ? 'active' : ''}><Icon name={p.icon} /> {p.label}</a>
          ))}
        </nav>
        <div class="foot">
          {board.data ? `${board.data.release.distribution} ${board.data.release.version} · ${board.data.kernel}` : ''}
          {isMock && <div>mock backend</div>}
        </div>
      </aside>
      <header class="topbar">
        <button type="button" class="btn ghost icon nav-toggle" aria-label="Menu" aria-expanded={navOpen} onClick={() => setNavOpen(!navOpen)}><Icon name="menu" /></button>
        <strong>{page.label}</strong>
        <span class="spacer" />
        <ChangesIndicator />
        <Button variant="ghost" icon={theme === 'light' ? 'sun' : 'moon'} aria-label={`Theme: ${theme}`} title={`Theme: ${theme}`} onClick={nextTheme} />
        <Button variant="ghost" icon="logout" aria-label="Log out" title="Log out" onClick={() => api.logout()} />
      </header>
      <main class="main">
        <Page path={path.slice(1)} />
      </main>
    </div>
  )
}
