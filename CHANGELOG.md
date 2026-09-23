# Changelog

## Unreleased

- **Pinning now moves the row. It never did.** Three defects stacked up, and each
  one alone was enough to make 置顶 look broken while the marker still appeared:
  1. The painter refused to reorder unless the sidebar was in its manual sorting
     mode. The default is "Last updated", so `shellUsesManualOrder()` was false and
     the hoist never ran — on a default install, both `orderWithPins` and the store
     writes were dead code. The gate is gone: the pin is re-asserted on the screen
     in every ordering mode.
  2. The ordering math was wrong for more than one pin. It was a tail-to-head
     replay against each entry's successor, which works only while a single row is
     pinned; with two, the "successor" was itself part of the group being moved, so
     every move inserted an element in front of itself. Ordering and DOM replay are
     now separate, testable functions (`sessionRunOrder`, `reorderDomRun`).
  3. A row is not a sibling of a row. DSH wraps each row in a keyed single-child
     wrapper (`SPAN._root_…`), and those wrappers — not the rows — are the
     repeating children of the list. Moving the row's `div` moved it INSIDE its
     own box: the DOM order changed, the screen did not, and the next render put
     it back. `reorderDomRun` now walks up to the outermost single-child ancestor
     and moves that. The unit double reproduces the wrapper for that reason — a
     flat double passes while the screen stays still.
  - Verified in a live GUI: pinning the third session row puts it directly under
    its workspace header (`新会话 *` first), the order SURVIVES a page reload, and
    unpinning restores the previous order. 33 unit tests pass.
  - The "pinning cannot hold in this mode" warning is gone with the gate that
    caused it, along with its two dictionary entries.

- **The pinned row's mark is an animated blue whale.** The marker strip renders
  `WhaleMark` (`src/client/WhaleMark.tsx`): the DeepSeek brand glyph (`FishLogo`,
  23.16:17.04) in `--dsw-alias-state-business-primary`, breaching, spouting, and
  diving on the same 3.6s cycle the whale-diving plugin uses beside a running
  turn. Verified in a live GUI: `rgb(65, 118, 230)`, `dsh-pin-whale-pose`,
  `dsh-pin-whale-path`.
  - **The artboard's static `surface` stroke is dropped.** At 22px, in the
    turn-status row, it reads as the sea the whale dives into; at 16px inside an
    18px marker strip it reads as a line drawn through the animal — and two
    anchor settings that looked correct both landed on the belly. There is no y
    that sits under the whale and still fits the row, because the glyph's
    lower-left is mass, not empty box. The ripple (drawn low, mostly behind the
    belly) carries the water instead; `WATER_LINE_IN_MARK` records the number.
  - **Opacity floor 0.85, not 0.45.** At 0.45 the mark read as a grey smudge
    rather than a blue whale. Travel is 3px rather than the original's 8px, which
    is what a 14px-tall marker strip can carry.
  - **The whale sits next to its title.** The visible gap was never the strip's
    own: the shell puts an empty 16px slot between the marker strip and the title,
    plus 4px of the title's own left margin (whale ended at x=24, title began at
    x=45). A negative right margin on the strip cancels most of it — measured gap
    14.2px against 21.2px before — while keeping the unread grid its room.
  - Glyph 16px, mark 18px tall: measured with `_chest-build/measure-pin-whale.mjs`
    (all 25 samples hold opacity in [0.85, 1]; widest rotated pose 19.4px) and
    `_chest-build/fit-pin-whale.mjs` (the water anchors).

## 1.3.0

Reworks both halves around DSH's own extension surfaces instead of look-alikes.

- **Menu and dialogs now use DSH primitives**: `Menu` for the row menu,
  `RiskConfirmation` for destructive confirmations, `Modal` for the rename
  prompt, `Toast` for feedback, and the shared icon set. The plugin no longer
  builds its own menu DOM, so it matches the shipped row menu exactly and picks
  up design-token changes for free.
- **Preferences are durable per profile**: the plugin owns a fenced Host route
  (`GET`/`POST /dsh-workspace-menu/preferences`) that reads and atomically
  replaces `$DSH_HOME/workspace-menu.json`, so one profile carries one
  preference set across browsers. `localStorage` remains the pre-load cache and
  the last-resort fallback, and the settings row says which mode is active.

  The original plan was to keep them in the DSH settings namespace. That
  registration succeeds and is kept, but it is not reachable from a browser: DSH
  serves `settings.*` from a HOST-SIDE ALLOWLIST, and a namespace that is
  registered but unlisted answers `settings-not-exposed`. Per DSH's own
  documentation a plugin distributed outside the DSH tree cannot surface its own
  configuration there "without a change in packages/host/apiproxy". The
  registration therefore stays as the preferred transport for a deployment that
  does expose it, the file route is the transport that works, and the capability
  route reports the registration outcome so the distinction is never guessed at.
- **Pinning was verified end to end.** The reorder path (`workspace.insertBefore`
  via `applyWorkspaceOrder`) was exercised against a live Host with two
  workspaces: pinning the second moved it to the top, unpinning restored the
  previous order. The earlier "pinning does nothing" report was a one-workspace
  profile, where there is nothing to reorder — but the mechanism had never been
  confirmed against a real second workspace until now.
- **A pinned row is reconciled onto the screen, not just into the stores.** The
  pin writes the registry account and the browser's own view order, but the shell
  also rewrites that view order from its baseline whenever it reconciles, so a
  write can be replaced by an order assembled before it landed — which is exactly
  the state where the registry says one thing and the screen another. The row
  painter therefore hoists the pinned rows to the head of their group after any
  paint that touched rows or saw the pin list change, gated on the sidebar being
  in Manual mode (in Last updated the shell promotes active sessions, and
  hoisting there would fight its reconciliation on every repaint).
- **Pinning now actually reorders the sidebar.** The registry write was never
  enough: the workspace browser renders from its OWN persisted view order
  (`sessionOrderByAccount` inside `dsh.workspace.view.v5`), and
  `reconciledSessionOrder` PREFERS that stored order over the registry account
  whenever the key exists — the registry is then consulted only to append
  sessions the view has not seen. A pin therefore wrote the registry, changed
  nothing on screen, and looked broken in both ordering modes. The action now
  writes the shell's view order as well (dropping the key when the operator
  returns to the registry's own order, so the shell falls back by its own rule),
  and reconciles the rendered rows to match, so the visible result does not
  depend on which of the two the shell reconciles first.

  Verified against the live GUI by driving the sidebar's own controls: switching
  the order menu to Manual and pinning a session moved it to the first row, with
  its mark, while the ordering mode itself is unchanged by the plugin.
- **Pinning an ungrouped session now moves it.** The reorder was skipped whenever
  the session had no `workspaceId`, which is exactly the case in the ungrouped
  bucket: a pin there drew a marker and moved nothing. It now reorders the
  rendered tree inside its own group, the same way top-level rows are ordered.
- **A pin in the shell's default ordering mode says so.** The sidebar sorts by
  `updated` by default and, in that mode, promotes any session whose activity is
  newer — DSH's own session drag is disabled there too
  (`WorkspaceBrowser.tsx`: `if (orderBy === 'updated' || ...) return`). A pinned
  order is therefore recomputed away on every list refresh, which is
  indistinguishable from "pinning does nothing". The plugin cannot change that
  policy, so it detects the mode and tells the operator to switch the sidebar to
  manual ordering; the marker itself is still stored and survives a reload.
- **The pin mark is the brand whale, animated, at 16px.** The shell's fish logo
  is the DeepSeek product mark and the whale-diving glyph is a stroke animation,
  so neither could be reused as a marker; the whale here is drawn for the size it
  is used at, with the breach, spout, splash, and surface ripple transcribed from
  the turn-status animation. Its size is bounded by its own rotation, measured
  with `_chest-build/fit-pin-whale.mjs`: at 16px the swing reaches 18.83px, which
  is what the marker strip's 11px margin exists to absorb.
- **Pin and unread are now visible.** They were already persisted and did
  reorder the rows, but their only rendering was a 2px inset on the row's left
  edge, which in practice is indistinguishable from nothing happening. Each fact
  now gets a real marker in the row: a pushpin for pinned, a dot for unread.
- **`/compact` is on the row menu.** DSH already ships context compaction
  (`@deepseek-ai/dsh-command-compact`); this plugin only surfaces it where the
  operator is looking, submitted against the session id so the session does not
  have to be opened first, and a Host refusal is reported rather than swallowed.
- **"Open in a new window" now says what it does** and copies the session link
  in the same action: a second window onto the session you are already reading
  is only useful when the URL itself is the point.
- **Pin/unpin is reversible**: the pin list holds the order, so unpinning drops
  the id and the registry's own order shows through again. Previously the item
  stayed where the pin had pushed it.
- **Pin and unread rails no longer overwrite each other**: both are drawn from
  `data-*` attributes by two independent insets instead of two `box-shadow`
  declarations competing on the same selector.
- **Workspace directory deletion is fenced on the Host**: the target must still
  be a live registry entry, must resolve to itself through `realpath` (so a
  symlink or junction cannot redirect the `rm -rf`), must sit on a volume the
  registry already occupies, and must not be, contain, or sit inside the user
  home, `$DSH_HOME`, or the process cwd. Refused targets report a machine code
  instead of a generic 400.
- **Session-log deletion no longer fails silently**: a failed archive-manager
  call stops the workspace-directory removal and is reported, instead of being
  swallowed and followed by a success toast. When the archive manager is known
  to be absent, the completion dialog states outright that the workspace's
  session logs cannot be purged and will survive as orphans — a machine without
  that plugin can still delete a workspace directory, and knows the cost before
  acknowledging rather than watching the action fail.
- **Row painting is incremental**: a DOM mutation marks only the rows it
  plausibly touched (plus bounded probing inside added subtrees) and one frame
  coalesces the batch, replacing the full `[role="treeitem"]` sweep that ran on
  every mutation.
- **Bilingual dictionaries**: menu, dialog, toast, and settings copy now go
  through the locale service (`zh` as the fallback, `en` checked against the
  same key union at compile time).
- **Capability reporting**: the Host reports its platform and Web-server port,
  and the client settles the archive-manager question on the wire by probing
  `/api/dsh-archive-manager/delete` on the origin it is already talking to
  (with a probe-only session id and a marker header, reading 404 as "absent").
  Deleting a session is hidden rather than offered when it cannot work, and the
  settings row explains why. The first implementation read the Loader's plugin
  inventory service instead, which threw `cannot get property "pluginInventory"
  without inject` on every call in a composition that does not declare it.
- **Deep links stop polling in a background tab**, and the settings-scope
  binding, locale registration, and React root all ride `ctx.effect`, so an
  unload releases every listener.
- The feature catalog is one shared module consumed by both halves: the Host
  schema defaults and the client switches cannot drift apart.
- The four actions DSH's own row menu already ships (rename, archive, fork, new
  session) — plus workspace rename — now default to off, so a default profile
  shows no duplicate entries.
- The host build now actually emits `lib/index.js` from `src/index.ts`
  (`tsconfig.build.json`), and `scripts/check.mjs` verifies the built client
  bundle's `require()` specifiers against the shell's module table.
- **Unit tests** (`npm test`, 17 cases) cover the catalog's uniqueness and
  defaults, id-list decoding against a hand-edited document, the pin/unpin
  order math, action filtering by flag and capability, and the delete/reveal
  failure paths. Writing them surfaced two real defects: a duplicated pin id
  was emitted twice into the replayed order, and every pin toggle now goes
  through `pinFront`/`pinOut` so an unpinned id cannot survive in a malformed
  pin list.

## 1.2.0

- Add host route lease (`WeakMap` reference counting) so duplicate loader
  applications no longer crash with `duplicate exact route`.
- Add "delete workspace (including disk)" action: session records are removed
  through `@mlgbnb/dsh-archive-manager`, then the project directory is removed
  via a narrow protected host route.
- Add "delete session (including disk)" action that delegates to
  `@mlgbnb/dsh-archive-manager`; the plugin does not write archive/projcache
  files itself.
- Add proper host build (`tsconfig.host.json` + `tsc`) so `src/index.ts` is
  compiled instead of hand-maintaining `lib/index.js`.

## 1.1.3

- DSH rc8 compatibility: simplify the bundle patch so the plugin no longer gets disabled by the runtime-injected entry guard.

## 1.1.2

- Add `dsh.bundle.patch` manifest so the plugin installs with the official `dsh plugin add` flow.

## 1.1.1

- Update README with feature highlights and General settings integration notes.

## 1.1.0

- Make the General settings item collapsible.
- Align the settings item with the DSH Language / Appearance row styles.

## 1.0.0

- Integrate settings into the DSH General settings page.
- Align settings UI with DSH design tokens.
- Cross-platform file manager opening.

## 0.1.x

- Initial workspace/chat context menu.
- Host route for opening directories in the system file manager.
- Fix context menu being closed by chat auto-scroll.
