# TODO — everything open, in one place

The single list of what is live. It replaces the ledgers that used to live in
`docs/specs/`, which were retired on 2026-07-31 once each had been worked down
to its open rows: a ranked list is only useful while you can still tell which
rows are live, and six documents each holding a few was no longer that.

Three sources feed it:

- The **2026-07-29 workbench audit** and the **2026-07-31 next-tracks plan**,
  both now deleted. Their open rows are restated here in full, so nothing here
  depends on a document you cannot read.
- The two audits that **remain**, because a finding is worth more with its
  severity, confidence and evidence attached than as a line in a list:
  [git surfaces](./audits/2026-07-30-git-surfaces.md) and
  [embedded browser](./audits/2026-07-31-embedded-browser.md).

**Ranking rule:** by what each unblocks, not by severity. A medium-severity item
that twenty other items are waiting on outranks a high-severity one that nothing
is waiting on. Where an item was ranked in its source document and the rank has
since moved, the move is stated — a rank that changed silently is the thing this
file exists to prevent.

---

## Contents

- [The top of the list](#the-top-of-the-list)
- [Open — testing](#open--testing)
- [Open — agents and orchestration](#open--agents-and-orchestration)
- [Open — the embedded browser](#open--the-embedded-browser)
- [Open — git surfaces](#open--git-surfaces)
- [Deliberately deferred](#deliberately-deferred)
- [Decided — do not relitigate](#decided--do-not-relitigate)

---

## The top of the list

| # | Item | Why here |
|---|---|---|
| 1 | **BR-O1 — the overlay tax** | Ten hand-written `setOverlayOpen` effects in `App.tsx`, one per modal surface, each there because a child webview composites above the DOM. One self-registration mechanism — the shape `TAB_SPECS` already uses for tabs — makes the count one and the growth zero. |
| 2 | **Run provenance on the diff** | "Which agent wrote this hunk", inline. Was ranked 13th of 14 when proposed and is now near the top: the journal already does the attribution and already labels it as inferred, so what is left is the surface. |

**Done — fan-out durability in Rust.** `src-tauri/src/fanout/mod.rs`: a
supervisor that owns spawning, concurrency, per-leg cancel and terminal
transitions, so a run's lifetime is the app's rather than the webview's.
`fanout_start_run` registers a run and returns without waiting on any leg;
`fanout_run_state` answers "what is running" for a repository;
`fanout_subscribe` attaches to a run's live output from any window, replaying
the full buffered answer as one message before any live chunk — a fan-out is
for being left unattended, so output produced while nobody was listening is
kept, not dropped. Leg spawn/cancel reuses `agent::agent_stream_query` and
`agent::agent_cancel_turn` directly (a leg's turn id is its own id), so the
process-group kill and UTF-8-safe streaming are exercised by `agent::tests`,
not duplicated. Every terminal transition still lands in the journal, from
Rust. `LegStatus` in Rust has no `interrupted` variant — the supervisor either
knows a tracked leg's true state or has no record of the run at all, and
`interrupted` stays a frontend-only reading of that absence (`store/fanout.ts`
`reviveRuns` at load time, corrected by the new `reconcileFanoutRuns` once a
window asks the supervisor what it is still tracking). **Known gap, stated
rather than hidden:** `reconcileFanoutRuns` only reconciles runs the asking
window already has a local record of — a run started entirely from a
different window is invisible to a window that never persisted it, the same
cross-window `localStorage` limitation `journal/mod.rs` describes for the
event log generally. Fixing that would mean moving the run *list*, not just
its liveness, into Rust, and was not done here. 9 new Rust tests, 12 new
frontend tests (`fanout.test.ts` rewritten against the new API boundary).

**Done — a browser test project.** `*.browser.test.tsx`, Vitest 4 +
`@vitest/browser-playwright`, chromium, headless, exactly the config sketched
below. `frontend/vitest.config.ts` now has three projects; `unit` and `render`
are unchanged, `browser` is new and `npm test` still runs only the first two.
`frontend/src/test/setup.browser.ts` reuses `./tauri.ts` as-is (no jsdom
assumptions to work around) and additionally imports the app's `index.css`,
compiled for real by the Tailwind Vite plugin the browser project loads —
geometry tests are only meaningful against the real cascade. Two files prove
the capability: `CommitGraph.browser.test.tsx` (rows and the SVG gutter paint
in agreement, including across the `VIRTUALIZE_ABOVE = 60` windowing
threshold) and `TabStrip.browser.test.tsx` (the overflow chevron against a
real `ResizeObserver`, a cross-group drag against a real `DataTransfer`, which
jsdom does not implement at all). Both were verified to fail for the right
reason when the Tailwind import is removed, so they are not passing on a
coincidence. Detail moved into [testing.md](./features/testing.md#reaching-for-browser-instead-of-render)
rather than kept here twice.

<details>
<summary>The config that was confirmed to work, for reference</summary>

```ts
// npm i -D @vitest/browser-playwright playwright
import { playwright } from "@vitest/browser-playwright";

{
  extends: true,
  plugins: [solid(), tailwindcss()],
  resolve: { alias: { "@": … }, conditions: ["development", "browser"] },
  test: {
    name: { label: "browser", color: "cyan" },
    include: ["src/**/*.browser.test.tsx"],
    setupFiles: ["./src/test/setup.browser.ts"],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: "chromium", viewport: { width: 1440, height: 900 } }],
    },
  },
}
```

`tailwindcss()` was not in the original sketch — it turned out to be load-bearing
once the first geometry test needed `overflow-auto` to actually clip.

</details>

---

## Open — testing

| Item | State |
|---|---|
| **The coverage backlog** | Partly done. `ChangedFileTree` (15 tests), `OperationBanner` (14), and the activity-escalation view axis (`ViewSwitcher.test.tsx`) are mounted. **`GitSidebar` is not** — it needs both providers, and it carries the confirmed status bug: a file staged *and* re-modified must appear in both sections, refresh must not blank the list, the error boundary must render. |
| **The geometry rows of that backlog** | No longer blocked — the `browser` project exists. Done: the commit graph's paint, `TabStrip` overflow and drag-between-groups. Still open: `SplitDiffRenderer` + hunk actions, the splitter, sticky headers, the MRU overlay, the file tree's own virtualized list. |
| **The runner as a thing you look at** | Done. `@vitest/ui` installed, `npm run test:browser` and `npm run test:ui` both wired, `npm test` still runs unit + render only. **Still open:** wiring `browser` into CI on demand / pre-merge with the Playwright binary cached — the ~300 MB chromium download was free in this environment because another tool had already cached it, so the cache step itself is unverified. |

---

## Open — agents and orchestration

| Item | Notes |
|---|---|
| **Run provenance on the diff** | Item 2 above. |
| **Fan-out durability** | Done — see "The top of the list" above. |
| **Palette action sources** | Unchanged since it was proposed: let features contribute action sources to the palette rather than the palette knowing every feature. |
| **Keyboard navigation over N worktrees' changed files** | All that is left of a "review across worktrees" proposal that Mission Control's Lineup otherwise superseded. Re-scope before building — most of what it was for now has a home. |
| **An agent-written check-in summary** | Optional half of check-ins, not built. If it ever is, the labelling rule stands: a generated summary says it is generated. |
| **Client mode** | Still not planned. It is positioning rather than mechanism — largely the Lineup and check-ins with writes removed — and becomes a scoping question rather than a design one. |
| **`failed` from a terminal command** | **Closed 2026-08-01, by shell integration.** VoidLink parses OSC 133 semantic prompts out of the PTY stream (`store/semanticPrompt.ts`), and a `D ; <non-zero>` raises `failed` through the same `noteFinished` path everything else uses. A shell that emits marks owns the completion event outright and the poll stands down, so one command can never produce two contradicting log entries. The snippets are in [`shell-integration/`](../shell-integration/README.md). **What is left is deliberate, not residual:** the app sets a marker env var and does *not* rewrite the user's shell startup — the reasoning is in `create_pty` — so a user has to source one line, and fish/nushell have no snippet yet. Both fall back to poll-inferred `finished`, exactly as before. |

---

## Open — the embedded browser

Nine findings from the [browser audit](./audits/2026-07-31-embedded-browser.md)
were reported and not fixed. Each is there with its severity, its confidence and
its evidence; the reason each was left is restated here.

| Finding | Why it is still open |
|---|---|
| **BR-O1** — the overlay tax | Item 2 above. Out of scope for a browser change because it is not one: it is a refactor of the overlay system. |
| **BR-L2** — `browser_close` reports success for a tab it did not close | Genuinely ambiguous whether "close a tab that is not open" is an error. Changing it means auditing the callers that `.catch(() => {})` on purpose. |
| **BR-N2 residue** — a failed load spins forever | Needs a load-failure signal. `on_page_load` has no failure variant and `on_navigation` fires before the failure. The candidates are a timeout (a lie on a slow page) or `url()` polling (a poll where an event belongs); neither is good enough to ship without measuring. |
| **BR-N3** — no search fallback for unparseable input | Product decision: which engine, and whether a git workbench should send keystrokes to one at all. |
| **BR-N4** — private-range hosts get `https` | Wants the whole private-range rule written down with its own tests, not a second hard-coded pair. |
| **BR-N5** — stale title after a link click | Inverts an ordering the code documents as deliberate. Deserves its own change and its own test. |
| **BR-H2** — SPA routes are invisible to Back | Structural. Fixing it means script in the page, which the security posture refuses. |
| **BR-H3** — `traversing` is a boolean, not a token | Needs a test harness for the page-load callback that does not exist. |
| **BR-S3** — `file://` is permitted | Wants a policy hook, which wants a product call. |
| **Find-in-page** | The one QoL item the current engine genuinely cannot do: `wry` exposes no find, and the alternative is `eval_script`. |

**Not defects, and out of scope by the brief:** downloads, bookmarks, a start
page, per-tab profiles, persisted history.

**One live caveat on what shipped.** The headline fix — `browser_focus_host`,
which gives the host webview the keyboard back — carries confidence *reading*,
not *proven*. What is proven is that `set_focus` was never called and that the
wiring is tested. What is not is that OS focus was the user-visible cause,
because that needs a click into a real page. The `browser` project (top of
this list, now done) can drive one in principle — Playwright and a real
Chromium are there — but nothing has driven this specific click yet; that
would be its own test against `BrowserPane`, not a side effect of building the
project. If the symptom survives, the next suspect is BR-F2.

---

## Open — git surfaces

From the [git-surfaces audit](./audits/2026-07-30-git-surfaces.md), after three
passes. **All of these are MEDIUM or below, and none is a correctness defect
that loses work or misreports the repository** — which is why they sit below
everything above despite outnumbering it.

| Group | Ids | Shape of what is left |
|---|---|---|
| Compare | CMP-F6, F10, F15, F16, F18–F22, F28–F32 | Tree key collisions, size caps, footer counts, ref-picker gaps. |
| Worktrees | WT-W3, W4, W6, W9, D3, D4 | Porcelain `-z` parsing, spawn timeout, wizard classification. |
| Stashes | WT-S2–S6 | Stash-by-index identity is the one worth doing first: a compare tab stores the literal `stash@{1}` and re-resolves it every refresh, so an open stash diff silently retargets when the stack shifts and never self-corrects. |
| Branches | BR-A4, A5, A7, A8, A11, B3, C3–C6, D3, E2, F5, F6, F7, G8 | Grouping, remote-only rows, the git window's missing sync controls, `<For>` keying. |
| Diff | DIFF-A7, A8, plus the Track 1 "Lower" list | |
| Sidebar | The Track 2 "Lower" list | |
| Graph | GRAPH-O4 | |

Two known gaps that are not numbered findings:

- **`` `${sha}^` `` as a base ref** at `EditorApp.tsx:480` and
  `MainSurface.tsx:1003`. Both take a bare SHA from text with no parent list to
  hand, so a **root commit** clicked from those two paths errors. It errors
  visibly rather than bricking the tab. Fixing it properly means a new Rust
  single-commit lookup command, which is more than two call sites justify.
- **Working-tree diffs have no `find_similar` or `include_typechange`**
  (`diff.rs`); only the compare path got them. Renames and typechanges are
  therefore reported differently depending on which surface you are looking at.

---

## Deliberately deferred

Here so each reads as a decision rather than an oversight.

- **Visual regression** (`toMatchScreenshot`). Supported, and tempting for a
  design-system-governed app. It needs one OS to be authoritative for the
  baselines or every screenshot diffs on font hinting, and this repo has no CI
  container. Revisit once the browser project exists.
- **E2E through the real Tauri binary** (`tauri-driver`/WebDriver). The only
  thing that would test the three-window behaviour end to end, which is where
  this app's genuinely hard bugs live. Also a separate project with its own
  flake budget.
- **Quiet hours are UTC.** Converting properly means a timezone dependency for
  one integer. The settings screen says so rather than letting someone discover
  it at 22:00.

---

## Decided — do not relitigate

The documents that argued these are gone. The conclusions are not, and each cost
more to reach than it looks.

- **The embedded browser is kept.** Cutting it was ranked the highest-value
  *removal* in the app, and the product call went the other way: it is being
  invested in as an agent-drivable surface, a dev-server view and a preview
  target. The cost is real and accepted — `tauri` stays pinned `=2.11.2` with
  `unstable` **and** `devtools`, held by the single `add_child` call in
  `src-tauri/src/browser/mod.rs`. What would reopen it: a Tauri break that costs
  more than a day, or the agent tie-in concluding it needs a second engine.
  Note that the overlay tax (item 1) was an argument against the *overlay
  mechanism* and read as an argument against the browser.
- **The graph's "first parent keeps the mainline vertical" invariant is wrong,
  not the code.** Making it true would mean moving a claimed lane sideways
  mid-flight, and the earlier child's segments are already emitted in the old
  column — so the line would arrive at one column and leave from another. A
  broken edge is strictly worse than a kink. The comment says so.
- **"Load more" refetching the whole window is not worth a `skip` parameter.**
  libgit2 walks from the tips regardless, so the walk — the dominant cost — is
  paid either way. The user-visible harm was scroll reset, which is fixed.
- **Notification sound is split by channel, not by a `.sound(...)` flag.** A
  banner gets the platform's own sound, which respects Do Not Disturb; a `rodio`
  cue plays *only* where there is no banner. Double-sounding is impossible by
  construction rather than by care.
- **The project brain is per-repo and app-owned**, under `.voidlink/brain`. It
  shares the six type names with the `brain` CLI and no code, no config and no
  vault. There is deliberately nothing to point at a personal vault.
