# Case study: the pin that drew its marker and moved nothing

This is the story of one bug, written down because two rounds of confident fixes
did not fix it and the reasons why are worth keeping.

**The report:** "置顶还是未生效，依旧是在第二个位置" — *pinning still does not take
effect; the row stays in second place.* The pin marker appeared. The preference was
saved. The row did not move.

It turned out to be three independent defects stacked on top of each other. Any one
of them alone would have produced the same symptom, which is exactly why they were
so hard to see: fixing one changed nothing observable, so the next investigation
started from "my fix was wrong" instead of "there is more than one of these".

---

## Defect 1 — the reorder never ran

```ts
// painter.ts, flush()
if (!shellUsesManualOrder()) return
```

DSH sorts the session list by `updated` (most recent activity) by default, and
`shellUsesManualOrder()` reads the shell's own persisted view store and returns
true only when the operator has switched to manual ordering. On a default install
it returns false, so the hoist was never called.

The consequence is worth stating plainly: **on the default configuration, every
line of ordering code in this plugin was dead.** `orderWithPins` was dead, the
registry writes were dead, the view-store writes were dead. All of it was written,
reviewed, and tested — the unit tests call those functions directly, so they passed
— and none of it ever executed in a real session.

The gate itself was not unreasonable. It was added because the sidebar's
activity-based sort promotes a session whose activity advanced, so re-hoisting a
pinned row could look like a fight with the shell. The mistake was the direction of
the trade: the plugin silently gave up the operator's most visible request in order
to avoid a fight it had not actually tested for.

**Fix:** the gate is gone. The pin is re-asserted on the screen in every ordering
mode. A moved row is itself a DOM mutation, so the loop reconciles instead of
spinning: once the pinned row leads its run, the next pass has nothing left to move.

## Defect 2 — the ordering math was wrong for more than one pin

The reorder was written as a tail-to-head replay: walk the target order backwards
and insert each entry in front of its successor.

```ts
// the old shape, simplified
const anchor = decorated[position + 1]?.element ?? null
parent.insertBefore(entry.element, anchor)
```

With a single pinned row this is correct, which is why it survived every earlier
test — every test pinned exactly one row. With two or more, the "successor" of a
pinned row is itself part of the group being moved, so the loop inserts elements in
front of themselves. The browser reports a mutation. Nothing moves.

Worse, the same code computed the target order and performed the DOM moves in one
pass, so the ordering logic could not be tested without a DOM, and the DOM half
could not be tested without a browser.

**Fix:** split into two functions with a data boundary between them.

```ts
export function sessionRunOrder(entries: readonly RunEntry[]): string[]
export function reorderDomRun(elements: ReadonlyMap<string, HTMLElement>, order: readonly string[]): void
```

`sessionRunOrder` is pure and tested against hand-written runs, including the
two-pin case that used to fail. `reorderDomRun` replays backwards — the last row is
placed first, then the one before it in front of it — so each row lands directly
behind its predecessor every time. The forward direction looks equivalent and is
not, which is now a comment on the function and a second assertion in the test.

## Defect 3 — a row is not a sibling of a row

This is the one that took three separate live experiments to see.

After defects 1 and 2 were fixed, instrumented runs showed the plugin computing the
correct order and then reporting every row as already adjacent — while the screen
stayed still. Dumping the DOM explained it:

```
SPAN._root_1b2ny_3          ← the repeating child of the list container
  └ DIV[role="treeitem"]    ← the row: an only child
SPAN._root_1b2ny_3
  └ DIV[role="treeitem"]
```

DSH wraps every row in a keyed single-child wrapper, and **the wrappers** are the
siblings. Moving the row's `div` moved it inside its own box: the DOM order of the
rows genuinely changed, the rendered order did not, and the next React render put
it back. Every experiment that inspected the DOM agreed the fix worked. Every
screenshot disagreed.

**Fix:** move the outermost single-child ancestor instead of the row. The
`movableRowAncestor` walk is depth-bounded and stops at the first ancestor whose
parent holds more than one child, so it works whether DSH uses one wrapper or
several. The unit double now reproduces the wrapper structure for exactly this
reason — a flat double passes while the screen does not move, which is how this
defect survived its own regression test.

---

## Why the earlier attempts failed

Both earlier rounds were verified against the DOM, and the DOM was telling the
truth about the wrong thing. The lesson that generalises:

> When a UI fix is verified, it has to be verified against the same surface the
> operator is looking at. "The DOM order changed" and "the row appeared second on
> screen" are different claims, and only the second one was reported.

The other lesson is about instrumentation. Finding defect 3 required three
increasingly specific probes:

1. freeze the animation and read the row's box — showed the mark was right;
2. patch `Element.prototype.insertBefore` and log every row move with its stack —
   showed the reorder was moving elements in front of themselves;
3. dump every row's `parentElement`, `children.length`, and sibling — showed each
   row was an only child of its own wrapper.

None of those is a normal debugging step for a CSS-adjacent bug. All three were
worth writing, and the scripts are kept for the next time:

| Script | Question it answers |
| ------ | ------------------- |
| `measure-pin-row.mjs` | Does a pin change the rendered order, and what is the row's horizontal rhythm? |
| `watch-pin-order.mjs` | Samples the rendered order every 250 ms across a pin — shows *when* order changes |
| `dump-row-dom.mjs` | Prints each row's parent and sibling structure — shows the wrapper |
| `verify-pin-final.mjs` | The end-to-end gate: pin, reorder, measure, screenshot, reload, unpin |
| `clear-pin-state.mjs` | Returns the preference file to empty after probe runs |

## The verified result

```
1. order before       deepseek使用 | 进行中 | 查看 | 新会话 | 未分组
2. target row         session-19fb… ("新会话")
3. pin click          true
4. order after        deepseek使用 | 新会话 * | 进行中 | 查看 | 未分组
5. rhythm             gapWhaleToTitle 14.2px, mark right edge x=24, title left x=38
6. screenshots        assets/workspace-menu/pinned-session.png
7. order after reload deepseek使用 | 新会话 * | 进行中 | 查看 | 未分组   ← survives
8. cleanup            unpin through the same menu
9. order restored     deepseek使用 | 进行中 | 查看 | 新会话 | 未分组
10. pinned rows left  0
```

33 unit tests pass, including the two that pin the cases defects 2 and 3 used to
hide behind.
