// uhttpd can't send Cache-Control, and every image gives /index.html the same size, inode and
// mtime, so the same ETag: after a firmware update a browser may keep showing the old page (and
// its old app) for days. These refetch the page past the cache, which also replaces the cached
// copy, so the next load is the router's current UI. The page is fetched by its path alone, so
// a load at /?fresh (where /cgi-bin/luci sends a browser holding LuCI's old page) fixes the
// cache entry for / too.
const page = () => location.origin + location.pathname

/** Reload with the router's current index.html (after a reboot into a new image). */
export async function reloadFresh() {
  try { await fetch(page(), { cache: 'reload' }) } catch { /* offline: reload anyway */ }
  location.reload()
}

/** Once per app start: if the router's index.html no longer loads this bundle, reload (once). */
export function reloadIfStale(entry: string) {
  const me = new URL(entry).pathname.split('/').pop()
  if (!me) return
  if (location.search === '?fresh') history.replaceState(null, '', page() + location.hash)
  fetch(page(), { cache: 'reload' }).then((r) => (r.ok ? r.text() : '')).then((html) => {
    if (!html || html.includes(me)) return
    try {
      if (sessionStorage.getItem('er4-stale') === me) return
      sessionStorage.setItem('er4-stale', me)
    } catch { return }
    location.reload()
  }, () => {})
}
