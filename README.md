# dsh-workspace-menu

Sidebar workspace and session row actions for DeepSeek Harness: **pin, unread,
copy path / link / title, reveal in the file manager, open in a new window, fork,
compact context, archive, and a fenced delete.**

Right-click or double-click any row in DSH's workspace browser and DSH's own menu
primitive opens with those actions. There is no look-alike menu: the card, its
icons, its hover fills, its outside-click and Escape handling, and its viewport
clamping are the same code the built-in row menu uses.

Chinese documentation: [README.zh.md](README.zh.md).

![Pinned session row](https://raw.githubusercontent.com/ZeroCode321/dsh-collection/main/assets/workspace-menu/pinned-session.png)

The pinned row carries the brand whale as its marker — blue, animated, sitting
directly left of its title.

## Features

| Surface | Actions (each individually switchable) |
| ------- | -------------------------------------- |
| Workspace / project row | Pin, copy path, reveal in the file manager, new session, rename, remove from list, delete workspace and directory |
| Session row | Pin, mark read/unread, copy link, copy title, open, reveal working directory, open in a new window, fork, compact context, archive, delete session and its log |
| Group row (top level) | Pin the group, reorder groups, copy project name |

Actions DSH's own row menu already provides are **off by default**, so nothing
appears twice. Every switch lives in **Settings → General → 工作区菜单 / Workspace
menu**, and that row also reports where the preferences are actually kept: the Host
settings namespace, the Host file route, or the browser-local cache.

## Pinning used to be broken — the fix and the reasons are documented

"Pinning draws its marker but the row does not move" turned out to be **three
independent defects stacked on each other**:

1. a sorting-mode gate that stopped the reorder from ever running on DSH's default
   configuration, leaving every line of ordering code dead;
2. ordering math that was only correct while exactly one row was pinned;
3. rows that are not siblings of each other — DSH wraps each row in a keyed
   single-child wrapper, so moving the row's element changed the DOM order and not
   the screen.

The full write-up, including the three live experiments that finally located the
wrapper, is in [docs/CASE-STUDY.md](docs/CASE-STUDY.md).

## Design notes worth knowing

- **Row identity comes from React's own props.** DSH ships no row-level slot, so a
  row is identified by reading the props React put on its fiber. That is the one
  place this plugin depends on DSH internals rather than a published contract. When
  it breaks the menu simply never opens, so the plugin counts consecutive failures
  and says so out loud instead of failing silently.
- **Everything else comes from the official stores.** Paths, titles, session lists,
  and workspaces are read from the `sessions` and `workspaces` client services.
- **The reorder moves wrappers, not rows.** See the case study.
- **Deletion is fenced on the Host.** Removing a workspace directory requires the
  target to still be a live registry entry, to resolve to itself through `realpath`
  (so a symlink cannot redirect the delete), to sit on a volume the registry
  already occupies, and not to be, contain, or sit inside the home directory,
  `$DSH_HOME`, or the process working directory.
- **Permanent session-log deletion is delegated.** It calls
  `@mlgbnb/dsh-archive-manager`, and reports the plugin's absence rather than
  offering an action that cannot work.

## Install

```bash
cd ~/.dsh/profiles/web
npm install link:<path-to-this-project>
```

Then add `@dsh-external/dsh-workspace-menu` to `dsh.profile.bundles` in that
profile's `package.json` and restart the DSH server. The browser module roster is
scanned at boot, so a reload alone is not enough for the *first* install; later
source changes need a rebuild and a page reload only.

## Build and test

```bash
npm run build:client   # tsdown → lib/client.js
npm test               # 33 unit tests (node:test, no browser needed)
```

`build:host` runs `tsc` against a pinned toolchain; on newer TypeScript releases
`baseUrl` in `tsconfig.dev.json` raises TS5101. The Host half is a plain
`lib/index.js` and does not need rebuilding for client-side work.

## Verification

The unit tests cover the decision-making logic: the feature catalog, the pin/unread
list math, the ordering algorithm, the registry-order replay, the action catalog's
filtering, and the failure paths. The DOM and React layers were verified against a
running instance over the Chrome DevTools Protocol — headless Edge, real plugin
roster, real rows. Verified behaviour: a pinned row moves to the head of its group,
the order survives a page reload, unpinning restores the previous order, and the
browser console stays clean.

## Part of

[**DSH Collection**](https://github.com/ZeroCode321/dsh-collection) — project 01,
plugin development. The collection also carries
[`dsh-chest`](https://github.com/ZeroCode321/dsh-chest) (installs, orders, and
shares plugin packages and skills) and
[`dsh-whale-diving`](https://github.com/ZeroCode321/dsh-whale-diving) (the
animation whose whale became this plugin's pinned-row marker).

## Licence

MIT — see [LICENSE](LICENSE). DSH itself is MIT, copyright DeepSeek; this plugin
redistributes none of its source.
