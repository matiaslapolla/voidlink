# Next tracks — render runner, Buzz/Basecamp/Orca, notifications and sound

Drafted 2026-07-31, on top of the event log, timeline, git attribution and the
two-project test harness that landed the day before. Three tracks, in the order
the user named them; the dependencies between them are called out where they
exist, because two of the three are cheaper if a third goes first.

The load-bearing fact for everything below: **the journal is now the only thing
in this app that knows what happened.** Track B is almost entirely views over
it, and Track C is a policy over it. That is why the event log went first, and
it is why neither track needs a second source of truth.

---

## Track A — a real UI test runner

### Where this stands

`frontend/vitest.config.ts` has two projects: `unit` (node, `*.test.ts`, ~860
tests, ~1.5s) and `render` (jsdom, `*.test.tsx`, 16 tests, all on the timeline).
See [`docs/features/testing.md`](../features/testing.md).

Two separate gaps get conflated under "we need render tests", and they want
different fixes:

1. **Coverage.** ~100 fixes from the 2026-07-30 git-surfaces audit shipped
   having never been mounted in a test. That is a backlog against the harness
   that already exists — ordinary work, no new infrastructure.
2. **Capability.** jsdom has no layout engine. `getBoundingClientRect` returns
   zeroes, there is no scrolling, no real CSS cascade, and `IntersectionObserver`
   / `ResizeObserver` are stubs. Every surface in this app whose correctness *is*
   its geometry is therefore untestable in the `render` project:
   `@tanstack/solid-virtual` lists (commit graph, diff renderer, file tree),
   tab-strip overflow, the splitter, sticky headers, the MRU overlay, xterm and
   Monaco. Mocking the measurement to make the test pass is testing the mock.

### A1 — third project: `browser`

Vitest 4 browser mode, Playwright provider, chromium, headless. Confirmed
against the v4.1.6 docs — the provider is now a package, not a string:

```ts
// npm i -D @vitest/browser-playwright playwright
import { playwright } from "@vitest/browser-playwright";

{
  extends: true,
  plugins: [solid()],
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

The **file suffix picks the project**, exactly as the extension does today:
`*.test.ts` → node, `*.test.tsx` → jsdom, `*.browser.test.tsx` → chromium. Three
suffixes, three costs, and the name of the file tells you which one you are
paying.

**The rule for which to reach for**, written into `testing.md` so it does not
have to be re-litigated per test:

> Use jsdom unless the assertion is about geometry. If the test would pass with
> `getBoundingClientRect` returning zeroes, it belongs in jsdom.

`browser` is not the default and must not become it — it is roughly two orders
of magnitude slower per test, and a suite that takes minutes stops being run.

### A2 — the missing setup surface

`src/test/setup.ts` stubs `matchMedia`, `ResizeObserver` and `scrollIntoView`.
The browser project needs none of those (real browser) but does need the
opposite: **a Tauri stub.** Today the timeline test mocks `@/api/journal`
module-by-module, which is fine for one surface and will not scale to twenty.

Build `src/test/tauri.ts`: a single `mockTauri({ … })` that installs a fake over
`@tauri-apps/api/core`'s `invoke` and `event`, keyed by command name, with an
assertion helper for "what was invoked". Every `@/api/*` module then goes through
it unchanged, and a render test declares *data*, not *module mocks*. This is the
single highest-leverage piece of Track A — it is what makes A3 cheap.

### A3 — burn down the coverage backlog

In priority order, by how much of the audit each covers and how load-bearing it
is:

| Surface | Project | What the test has to prove |
| --- | --- | --- |
| `GitSidebar` | jsdom | A file staged *and* re-modified appears in both sections (the confirmed status bug); refresh does not blank the list; error boundary renders |
| `SplitDiffRenderer` + hunk actions | browser | Hunk controls render and fire; virtualized rows past the viewport exist; line alignment survives a long file |
| Compare tree | jsdom | Tree shape from a flat path list; merge-base mode vs two-ref mode |
| Commit graph | browser | Lane assignment renders where the algorithm says (the unit tests already prove the algorithm; this proves the paint) |
| `TabStrip` | browser | Overflow, drag between groups, the activity LED slot at rest |
| `OperationBanner` / conflict tab | jsdom | Operation detection → banner → continue/abort wiring |
| Activity escalation | jsdom | The three zoom levels of §7.5.3 rule 1, mounted rather than as a pure function |

### A4 — the runner as a thing you look at

- `@vitest/ui` (`npx vitest --ui`) for watch-mode triage. Dev dependency, zero
  config, no effect on CI.
- `npm run test:browser` and `npm run test:ui` in `package.json`; `npm test`
  keeps running unit + render only, so the fast loop stays fast.
- CI: unit + render on every push; browser on demand and pre-merge. Playwright
  browsers are a ~300 MB download that must be cached or it dominates the run.

### A5 — deliberately deferred

**Visual regression** (`toMatchScreenshot`). Vitest 4 supports it and it is
tempting for a design-system-governed app. It needs one OS to be authoritative
for the baselines or every screenshot diffs on font hinting, and this repo has
no CI container yet. Revisit after A1–A3; note it here so it reads as a decision
rather than an oversight.

**E2E through the real Tauri binary** (`tauri-driver`/WebDriver). It would be
the only thing that tests the three-window behaviour end to end, which is where
this app's genuinely hard bugs live. It is also a separate project with its own
flake budget. Not now.

---

## Track B — Buzz / Basecamp / Orca

Current state, restated: Buzz's identity model shipped (agent tabs, the roster)
plus its spine (the event log). Buzz's memory-*consumers*, all of Basecamp, and
all of Orca are absent.

Sequenced by dependency and by cost-to-validate, not by how exciting each is.
Every step lands something usable on its own — none of these are "phase 1 of 3".

### B0 — `workspace` on the event record (do this first, it is small)

The journal's join key is `repo`. Every Basecamp view is *cross*-repo, and
`workspace` is the grouping that makes "everything on project X" answerable.
Add it as an optional field with `#[serde(default)]` — old lines keep parsing,
which is the entire reason the schema has a `data` bag and an open `kind`.

Doing this before B2 costs an afternoon. Doing it after means either a migration
over a 4 MiB × 2-generation log or a view that groups by the wrong key.

**Also here:** a `journal_query` that takes `repo: None` and a registry of known
repos/worktrees to query across. Today the timeline passes one repo and the
disk-read path has never been exercised without a repo filter.

### B1 — Check-ins / standup (Basecamp + Buzz's "what happened while I slept")

The cheapest real consumer of the log and the fastest validation that six weeks
of retention was the right call.

- A time window (since last check-in / since yesterday / last 7 days) over the
  cross-repo query.
- Group by repo, then by actor, then by event family. Most of this is already in
  `timelineModel.ts` — `groupByDay` and `matchesFilters` generalize.
- Render as prose, not a table. The point of a check-in is that it reads.
- **Optional second pass:** hand the grouped events to an agent turn for a
  written summary. Strictly optional and strictly labelled — a generated summary
  presented as a record is the same lie as unmarked inferred attribution, and
  the same rule applies.

Tests: model in `.ts` with unit tests (windowing, grouping, empty windows —
"nothing happened" is a real answer and must not render as a broken pane), one
render test for wiring.

### B2 — Mission Control / The Lineup (Basecamp — the #1 structural gap)

Nothing in this app answers "what is happening across all my workspaces."

- One row per worktree across every workspace: current branch, ahead/behind,
  dirty count, whether an agent turn is in flight, the last event and when.
- Live from the journal broadcast, appending rather than refetching (§7.5.2).
- Needs B0 and it needs a **worktree registry** that survives not having the
  workspace open — today knowledge of a worktree is a function of the layout
  store, which is per-window localStorage. That registry is the real work here;
  the surface on top of it is a list.
- New tab kind `mission` (singleton), same sweep as `timeline` — the sweep is
  now a known 12-file path with a fixture test at the end of it.

### B3 — Annotated diffs (Orca)

Comment on a hunk → the comment becomes context for the agent's next turn.

The blocker is gone: hunk-level actions render now. The work is a comment store
keyed by `(repo, file, hunk)`, a marker in the gutter, and a prompt assembler
that turns N comments into the turn's context. Writes `review.comment.added` to
the journal, which is also the first non-git, non-agent, non-terminal event kind
— a useful test of whether `summary` is really carrying its weight.

Medium size, high daily value, and it is the piece of Orca that does not require
orchestration.

### B4 — Fan-out (Orca's central mechanism)

One prompt → N agents in N worktrees → compare the N diffs → adopt one.

Roughly 70% of the substrate exists: worktree creation with the wizard,
`CompareTab`, `SplitDiffRenderer`, per-agent identities, streaming cancellable
turns. What does not exist is the orchestration:

- A **run** entity: one prompt, N legs, each pinned to a worktree and an agent
  from the roster. Persisted — a fan-out outliving a window close is the point.
- Concurrency and failure semantics: a leg failing must not kill the run; a
  cancel must kill exactly one leg's process group (the kill path already does
  process groups, which is why this is tractable).
- A **comparison surface**: N diffs side by side against the same base. The
  hardest UI in the plan; likely a summary matrix (files touched, lines, tests
  passed) over N `CompareTab`s rather than N diffs literally on screen.
- An **adopt** verb: merge the winner's branch, and say plainly what happens to
  the other N−1 worktrees. Deleting them silently is how someone loses work.
- Writes `run.started` / `run.leg.finished` / `run.adopted`, so the fan-out is
  legible in the timeline and in check-ins.

Biggest item in the plan. Worth splitting: the run entity + N legs + per-leg
progress is shippable and useful before the comparison surface exists.

### B5 — Triggers (Buzz: "when X, run agent Y")

A rule store binding journal kinds to agent turns. Small to build and the
easiest thing here to build *badly*, so the design constraints are the feature:

- **Re-entrancy cutoff.** An agent turn writes events; those events match rules;
  a rule fires a turn. Rules must not match events they caused — tag events with
  the run that produced them and refuse to trigger on own-lineage events, with a
  depth cap on top.
- **Rate limit and a global kill switch**, reachable without the palette.
- **Dry-run mode**: show what *would* have fired over the last N days. The
  journal makes this free and it is the only honest way to write a rule.
- Rules are per-repo and explicit. No implicit "smart" triggers.

Placed after B4 because triggers firing fan-outs is where this gets genuinely
dangerous, and the fan-out semantics should be settled first.

### B6 — Hill charts (Basecamp)

Deliberately last, against the earlier framing of it as the best import — not
because it is wrong, but because it is the only item here that is **not a view
over the log.** A hill needs a *scope* entity (a named piece of work with a
position on the curve), which is new persisted domain state, plus an answer to
"who moves the dot":

- **Manual** — the user drags it. Honest, and the Basecamp original.
- **Agent-proposed** — the agent says it has moved from figuring-out to
  making-it-happen and the dot moves on approval. Interesting, unvalidated.

The event kind is already reserved: `hill.position.moved` is the fixture in
`TimelineSurface.test.tsx` proving unknown kinds render. Fitting that it becomes
real last.

### B7 — Not planned

**Client mode** (the product-person view) is positioning, not mechanism. It
becomes a scoping question once B1 and B2 exist, because it is largely those two
surfaces with writes removed. Revisit then.

### Recommended order

`B0 → B1 → B2 → B3 → B4 → B5 → B6`. Cheap log consumers first to validate the
schema under real use, then the two big mechanisms, then the dangerous one, then
the one that needs new domain state.

---

## Track C — system notifications and a sound library

### The one structural decision

**Rust dispatches. Not the webviews.** Same argument as the journal, and here it
is even more visible: three windows share one origin, so three webviews reacting
to one `journal-appended` broadcast produce three OS notifications for one
commit. Rust holds the log, Rust knows which windows have focus, and Rust is the
only place where "notify once" is expressible.

A notification is therefore **a policy over event kinds**, not a call site. No
feature calls `notify()`; the notifier subscribes to the journal. That is what
keeps the 41st call site from being the one that forgets.

### C1 — plumbing

- `tauri-plugin-notification = "2"` in `Cargo.toml`;
  `@tauri-apps/plugin-notification` only if the frontend ever needs the
  permission prompt (it should not — see below).
- `.plugin(tauri_plugin_notification::init())` in the builder.
- **Capabilities.** Three files: `default.json`, `editor-window.json`,
  `git-window.json`. If dispatch is Rust-only, **none** of them need
  `notification:*`, and that absence is the enforcement of the decision above,
  not an oversight — worth a sentence in each file's `description`, which is
  already how this repo documents capability scope.
- Permission is requested once in `setup`, from Rust:

```rust
use tauri::plugin::PermissionState;
use tauri_plugin_notification::NotificationExt;

if app.notification().permission_state()? == PermissionState::Unknown {
    app.notification().request_permission()?;
}
```

Requesting at launch is wrong for the user and right for nobody — request it
lazily the first time a rule would fire, and if it is denied, degrade to the
in-app activity LED rather than nagging.

### C2 — the policy

`src-tauri/src/notify/mod.rs`, sitting downstream of `journal::note`:

1. **Match** the event kind against the user's rules. Default set, small and
   defensible: `agent.turn.finished`, `agent.turn.failed`,
   `terminal.command.finished` (long-running only), and conflict/operation
   states. Not commits — a notification per commit is how someone turns
   notifications off entirely.
2. **Suppress what the user is already watching.** If any window has focus *and*
   the surface the event belongs to is on screen, do not notify. Rust tracks
   focus via `WindowEvent::Focused`; "which surface is visible" has to come from
   the frontend, and `activity.ts` already computes exactly that set for its own
   escalation. A small `notify_visible(tabIds)` command reuses it rather than
   growing a second notion of visible.
3. **Coalesce.** Five events in two seconds is one notification. Per-kind
   debounce with a summary body.
4. **Quiet hours** and a global mute, both in settings.

All four are pure functions over `(event, state, config)` and get unit tests in
the module — which is the same shape as the journal's `select`, and for the same
reason.

### C3 — the sound library

There is no Tauri audio plugin. Two viable hosts and they are not equivalent:

- **The notification's own sound** (`.sound(...)` on the builder — confirm the
  exact API at implementation). Free, respects macOS Focus modes and Do Not
  Disturb, and is the *correct* channel for anything that also shows a banner.
- **`rodio` in Rust** for sounds with no banner: the turn-finished chime while
  you are looking at the app, the terminal bell, the failure buzz. Rust-side and
  not Web Audio, because a webview-hosted sound picks an arbitrary window as the
  speaker and stops making sense the moment that window closes.

Design of the library itself:

- **Semantic names, not filenames.** `sound::play(Cue::TurnFinished)`. Cues:
  `TurnFinished`, `TurnFailed`, `Attention`, `Conflict`, `RunAdopted`. A call
  site naming a `.wav` is a call site that has an opinion about the theme.
- **A pack** is a map from cue to bundled asset, shipped in `resources`, with at
  minimum a default and a silent pack. Themeable later, structured for it now.
- **CC0 assets only**, and the license recorded in-tree next to them. A bundled
  sound with unclear provenance is a shipping problem, not a nicety.
- **Settings: a matrix.** Per event family × {banner, sound, nothing}, plus
  volume, quiet hours, and mute. One screen, no per-cue sprawl.
- **Respect the OS.** Reduced-motion has a sound analogue: if the system is in
  Do Not Disturb, the banner path handles it for free and the `rodio` path must
  check it explicitly. This is the argument for routing anything user-visible
  through the notification channel wherever possible.

### C4 — order and cost

C1 (half a day) → C2 (the real work; the suppression rule is where the bugs are)
→ C3 (a day plus asset sourcing) → settings UI. Independent of Tracks A and B,
except that **C2's rules read journal kinds**, so any kind added in Track B is
one the notification matrix has to know how to display. Keep the matrix driven
by the kind *prefix* (`agent.`, `git.`, `run.`) rather than an enumeration, for
the same forward-compatibility reason the timeline renders `summary` and never
switches on `kind`.

---

## Cross-track ordering

If all three are live at once, the dependency edges are few:

- **A2 (the Tauri test stub) unblocks cheap render tests for everything in B.**
  Doing it first makes every subsequent surface cost less to test than to leave
  untested, which is the only durable way a coverage rule survives.
- **B0 (`workspace` + cross-repo query) is a one-way door.** It is the only item
  here that gets meaningfully more expensive the longer it waits, because the log
  is accumulating lines right now.
- **C2 reads B's event kinds**, so the notification matrix wants to be
  prefix-driven and Track B wants to keep naming kinds in families.

Everything else is independent. The suggested opening: **B0, then A1+A2, then
B1** — one one-way door closed, the test infrastructure in place before the
surfaces that will use it, and then the first thing that makes the log pay for
itself.

---

## Ledger — what shipped the same day

This plan was drafted and then worked in the order it recommends, with one
change: the user's ordering put the workbench-audit hygiene first, and the
suggested opening (B0 → A1+A2 → B1) had already landed before the plan was
written down.

### Track A

| | State |
|---|---|
| **A1** — the `browser` project | **not started.** Deliberate: it is a *capability* we lack, not a bug. See below for what it would buy. |
| **A2** — the Tauri stub | **shipped.** `src/test/tauri.ts`, installed once from `setup.ts` for the whole render project. A render test now needs no `vi.mock` at all. |
| **A3** — the coverage backlog | **partly.** `ChangedFileTree` (15) and `OperationBanner` (14) are mounted. `GitSidebar` needs both providers and is not done. The three geometry rows of that table need A1. |
| **A4** — the runner as a thing you look at | **not started.** `@vitest/ui` and the script split. |
| **A5** — visual regression, real E2E | deferred, as written. |

**A2 paid for itself immediately, in the way the plan predicted and one it did
not.** Migrating the timeline and Mission Control onto it surfaced a real
ordering fact: `onJournalAppended` attaches across two awaits, so a surface that
has painted its first query is not necessarily listening yet. The old
hand-rolled mocks captured the handler synchronously and could never have shown
it.

The rule from §A1 is now written into `testing.md` and is being followed: use
jsdom unless the assertion is about geometry.

### Track B

B0–B6 all shipped. Two things called out in the plan as the hard parts are now
done rather than pending:

- **B4's comparison surface** — the "hardest UI in the plan". It exists, and it
  is files × legs rather than the summary matrix the plan sketched, because
  counts alone cannot answer whether two legs did the same thing. Building it
  exposed a circularity in the obvious ranking heuristic; see
  [`../features/agent-orchestration.md`](../features/agent-orchestration.md).
- **The adopt verb saying what happens to the other N−1 worktrees** — the plan
  flagged this exactly ("deleting them silently is how someone loses work") and
  the answer landed as: still never delete, but say what is left and that
  nothing will remove it for you.

**Still open in Track B**, and worth stating because the plan does not:

- **Durability across a window close** is unchanged and remains the real limit
  of fan-out. `store/fanout.ts`'s header says why. Moving orchestration into
  Rust is the fix and it is a project, not a flag.
- **B1's optional agent-written summary** was not built. The plan's own
  labelling rule stands if it ever is.
- **B7 (client mode)** still not planned.

### Track C

**C1–C4 all shipped**, including the settings matrix. Three notes where reality
differed from the plan:

- **`.sound(...)` on the notification builder was not confirmed** in the docs
  for this version, so nothing depends on it. The split is instead: a banner
  gets the platform's own sound (which respects Do Not Disturb) and we play a
  `rodio` cue *only* when there is no banner. That is a better rule than the
  plan's anyway — it makes double-sounding impossible.
- **`rodio` 0.22's API is `MixerDeviceSink` + `Player`**, not
  `OutputStream` + `Sink`. Worth recording because the plan's sketch would not
  compile.
- **Assets are generated, not sourced.** `tools/gen-sounds.py` synthesises all
  five cues from sine partials, which sidesteps the CC0 sourcing problem
  entirely: they are original to this repository. Provenance is in
  `resources/sounds/LICENSE.md`, and the plan's insistence on recording it was
  right.

**Quiet hours are UTC.** Converting properly means a timezone dependency for one
integer; the settings screen says so rather than letting the user discover it at
22:00.

### The one cross-track prediction that held

> A2 (the Tauri test stub) unblocks cheap render tests for everything in B.

It did. Every render test written after it — Mission Control, the notifications
matrix, the operation banner — declares data rather than module mocks, and the
last of those was 14 passing tests on the first run.

### What is now the top of the list

1. **A1 + A3's geometry rows.** Every remaining untested surface in this
   codebase is untestable for the same reason: jsdom has no layout engine. This
   is no longer a backlog of tests, it is one missing capability.
2. **A5 from the 100x audit — run provenance on the diff.** Cheaper than when it
   was ranked 13th, because the journal already does the attribution and already
   labels it as inferred.
3. **Fan-out durability in Rust**, if unattended overnight runs are the point.
4. **C1 from the 100x audit** — cutting the browser tab kind, which is a product
   decision that unpins Tauri.
