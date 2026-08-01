# TODO — everything open, in one place

The single list of what is live. It replaces the ledgers that used to live in
`docs/specs/`, which were retired on 2026-07-31 once each had been worked down
to its open rows.

On **2026-08-01** the list was worked in eleven parallel tracks and then rewritten
against what actually shipped. Almost everything that was *implementable* is
done; what remains is, with few exceptions, work that needs a decision from a
person rather than an afternoon from an engineer. That is the point of the
shape below: **the first section is questions, not tasks.**

The two audits still hold the evidence, and a finding is worth more with its
severity, confidence and reasoning attached than as a line in a list:
[git surfaces](./audits/2026-07-30-git-surfaces.md) and
[embedded browser](./audits/2026-07-31-embedded-browser.md).

**Ranking rule:** by what each unblocks, not by severity.

---

## Contents

- [Blocked on a decision](#blocked-on-a-decision)
- [Blocked on the dependency](#blocked-on-the-dependency)
- [Open — small and unblocked](#open--small-and-unblocked)
- [Open — needs re-scoping first](#open--needs-re-scoping-first)
- [Deliberately deferred](#deliberately-deferred)
- [Shipped 2026-08-01](#shipped-2026-08-01)
- [Decided — do not relitigate](#decided--do-not-relitigate)

---

## Blocked on a decision

Each of these is built up to the point where the next line of code encodes a
policy. The mechanism is in place where the mechanism could be separated; what
is missing is an answer, and guessing at one is how a product acquires
behaviour nobody chose.

| # | The question | What is already built, and what turns on the answer |
|---|---|---|
| 1 | **Should the address bar reach a search engine at all — and if so, which, chosen by whom?** | Unparseable input is classified and refused with a toast; nothing is sent to Rust. The classification is right under either answer, which is why it shipped. A git workbench sending keystrokes to a search engine is a product posture, not a default. (BR-N3) |
| 2 | **What may a browser tab navigate to: any scheme, http/https only, or http/https plus an explicit opt-in for `file://`?** | Deliberately *not* built. A global scheme allowlist, per-tab origin confinement, and a prompt are three different objects, and the wrong one is harder to remove than to write. Two facts for whoever answers, recorded at the hook site: the policy point sees subframes, so it is stronger than an address-bar filter; and returning `false` cancels *silently*, so a blocking policy needs its own way to say so or it reads as the app having frozen. (BR-S3) |
| 3 | **Should an ordinary agent turn write an `agent.turn.*` record?** | The docs have described one for a while; nothing has ever emitted it, so the notification defaults, the check-in model and the trigger rules all read a kind that is never written. Recording the interval would also make a finished agent-panel turn attributable on the diff. It would immediately start firing the default `agent.turn.finished` banner, which is a change to what the app *does*, not to what it records. |
| 4 | **Where does a destructive push live, and how is it confirmed?** | libgit2 has no lease primitive, so `--force-with-lease` means fetch → compare `refs/remotes/<r>/<b>` → force, with a real race window. The audit rates the current state "safe by construction" precisely because the button does not exist. (BR-F7) |
| 5 | **What does a remote branch's ahead/behind count against?** | Checked rather than assumed: listing remote branches changes nothing, because `git_list_branches_impl` hands every remote-tracking branch `(None, 0, 0, false)` and both chips gate on `> 0`. The flip was made, verified inert, and reverted. (CMP-F22) |
| 6 | **Do compare tabs get their own diff-mode and whitespace controls?** | Per-tab state exists for width, mode and filter; `diffMode` and `ignoreWhitespace` are the two that have no control anywhere in the compare surface — they live in the working-tree diff toolbar. Per-tab state with no per-tab control is state the user cannot reach. |

---

## Blocked on the dependency

Not decisions, not effort — the engine does not expose what these need. Each
was measured rather than assumed, and the measurement is the durable part.

- **Declaring a load failed** (BR-N2). There is no load-failure signal at any
  layer of the pin: macOS never implements `didFailProvisionalNavigation`,
  Linux drops `LoadEvent::Failed` on a wildcard arm, and Windows maps a *failed*
  `NavigationCompleted` to `Finished` without consulting `IsSuccess` — so on
  Windows a failure arrives indistinguishable from a success and is pushed into
  history. What shipped instead is the event that was being discarded:
  `PageLoadEvent::Started` splits the spinner into *Connecting* and *Loading*.
  Actually declaring failure still needs a timeout (a lie on a slow page) or
  `url()` polling (a poll where an event belongs), and still should not ship
  unmeasured.
- **A subframe navigation on a settled page can strand the spinner** (BR-N6
  residue). Clearing it needs the same signal BR-N2 does not have.
- **SPA routes are invisible to Back** (BR-H2). Structural: fixing it means
  script in the page, which the security posture refuses.
- **Find-in-page.** `wry` exposes no find, and the alternative is
  `eval_script`. The one QoL item the current engine genuinely cannot do.
- **A real splitter *drag* in a test.** The browser project's `userEvent`
  exposes `hover`/`click`/`dragAndDrop` and no raw mouse, and `dragAndDrop`
  gives no intermediate positions — so "clamping does not hard-stop the
  pointer" cannot be driven. The keyboard clamp is covered in jsdom; the
  pointer one needs a custom Playwright command.

---

## Open — small and unblocked

Ordinary work. Nothing here is waiting on anything.

| Item | Notes |
|---|---|
| **The MRU overlay has no test** | The one row left in the coverage backlog. It lives inside `MainSurface` rather than as an extractable component, so covering it means mounting the whole workbench surface — a different-sized job from the five that landed, and a shallow test if rushed. |
| **`browser` is not wired into CI** | On demand and pre-merge, with the Playwright binary cached. The ~300 MB chromium download was free locally because another tool had already cached it, so **the cache step itself is unverified** — treat the number as Playwright's published size, not as measured here. |
| **Shell integration has no fish or nushell snippet** | Neither has a hook shape shared with zsh or bash. The parser is shell-agnostic, so a port is small. Both currently fall back to poll-inferred `finished`, exactly as before. |
| **OSC 9/777 are not replay-gated** | Re-attaching a pane re-badges historical notifications. Exactly the family of bug the `replaying` gate added for OSC 133 prevents; only 133 was gated, to keep that diff to its stated task. |
| **`ownedCleanup` in `TerminalPane` overwrites rather than accumulates** | `teardown = fn`, so only the last registration survives. The earlier ones are covered incidentally by `term.dispose()`, and `clearTimeout(replayGuard)` never runs. Pre-existing and latent. |
| **The splitter's gap comment reads backwards from CSS's sign convention** | It says the strip is "pushed outward" by `gap/2 - 4px`; in CSS `right: -1px` puts the strip's centre *inside* the pane's right edge. The code is self-consistent and the test asserts the exact span, but the prose is ambiguous. Needs someone who knows whether the island box includes its gap. |
| **A `BrowserPane` click test** | The browser project can drive a real click now, which is what BR-F1's confidence caveat was waiting on. Nothing has driven this specific one yet — see the caveat below. |
| **Diff virtualization** | `SplitDiffRenderer` is not windowed. Same size of change as the commit-graph windowing, which took a pass of its own. |
| **`VirtualFileList`'s virtualized branch** | Below 40 files — the common case — rows are stable. Above it, `<For each={virtualizer.getVirtualItems()}>` still yields fresh objects each pass; that is tanstack's own churn. |

---

## Open — needs re-scoping first

Written against a product that has since changed. Do not build these as
specified; work out what is left of them first.

- **Keyboard navigation over N worktrees' changed files.** All that survives of
  a "review across worktrees" proposal that Mission Control's Lineup otherwise
  superseded.
- **An agent-written check-in summary.** If it is ever built, the labelling rule
  stands: a generated summary says it is generated.
- **Client mode.** Positioning rather than mechanism — largely the Lineup and
  check-ins with writes removed.
- **Moving the fan-out run *list* into Rust.** Liveness moved; the list did not,
  so a window only reconciles runs it already has a local record of and a run
  started from another window is invisible to one that never persisted it. The
  same cross-window `localStorage` limitation `journal/mod.rs` describes
  generally — worth solving once, for both.

---

## Deliberately deferred

Here so each reads as a decision rather than an oversight.

- **Visual regression** (`toMatchScreenshot`). It needs one OS to be
  authoritative for the baselines or every screenshot diffs on font hinting,
  and this repo has no CI container.
- **E2E through the real Tauri binary** (`tauri-driver`/WebDriver). The only
  thing that would test the three-window behaviour end to end, which is where
  this app's genuinely hard bugs live. A separate project with its own flake
  budget.

---

## Shipped 2026-08-01

Eleven tracks, worked in parallel worktrees and merged in dependency order.
Recorded compactly; the detail is in the feature docs and the audits.

| Track | What landed |
|---|---|
| **BR-O1, the overlay tax** | Overlays self-register (`createOverlay`); `App.tsx` lost 7 of its 8 hand-written effects. Two surfaces turned out never to have been registered at all — the cheat sheet and the snapshot manager — live instances of the silent failure the finding describes. |
| **A browser test project** | `*.browser.test.tsx` in headless chromium, with the real cascade. `npm test` still runs unit + render only. |
| **The coverage backlog** | `GitSidebar` mounted for the first time (31 tests) plus five geometry files. Every browser test was falsified by breaking what it claims; **two were wrong and were rewritten**. |
| **Compare** | Eleven findings. Two of the audit's own readings corrected rather than implemented. |
| **Worktrees and stashes** | Track 5 closed entirely. A conflicting `stash_apply` returns `Ok` from libgit2 — the old code said "Applied stash" over a tree full of conflict markers. |
| **Branches, diff, graph** | The audit's long tail, plus both of its unnumbered "known gaps". `git_discard_all` honoured no pathspec on its untracked half: "delete N untracked files" would have deleted all of them. |
| **The browser's deferred findings** | Six closed, two left to decisions above, and **BR-N6 found**: wry's macOS navigation policy never checks `isMainFrame`, so the address bar was being driven by every iframe a page loaded. |
| **OSC 133 shell integration** | `failed` is reachable from a terminal command for the first time, so `terminal.command.failed` — already in the notifier's defaults — fires instead of never. |
| **Fan-out durability** | A Rust supervisor owns the legs; a run's lifetime is the app's, not the webview's. Unattended output is buffered and replayed rather than dropped. |
| **Run provenance** | File-level on the working tree, commit-level on a commit, nothing on a branch range — the granularity the evidence actually supports. |
| **Palette action sources** | Features contribute their own actions; 462 lines left `App.tsx`. Behaviour preservation proven id-for-id against the pre-refactor list. |

**One live caveat carried forward.** BR-F1's fix — `browser_focus_host`, which
gives the host webview the keyboard back — is still confidence *reading*, not
*proven*. What is proven is that `set_focus` was never called and that the
wiring is tested; what is not is that OS focus was the user-visible cause. Note
that **BR-N6 is a second, independent cause of the same complaint**, so a
symptom that survives one fix does not indict it.

**And one that matters more.** Fan-out durability's whole point — survival
across an OS-level app restart — is **not covered by any test**. An in-memory
registry cannot be exercised across a process boundary in a unit test. It is
reasoned, not proven.

---

## Decided — do not relitigate

The documents that argued these are gone. The conclusions are not, and each
cost more to reach than it looks.

- **The embedded browser is kept.** Cutting it was ranked the highest-value
  removal in the app; the call went the other way, and it is being invested in
  as an agent-drivable surface. The cost is real and accepted: `tauri` stays
  pinned `=2.11.2` with `unstable` and `devtools`, held by the single
  `add_child` call in `src-tauri/src/browser/mod.rs`.
- **Provenance is not hunk-level, and there is no `"hunk"` scope to pass.** The
  journal attributes by overlapping time, never authorship, and for uncommitted
  lines there is no per-line evidence anywhere in the system. A hunk chip would
  be a fabrication dressed as precision.
- **Shell integration is sourced by the user, not injected.** Rewriting
  `ZDOTDIR`/`--rcfile` contradicts the `env_clear()` block whose point is a PTY
  environment identical to Terminal.app's, breaks prompts and plugin managers to
  earn a status badge, and would work for two shells while being silent for the
  rest.
- **`interrupted` is a frontend reading, not a Rust state.** The supervisor
  either knows a leg's true state or has no record of the run. Reconciliation
  can only ever upgrade a leg the supervisor confirms — it can never invent one.
- **The graph's "first parent keeps the mainline vertical" invariant is wrong,
  not the code.** Making it true would move a claimed lane sideways mid-flight,
  and the earlier child's segments are already emitted in the old column, so the
  line would arrive at one column and leave from another. A broken edge is worse
  than a kink.
- **"Load more" refetching the whole window is not worth a `skip` parameter.**
  libgit2 walks from the tips regardless, so the walk — the dominant cost — is
  paid either way.
- **Notification sound is split by channel, not by a `.sound(...)` flag.** A
  banner gets the platform's own sound, which respects Do Not Disturb; a `rodio`
  cue plays only where there is no banner. Double-sounding is impossible by
  construction.
- **The project brain is per-repo and app-owned**, under `.voidlink/brain`. It
  shares the six type names with the `brain` CLI and no code, no config and no
  vault.
