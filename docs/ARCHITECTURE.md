# Architecture

## Modules

| File | Role |
| --- | --- |
| `src/features.ts` | Shared catalog: every feature key, its default, and its labels. The Host builds its schema defaults from it and the client builds its settings switches from it, so the two halves cannot drift. |
| `src/index.ts` | Host half: the two filesystem routes, the capability route, route leasing, and the settings namespace. |
| `src/client/index.ts` | Client entry: service wiring, effects, deep link, settings row. |
| `src/client/rows.ts` | Row identity (fiber props → official stores) and the registry-order helpers. |
| `src/client/rows-types.ts` | The row/store vocabulary, free of DOM reach. |
| `src/client/actions.ts` | One action list per surface, filtered by feature flags and capabilities. |
| `src/client/menu.tsx` | The React root: menu, confirmations, rename prompt, toast. |
| `src/client/painter.ts` | Incremental `data-*` painting for the pin/unread rails. |
| `src/client/state.ts` | Preferences over the Host namespace, with the local cache. |
| `src/client/i18n.ts` | `zh`/`en` dictionaries and the locale binding. |
| `src/client/api.ts` | Host route calls with an explicit failure contract. |

## Host half

`src/index.ts` registers routes through a shared `WeakMap<WebServer, RouteLease>`
so hot-reload or duplicate loader applications never register the same exact
route twice.

Routes:

```
POST /dsh-workspace-menu/open-in-explorer
POST /dsh-workspace-menu/delete-workspace-directory
GET  /dsh-workspace-menu/capabilities
```

`open-in-explorer` is guarded by the same loopback/trusted-host fence DSH API
routes use. It receives an absolute path, then launches the platform file
manager:

- Windows: `explorer.exe` (a file is selected inside its folder)
- macOS: `open`
- Linux: `xdg-open`, then `gio`, `nautilus`, `dolphin`, `thunar`, `pcmanfm`

`delete-workspace-directory` removes a project directory only after the
registry itself vouches for it. The checks, in order, are: the path is absolute
and NUL-free; it equals a live `workspaceRegistry` entry; `realpath` returns the
same path (so a link cannot redirect the removal); the result is a directory;
it is not inside the user home, `$DSH_HOME`, or the process cwd; it sits on a
volume the registry already occupies and its parent is a real directory.

Session-log deletion is not implemented here. The client asks
`@mlgbnb/dsh-archive-manager` first, and a failure aborts the sequence before
any directory is removed.

`capabilities` reports the Host's platform and Web-server port. The one thing it
deliberately does NOT report is whether the archive manager is loaded: that
question belongs to a service of a composition this plugin must not require,
and touching an undeclared service throws (`cannot get property
"pluginInventory" without inject`). The client settles it on the wire instead,
probing `/api/dsh-archive-manager/delete` on its own origin with a probe-only
session id and a marker header — 404 means absent, a definite client error means
present, anything else means unknown.

`POST|GET /dsh-workspace-menu/preferences` is the plugin's own durable
preference store: it reads and atomically replaces `$DSH_HOME/workspace-menu.json`
(temp file + rename, so a crash mid-write cannot leave a half-document that the
next boot reads as the operator's choices), behind the same fence as the other
routes.

The settings namespace `workspace-menu` is still registered — its registration is
an effect, and an unlisted namespace is simply never reachable from the browser
(DSH serves `settings.*` from a Host-side allowlist; a registered-but-unlisted
namespace answers `settings-not-exposed`). It is kept as the preferred transport
for any deployment that does expose it, and the capability route reports whether
the registration landed so that distinction stays visible.

## Client half

1. `apply()` wires the services through `ctx.effect`: the settings scope, the
   locale dictionaries, capabilities + locale changes, the React root, the row
   painter, the row event listeners, the deep link, and the settings row.
2. Row events reach `resolveRow`, which walks up the row's React fiber for the
   props that identify a workspace group or a session node — DSH ships no
   row-level slot, and this is the only way to answer "which row is this?"
   without replacing the whole browser. Everything else about the row comes
   from `ctx.workspaces` / `ctx.sessions`.
3. `actions.ts` turns the row plus the current flags into a list of actions; the
   React root renders them through DSH's `Menu` and raises DSH's
   `RiskConfirmation` / `Modal` / `Toast` for the rest.
4. The painter writes `data-dsh-pinned` / `data-dsh-unread`; the stylesheet
   draws both rails from those attributes.

## Deep links

"Open in a new window" builds a URL with `?session=<id>`. On load the client
opens the matching session once the session list carries it, polling only while
the document is visible.

## Preferences

The Host namespace is the source of truth; `localStorage` is the cache that
makes the first paint agree with the last session's choice and the fallback when
the namespace is unavailable (a remote browser gets memory mode). Feature flags
are one object field; the three id lists are newline-separated strings, which
keeps the wire shape a plain JSON scalar regardless of list length.
