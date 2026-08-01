# Embedded browser audit — 2026-07-31

Read-only audit of every part of the browser tab kind, triggered by one
complaint and one direction:

> the address bar does not work after user interacts with the browser […] we
> need a better engine or something that can in the future be connected to the
> workbench module

Four surfaces: **the Rust module**, **the pane**, **the API bridge**, and
**the tab's persistence** — plus the overlay mechanism the feature imposes on
the rest of the app.

Every finding carries a severity and a confidence. Confidence levels:

- **proven** — demonstrated by a test in this repo that fails without the fix,
  or by `cargo`/`tsc` rejecting the alternative
- **reading** — traced through source (including the `tauri` 2.11.2 API surface
  confirmed against docs.rs via context7) but not executed
- **suspected** — inferred, with the reason it could not be proven stated

Nothing was omitted as too minor. Where a finding was considered and *not*
reported, the reason is stated inline.

**One coverage boundary up front, because it colours the top finding.** No part
of this audit was verified by driving the running app. A child webview is an
OS-level native view; there is no harness in this repo — and none in the plan
until track A1 — that can click into one and then click back out. The
address-bar defect was therefore *diagnosed from source and from the platform
API*, not reproduced. See [BR-F1](#br-f1) for exactly what that means for
confidence in the fix.

---

## Contents

- [What shipped](#what-shipped)
- [The defect](#the-defect)
- [Track 1 — Lifecycle and ownership](#track-1--lifecycle-and-ownership)
- [Track 2 — The address bar and navigation](#track-2--the-address-bar-and-navigation)
- [Track 3 — History](#track-3--history)
- [Track 4 — The unused engine](#track-4--the-unused-engine)
- [Track 5 — Security posture](#track-5--security-posture)
- [Track 6 — The overlay tax](#track-6--the-overlay-tax)
- [Deferred, with reasons](#deferred-with-reasons)
- [Seams for the workbench](#seams-for-the-workbench)
- [The engine question, answered](#the-engine-question-answered)
- [Coverage boundary](#coverage-boundary)

---

## What shipped

Ranked by what each kills. Everything below was bounded by one rule from the
brief: **no new dependency, and the `tauri` pin unchanged.**

| # | Change | Kills |
|---|---|---|
| 1 | `browser_focus_host` + `reclaimFocus` on the address strip | BR-F1, BR-F2 |
| 2 | `disposed` flag through both open paths | BR-L1 |
| 3 | `on_navigation` → `voidlink://browser-navigating` → loading state | BR-N1, BR-N2 |
| 4 | `document.hasFocus()` in the address-bar guard | BR-F2 |
| 5 | `MAX_HISTORY` cap with a cursor correction | BR-H1 |
| 6 | Per-tab zoom, persisted through `TAB_SPECS.browser` | BR-U1 |
| 7 | `browser_toggle_devtools` replacing `browser_open_devtools` | BR-U2 |
| 8 | `browser_set_rect` deleted from Rust, the bridge and the registry | BR-D1 |

Nine findings are reported and **not** fixed. They are in
[Deferred, with reasons](#deferred-with-reasons), each with the reason.

---

## The defect

### BR-F1

**The host webview can never take the keyboard focus back from a page.**
Severity **high**. Confidence **reading** — see the coverage note below.

A browser tab is a Tauri child webview: a sibling *native* view, not part of
this document. The moment the user clicks the page, the OS gives that view the
keyboard focus. Nothing in this repo ever gives it back — `set_focus` appears
in `src-tauri/src/window.rs` twice, for windows, and **nowhere** in
`src-tauri/src/browser/`.

Three things follow, and the third is what makes this unrecoverable rather than
merely annoying:

1. Keystrokes aimed at the address bar are delivered to the page.
2. `HTMLElement.focus()` cannot help. It moves focus *within* a webview that
   already holds it, and this one does not.
3. **No keybinding of ours can rescue it.** A `Mod+L` binding, a palette entry,
   a global shortcut — none of them can fire, because the host webview never
   receives the keystroke that would trigger them. This is why the feature doc's
   "no command palette entry or keybinding" line is not the fix it looks like:
   adding one would not have helped.

Only something outside both webviews can arbitrate, and on this boundary that
is Rust. The fix is `browser_focus_host`, called on `pointerdown` anywhere in
the address strip — the pointer path is the *only* channel left, precisely
because the keyboard one is the thing that is broken.

It focuses by elimination (the one webview in the invoking window whose label
does not start with `voidlink-browser-`) rather than by the `main` label,
because the git window hosts its own webview under a different label and a
hard-coded `main` would focus the wrong window's UI.

**On the confidence.** What is proven: `set_focus` was never called; the command
now exists, compiles against 2.11.2, and `BrowserPane.test.tsx` fails without
the wiring. What is *not* proven is that OS focus was the user-visible cause,
because that needs a click into a real page. The rest of the reasoning is
platform behaviour, not observation. If the symptom survives this fix, the next
suspect is [BR-F2](#br-f2), which was found while reading this one and is an
independent defect that produces the same complaint.

### BR-F2

**The address bar stops updating for the rest of the tab's life, on a guard
that reads stale focus.** Severity **high**. Confidence **reading**.

`BrowserPane.tsx:93` (before this change) read:

```ts
if (document.activeElement !== addressInput) setAddress(e.url);
```

The intent is right — do not yank the address out from under someone mid-type.
The mechanism is not. **A webview keeps its `document.activeElement` while the
OS focus sits in a sibling webview.** So once the user has clicked the address
bar and then clicked into the page, this document still believes the input is
focused, and every subsequent `browser-navigated` event is suppressed. The
address bar then shows the last address the user typed, forever, while the page
navigates freely underneath it — which is exactly the reported symptom, and is
independent of BR-F1.

Fixed by asking whether *this document* has the focus at all before trusting
`activeElement`:

```ts
return document.hasFocus() && document.activeElement === addressInput;
```

---

## Track 1 — Lifecycle and ownership

### BR-L1

**A tab closed while its webview is still opening leaks the webview.**
Severity **high**. Confidence **proven** — `BrowserPane.test.tsx`, "closes a
webview whose open landed after the tab was gone", fails without the fix.

`onMount` fires `browser_open` without awaiting it in the mount body. `onCleanup`
calls `browser_close`, which looks the tab up in the store — and the store entry
is inserted by `browser_open`, at the *end*. Close a tab fast enough (or switch
worktrees, which unmounts the pane) and the ordering is:

1. `browser_open` starts; no store entry yet.
2. Cleanup runs; `browser_close` finds nothing; returns `Ok(())`.
3. `browser_open` finishes; inserts the entry; **the child webview appears.**

What is left is the exact failure the module's own header calls worse than
losing a page: a child webview compositing above the entire UI with no component
owning it, no rectangle being maintained, and no way to dismiss it. It survives
until the next boot, when `browser_close_orphans` sweeps it.

Fixed with a `disposed` flag the in-flight open checks before declaring itself
ready, closing the webview it just created if the tab is gone. The retry path
inside `navigate()` had the same hole and got the same guard.

### BR-L2

**`browser_close` reports success for a tab it did not close.** Severity **low**.
Confidence **reading**. Not fixed — see [Deferred](#deferred-with-reasons).

### BR-L3

**Every tab's pane subscribes to every tab's events.** Severity **info**.
Confidence **reading**. Three listeners per tab, each filtering by id, so N tabs
do N² filter calls per event. At the number of browser tabs anyone opens in a
git workbench this is free, and the alternative — per-tab event names — trades a
measurable nothing for a dynamic listener registry. Reported for completeness;
deliberately not fixed.

### BR-L4

**Switching worktrees destroys the page, and this is load-bearing rather than
incidental.** Severity **info**. Confidence **reading**. Documented in
`browser.md` under Lifecycle and correct as designed: a pane that unmounted
without closing its webview would produce BR-L1's floating view every time. Worth
recording because the obvious "improvement" — keeping browser tabs alive across
worktrees — is the change most likely to reintroduce it.

---

## Track 2 — The address bar and navigation

### BR-N1

**Nothing on screen said a page was loading.** Severity **medium**.
Confidence **proven** — the loading assertions in `BrowserPane.test.tsx` fail
without the event.

`on_page_load` fires only at `PageLoadEvent::Finished`. Between clicking a link
and the page arriving there was no event at all, so: no spinner, no progress,
and an address bar still naming the page being left. On a slow page the app was
indistinguishable from one that had ignored the click.

`WebviewBuilder::on_navigation` fires at the *start* and was unused. It now
emits `voidlink://browser-navigating`, which drives both the spinner (folded
into the reload control, so the strip does not reflow) and an immediate address
update.

The same hook returns a `bool` that can cancel a navigation — see
[BR-S2](#br-s2) for why this one always returns `true`.

### BR-N2

**A navigation that fails in the page is invisible.** Severity **medium**.
Confidence **reading**. Partially addressed; the residue is deferred.

`browser_navigate` returns as soon as `Webview::navigate` is *dispatched*. A DNS
failure, a refused connection or a TLS error happens afterwards, in the page, and
produces no `on_page_load` Finished event and no command error. The pane's error
state only ever catches command-level failures — so a mistyped host left the old
page on screen with a new URL in the bar and no indication of anything wrong.

The navigating event now at least makes the attempt visible, and the spinner
stays up. That is an improvement and not a fix: **a load that never completes
now spins forever.** A real fix needs a load-failure signal the current API does
not expose; see [Deferred](#deferred-with-reasons).

### BR-N3

**`normalizeUrl` turns unparseable input into a command error.** Severity **low**.
Confidence **proven** — `url.test.ts` covers the shape; the failure path is
`url::Url::parse` in `browser_navigate`.

Anything without a scheme gets `https://` prefixed, including input with spaces.
Typing `git rebase onto` produces `https://git rebase onto`, which fails to parse
in Rust and surfaces as a red toast reading like a bug in the app rather than
"that is not an address". The honest fix is a search fallback, which is a product
decision (which engine, and does a git workbench send keystrokes to one). Not
taken; reported.

### BR-N4

**A bare IPv4 host on a port gets `https://`.** Severity **low**. Confidence
**proven** — `normalizeUrl("192.168.1.5:3000")` returns `https://192.168.1.5:3000`.

The `localhost`/`127.0.0.1` special case exists because dev servers do not do
TLS. A dev server on the LAN is the same case and does not match the regex. One
line to fix and deliberately deferred: it wants the private-range rules written
down (`10.`, `172.16–31.`, `192.168.`, `.local`) rather than another hard-coded
pair, and that is a change to a tested pure function that should carry its own
tests.

### BR-N5

**The tab title survives a link click that changes the page.** Severity **low**.
Confidence **reading**. `props.onTitleChange("")` is called in `navigate()`,
which is the address-bar path only. Click a link and the strip shows the *old*
page's title until the new page reports one — and if it never reports one, until
the tab closes. Not fixed: the navigating event now carries the URL that would
drive the clear, but clearing on `navigating` and repopulating on
`on_document_title_changed` inverts the current ordering, and the existing
comment in `navigate()` records that this ordering was chosen deliberately once
already. It should be changed on purpose, with a test, not folded into a focus fix.

---

## Track 3 — History

### BR-H1

**The back stack grew without bound.** Severity **low**. Confidence **proven** —
`the_stack_is_capped_and_drops_the_oldest`.

`entries: Vec<String>`, one owned `String` per navigation, no cap, for the life
of the tab. A page that redirects on a timer (a dashboard, a status board — the
things people leave open in a workbench) grows it forever. Capped at 200 with
the oldest dropped, and the cursor moved by exactly the number dropped: a cursor
left at its old index would silently address a *different* page, which is the
one way this could corrupt rather than merely forget. That correction has its
own test.

### BR-H2

**History is app-tracked, so in-page navigation is invisible to it.** Severity
**medium**. Confidence **reading**. Not fixed — this is a structural consequence,
recorded because it explains a class of complaint rather than a single bug.

A single-page app that navigates via `history.pushState` fires no page load, so:
Back on a SPA route leaves the app's stack pointing at wherever the last *full*
load was, and traversal navigates the webview there — losing SPA state. The
module header explains why it is this way (driving the page's own history means
evaluating script inside an untrusted remote document, which this feature
refuses to do), and that reasoning still holds. The honest position is that the
back button is a **page** stack, not a **route** stack, and the feature doc
should say so.

### BR-H3

**`traversing` is a per-tab boolean, not a token.** Severity **low**.
Confidence **reading**. Two traversals issued before the first page load settles
(a held-down Back, or a keybinding repeat) set the flag twice and clear it once,
so the second load is pushed as a fresh navigation and truncates the forward
entries. Reaching it needs two traversals inside one page load. Reported;
deferred, because the fix is a generation counter and that wants a test harness
for the load callback that does not exist yet.

---

## Track 4 — The unused engine

The brief asked for a better engine. The finding of this track is that the
engine already in the tree was being used at roughly a third of its surface.
Confirmed against docs.rs for `tauri` 2.11.2 via context7, and then against the
compiler.

| API | Was used | Now |
|---|---|---|
| `set_focus` | no | **BR-F1's fix** |
| `on_navigation` | no | **BR-N1's fix** |
| `set_zoom` | no | **BR-U1** |
| `is_devtools_open` / `close_devtools` | no | **BR-U2** |
| `url()` | no | deferred — the events already carry it |
| `print` | no | deferred |
| `cookies()` / `set_cookie` / `delete_cookie` | no | deferred |
| `clear_all_browsing_data` | no | deferred |
| `set_background_color` | no | deferred |
| `reparent` | no | deferred — but see the seams |
| `eval_script` | no | **refused**, see [BR-S1](#br-s1) |

### BR-U1

**No zoom.** Severity **medium**. Confidence **proven** — the zoom tests fail
without it.

The single most-missed browser affordance after find-in-page, and `set_zoom` was
sitting there. Shipped as a fixed ladder rather than a multiplier, because
compounding 1.1× lands on 0.99 and never comes home to exactly 100%. Persisted
per tab through `TAB_SPECS.browser` — per tab rather than global, because a
dashboard that needs 150% and a docs page that does not are the normal pair.

Two details worth recording. `serialize` had a narrow form for the common tab
(`{id, url}` when there is no title) and it had to learn about `zoom`, or a
zoomed tab whose page never reported a title would lose its scale on reload.
And `deserializeBrowser` rejects a non-finite or non-positive `zoom` rather than
passing it on: Rust clamps too, but a bad value that round-trips through
`localStorage` would be *remembered*.

### BR-U2

**The devtools button was dead half the time it was pressed.** Severity **low**.
Confidence **reading**. `open_devtools` on an already-open inspector does
nothing, and there was no close. Now a toggle answering its own state, with the
button reflecting it.

### BR-D1

**`browser_set_rect` had no callers.** Severity **low**. Confidence **proven** —
grep across `frontend/src` and `src-tauri/src`; the only `setRect` hits are a
local signal setter in the pane. `browser_show` sets position and size on its
way to revealing, which is what the pane actually uses, and the hidden path does
not need a rectangle. Removed from the Rust module, the bridge and the
`invoke_handler` registry. The doc comment in `api/webview.ts` that pointed at it
as the mechanism for reflow was wrong and has been corrected to name `show`.

---

## Track 5 — Security posture

### BR-S1

**`eval_script` exists and was not used, and that is the right call.** Severity
**info**. Confidence **reading**. Recorded because it is the obvious way to build
several deferred features (find-in-page, scroll restoration, agent-driven pages)
and it would break the module's stated invariant that no script of VoidLink's
ever enters a browser tab. It stays refused here. When the agent tie-in is built
this is the decision that has to be made explicitly, in writing, with a scope —
not reached for because it was convenient.

### BR-S2

**`on_navigation` is a policy hook being used only as an announcement.**
Severity **info**. Confidence **reading**. The closure returns `bool`; returning
`false` cancels. This audit's implementation always returns `true`. That is
deliberate and worth naming: a URL policy (blocking `file://`, confining a tab
to one origin) is now **one line from possible** and is a product decision, not a
bug fix. Building it inside a focus fix would have been the kind of quiet scope
widening that makes an audit untrustworthy.

### BR-S3

**`file://` navigation is permitted.** Severity **low**. Confidence **reading**.
`normalizeUrl` passes through anything with a scheme, so `file:///Users/...`
loads in a tab. The child webview holds no Tauri capability, so this is not a
path to app commands — it is a local file reader, which in a tool that already
has a file tree is close to harmless. Reported rather than fixed because the fix
is BR-S2's policy hook and that needs the product call.

### BR-S4

**The capability scoping is correct and should be protected by a test it does
not have.** Severity **info**. Confidence **reading**. `capabilities/default.json`
is scoped by webview label (`"webviews": ["main"]`), and its `description` field
explains why at length. That is the single most important line in this feature's
security posture and nothing fails if someone changes it to a window scope.
Reported; a capability-shape assertion is out of scope here.

---

## Track 6 — The overlay tax

### BR-O1

**The cost is real, is growing, and is not what should kill the feature.**
Severity **medium**. Confidence **proven** — count the `setOverlayOpen` effects
in `App.tsx`.

A child webview composites above the entire DOM, so every modal surface has to
actively push it out of the way. `App.tsx` now drives **ten** `setOverlayOpen`
registrations. The 2026-07-29 audit's C1 counted three; three of today's ten
(Mission Control, the timeline, the notifications pane) did not exist when it was
written, and the brain overlay added another. The tax is proportional to how many
surfaces the app grows, which is the strongest form the argument against this
feature has ever taken.

The finding here is narrower than C1's: **the growth is avoidable without cutting
the browser.** Ten call sites exist because each overlay opts in by hand. One
mechanism — a modal surface registering itself on mount, the way tabs register
through `TAB_SPECS` — would make the count one and the growth zero. That is a
refactor of the overlay system, was explicitly out of scope for this slice, and
is now the top-ranked follow-up.

Until it exists, the eleventh overlay will forget, and the symptom will be a page
painting over a dialog with no obvious culprit.

---

## Deferred, with reasons

| Finding | Why it was not fixed here |
|---|---|
| BR-L2 — `browser_close` reports success for a tab it did not close | It is genuinely ambiguous whether "close a tab that is not open" is an error. Changing it means auditing the callers that currently `.catch(() => {})` on purpose. |
| BR-N2 residue — a failed load spins forever | Needs a load-failure signal. `on_page_load` has no failure variant and `on_navigation` fires before the failure. The candidates are a timeout (a lie on a slow page) or `url()` polling (a poll where an event belongs); neither is good enough to ship without measuring. |
| BR-N3 — search fallback for unparseable input | Product decision: which engine, and whether a git workbench should send keystrokes to one at all. |
| BR-N4 — private-range hosts get https | Wants the whole private-range rule written down with its own tests, not a second hard-coded pair. |
| BR-N5 — stale title after a link click | Inverts an ordering the code documents as deliberate. Deserves its own change and its own test. |
| BR-H2 — SPA routes are invisible to Back | Structural. Fixing it means script in the page, which BR-S1 refuses. |
| BR-H3 — `traversing` is a boolean, not a token | Needs a test harness for the page-load callback that does not exist. |
| BR-S3 — `file://` is permitted | Wants BR-S2's policy hook, which wants a product call. |
| BR-O1 — the overlay tax | Explicitly out of scope; it is a refactor of the overlay system, not of the browser. |
| Find-in-page | No API. `wry` exposes no find, and the alternative is `eval_script` — see BR-S1. This is the one QoL item the current engine genuinely cannot do. |
| Downloads, bookmarks, a start page, per-tab profiles, persisted history | Out of scope by the brief, and each is a feature rather than a defect. |

---

## Deferred findings, worked — 2026-07-31, later the same day

A follow-up pass took the deferred rows above. What changed, and what the
changes prove.

| Finding | Outcome | Confidence after |
|---|---|---|
| BR-L2 | **Fixed, and the ambiguity decided against making it an error.** All three callers are in `BrowserPane.tsx`, all three discard the result, and all three run during or after unmount where there is nothing to show a message on — one of them (cleanup's close) *expects* to find nothing, because that is the shape of the BR-L1 race the `disposed` flag exists for. Erroring would report the normal path as a failure and change nothing observable. The real defect was narrower and is fixed: the close was gated on finding a store entry, so a webview whose entry had already gone was left compositing above the UI with nothing owning it. It now closes by derived label, which is idempotent in the direction that matters. The decision is written into the command's doc comment. | reading |
| BR-N2 residue | **Not fixable in this dependency; measured rather than argued, and partially mitigated.** `PageLoadEvent` has two variants and wry 0.55.1 synthesises no third — on macOS `WryNavigationDelegate` implements `didCommitNavigation`/`didFinishNavigation` and *not* `didFailProvisionalNavigation`; on Linux `LoadEvent::Failed` reaches a `_ => ()` arm; on Windows a failed `NavigationCompleted` is mapped to `Finished` without consulting `IsSuccess`, so failures arrive indistinguishable from successes. The third option found was the `PageLoadEvent::Started` the module was discarding: it now emits `voidlink://browser-committed`, which splits "never reached a server" from "slow page" using a real event and no timeout. Declaring failure still needs the timeout or the poll, and still should not ship unmeasured. | proven (the API surface); reading (the user-visible effect) |
| BR-N3 | **Mechanism shipped, policy still open.** `readAddress` classifies input into `url` / `empty` / `not-an-address`, so a typed phrase is refused with "that is not an address" instead of being prefixed with `https://`, sent to Rust and returned as a parser error. It is refused with a toast rather than the error state, because the error state hides the webview and a typo should not cost the page you were reading. No search engine is reached for. | proven |
| BR-N4 | **Fixed as a rule with its own tests.** `isPrivateHost` covers loopback (the whole `127/8`, `::1`, `0.0.0.0`), RFC 1918, IPv4 link-local, IPv6 unique- and link-local, `*.localhost` and `*.local`. Carrier-grade NAT and `.internal` are deliberately left public — both terminate TLS in the networks that use them. Tested at every boundary, including `172.15`/`172.16`/`172.31`/`172.32`. | proven |
| BR-N5 | **Decided against, on evidence the audit did not have.** The comment in `navigate()` argues only against clearing on the *navigated* event, so it did not by itself forbid clearing on *navigating* — but the navigating event turns out not to be main-frame-scoped (see BR-N6), so hanging the title clear off it would blank the tab label on every page with an iframe. The ordering stands. The link-click case remains open and now has a main-frame-only event (`browser-committed`) to attach to, plus an unanswered question: is a blank tab label mid-load better than a stale one? | reading |
| BR-H3 | **Fixed; the harness turned out to be cheap.** The decision was moved off the callback and onto `TabState::settle`, which is pure and needs no `AppHandle` — the callback around it is three lines of plumbing. `traversing: bool` became a URL-matched queue. Five tests: a traversal's own load, a burst of two, a burst wry coalesced into one, a traversal that redirects, and a cancelled traversal. The coalesced case was worse than the audit stated — the flag was left set *forever*, so the next address typed was folded in as if it had been a traversal. | proven |
| BR-S3 | **Blocked on the product call; mechanism deliberately not built.** An allow-everything policy object changes nothing, and its shape depends entirely on the unanswered question. What was added instead is the knowledge the next person needs, at the hook: it sees subframes (so it is stronger than an address-bar filter), and `false` cancels *silently*, so a blocking policy needs its own way to say so or it reads as a freeze. | reading |

### BR-N6 — new

**`voidlink://browser-navigating` fires for subframes, so an iframe could rename
the tab's address.** Severity **medium**. Confidence **proven** for the cause
(read in `wry-0.55.1/src/wkwebview/navigation.rs`), **reading** for the
user-visible effect.

Found while measuring BR-N2. wry's macOS `navigation_policy` never consults
`action.targetFrame().isMainFrame()`, so `on_navigation` — and therefore the
event BR-N1 built on it — fires for every iframe a page loads. The address bar
was driven off that event, so a page with an ad frame would show the ad frame's
URL as the tab's address.

Fixed by driving the address bar off `browser-committed` instead, which comes
from `didCommitNavigation` and is main-frame-only. The navigating event keeps
only the job it can do honestly: turning the spinner on, earlier than any
main-frame event can.

**One residue, reported and not fixed.** A subframe navigating on an
already-settled page sets the spinner going and no main-frame event will arrive
to clear it, so the spinner can stick. It is not made worse by this change — the
same was true before it — and clearing it needs the same load-failure signal
BR-N2 does not have.

---

## Seams for the workbench

The four tie-ins the brief named are not built. Each is recorded here with the
file and symbol it attaches to, so the next slice does not have to re-derive it.

| Tie-in | Seam | What it needs |
|---|---|---|
| **Agents drive the page** | `src-tauri/src/browser/mod.rs` — a new command beside `browser_navigate`, driven from `agent::agent_stream_query`'s tool surface | The hard part is not plumbing, it is BR-S1: reading or clicking a page means script in it. That invariant has to be broken deliberately, with a scope, or replaced by a second driveable surface. Decide that first. |
| **Dev-server aware** | `frontend/src/store/terminalWatch.ts` already watches terminal output; `normalizeUrl`'s localhost rule already knows the shape of a dev-server URL | A port-detection rule over terminal output, and an "open in a browser tab" action. No new Rust. |
| **Event-log citizen** | `on_page_settled` in `browser/mod.rs` is already the one funnel every navigation passes through, and `journal::note` is one call | A `browser.` kind family. The timeline renders `summary` and never switches on `kind`, so it needs no timeline change. The notification matrix is prefix-driven for the same reason. |
| **Preview target for runs and compares** | `Webview::reparent` (unused) plus `store/fanout.ts`'s `RunLeg` | A leg or compare tab carrying a preview URL. `reparent` is what would let one page move between panes rather than being torn down and rebuilt. |

---

## The engine question, answered

The brief asked for "a better engine or something that can in the future be
connected to the workbench module". Having read all of it: **the engine is not
the constraint, and swapping it would have cost the most and bought the least.**

- Of the eleven APIs in [Track 4](#track-4--the-unused-engine), nine were
  available and unused. Both halves of the reported defect were fixed with one of
  them plus a two-word change to a DOM predicate.
- The one QoL item the current engine genuinely cannot do is **find-in-page**.
  That is the entire honest case for a different engine, and it does not carry
  a rewrite.
- The workbench tie-ins do not need a different engine either. Three of the four
  seams above are frontend or journal work. Only the agent one is blocked, and it
  is blocked on a *policy* invariant (BR-S1), not on an API.

What a different engine would buy is automation — a real CDP surface where an
agent drives a page without `eval_script` being the mechanism. That is worth
wanting, and it is a project: a second engine, a second process tree, and a
permission model for what an agent may do inside a page. It should be scoped
against the agent tie-in specifically, not against "the browser feels weak",
because everything that made it feel weak is in this document and none of it
needed a new engine.

---

## Coverage boundary

What this audit did **not** cover, and why:

- **Anything requiring a running window.** No finding here was observed in the
  app. The two focus findings in particular are diagnosed from platform
  behaviour and source, and [BR-F1](#br-f1) says so at the point where it
  matters. This is the same gap track A1 (the Vitest browser project) exists to
  close, and it is a harder case than A1's: a child webview is not reachable
  from a Playwright-driven page either. Verifying focus handoff needs the app
  driven at the OS level, which no plan in this repo currently proposes.
- **Cross-platform behaviour.** Every platform note here (`hide()` being a no-op,
  focus handoff, `print` on macOS only) is from the API docs, on one machine.
  Windows and Linux are unverified.
- **The other nine `setOverlayOpen` call sites.** BR-O1 counts them and argues
  about the mechanism; whether each individual surface registers correctly was
  not checked.
- **Memory and process cost per tab.** Each tab is a webview process. Nobody has
  measured what ten open tabs cost, and that number is the other half of the C1
  argument.
