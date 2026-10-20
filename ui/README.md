# ER-4 web UI

A compact single-page admin UI for the EdgeRouter 4 OpenWrt image, built with Preact,
TypeScript and Vite. It is plain static files, served by uhttpd at `/`, and talks to the router
over ubus JSON-RPC (`/ubus`, rpcd), the same API LuCI uses.

It replaces LuCI in the image. The package is `openwrt/package/utils/er4-ui`: it installs the
built `dist/`, the `er4` rpcd plugin (`files/er4.uc`) for what rpcd and netifd don't offer, and
an ACL (`files/er4.acl.json`) that grants the calls the UI makes. The few LuCI backends the UI
uses (rpcd-mod-luci for `luci-rpc`, cgi-io for uploads and backups) are package dependencies.

## Development

Needs Node.js 20.19 or newer.

```
npm ci
npm run dev          # http://127.0.0.1:5173 with the mock backend (log in as root, any password)
npm run typecheck
npm run build        # dist/, which the er4-ui package picks up
```

The dev server runs an in-browser **mock router** (`src/api/mock/`) unless `VITE_UBUS` is set,
so the whole UI can be developed without hardware. The mock behaves like rpcd where the UI
depends on it: changes are staged per session, apply arms a rollback that reverts unless
confirmed, and change lists look like rpcd's. The mock menu on the System page switches it
into edge states (WAN down, no link, errors, slow replies, empty and very full configs); the
same scenarios can be set in the URL, e.g. `?mock&scenario=wan-down` or
`#/firewall?scenario=fw-many`. `?mock&autologin` skips the login form.

To develop against a real router, point the dev server at it. It proxies `/ubus` and
`/cgi-bin`, so the router sees same-origin requests:

```
VITE_UBUS=http://192.168.1.1 npm run dev
```

## Layout

| Path | What |
|---|---|
| `src/app.tsx` | shell: login, sidebar, top bar, hash routing |
| `src/api/ubus.ts` | JSON-RPC client and sessions |
| `src/api/uci.ts` | UCI reads, staging, apply with rollback and confirm |
| `src/api/router.ts` | non-UCI reads (`system`, `network.*`, `luci-rpc`, `er4.*`) and rates |
| `src/api/<area>.ts` | the model for one area (network, firewall, DNS, VPN, ...) |
| `src/api/types.ts` | reply shapes |
| `src/api/store.ts` | `useAsync`, `usePoll`, change events |
| `src/api/mock/` | the mock router: `index.ts` (core), `data.ts` (initial state), `scenario.ts`, `ext/<area>.ts` (per-area endpoints) |
| `src/components/` | the component kit (`ui.tsx`), charts, pending changes and confirm (`changes.tsx`), icons, formatting |
| `src/styles/` | `tokens.css` (colours, sizes), `base.css` (shared classes), `charts.css` |
| `src/pages/<area>/` | one directory per sidebar entry; `index.tsx` is the page and owns its sub-routes |

## Conventions

**Pages stage, they never apply.** Pages call `uci.set/add/remove`. The top bar shows the
number of unapplied changes; you review the diff and apply, and then have 60 s to keep the
changes before the router reverts them by itself (rpcd's rollback), so a change that cuts off
the browser undoes itself. After staging, pages show the staged state (`uci.get` returns it)
and mark edited items as "unapplied". Staged deletes can always be undone, so they don't ask
for confirmation; actions that take effect immediately (reboot, restore, factory reset) do.

**Look.** Dense: 13 px body text, 28 px rows and controls, a 4 px spacing grid, tables where
there is a list. Use the classes in `base.css` and the components in `ui.tsx` first.
Page-specific CSS goes in `src/pages/<area>/<area>.css` and uses only the `var(--...)` tokens.
The dark and the light theme are both designed, so check changes in both.

**Charts.** Series colours are `--series-1..8` in a fixed order, assigned per entity (eth0 is
always slot 1), never by rank; one y-axis; a crosshair readout; a legend for two or more
series. Status colours (`--good`, `--warning`, `--serious`, `--critical`) are only for state
and always come with a word, never colour alone.

**Direct manipulation** where it helps: clickable port diagrams, drag to reorder rules, inline
editing and toggles in table rows, a drawer for anything bigger than a row.

**Talking to the router.** Pages read through `api/router.ts`, `api/uci.ts` or
`src/api/<area>.ts`, not `api.call` directly. Every ubus method the UI calls must exist on the
router (rpcd built-ins, netifd, `luci-rpc` or the `er4` plugin), in the mock with the same reply
shape (`registerMock()` in `src/api/mock/ext/<area>.ts`), and in `er4.acl.json`.

**Dependencies** are kept small: preact, uplot and a QR-code encoder (uqr). No CSS framework
and no icon library; icons are paths in `icons.tsx`.

**Done** means `npm run typecheck` and `npm run build` pass, and the mock covers every state
of a new screen (empty, error, loading, many items, unapplied changes).
