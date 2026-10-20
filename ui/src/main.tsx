import { render } from 'preact'
import './styles/tokens.css'
import './styles/base.css'
import './styles/charts.css'
import { reloadIfStale } from './api/fresh'

// Clickjacking: uhttpd can't send X-Frame-Options / frame-ancestors, so refuse to run framed.
// Checked before the app is even loaded (dynamic import below).
if (window.top !== window.self) {
  document.getElementById('app')!.textContent = 'The ER-4 web UI cannot be shown inside another page. Open it directly.'
} else {
  import('./app').then(({ App }) => render(<App />, document.getElementById('app')!))
  if (!import.meta.env.DEV) reloadIfStale(import.meta.url)
}
