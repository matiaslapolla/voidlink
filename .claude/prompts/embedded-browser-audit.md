# Embedded browser — audit, the address-bar fix, and the unused engine surface

Written 2026-07-31. Produced by `/feature-prompt` from the brief "improve the
web browser 10x, audit it, the address bar does not work after the user
interacts with the page, and we need an engine that can later connect to the
workbench module".

The recon that shaped it: the Tauri child webview already exposes `set_focus`,
`on_navigation`, `url()`, `set_zoom`, `print`, the cookie jar and
`clear_all_browsing_data`, and `src-tauri/src/browser/mod.rs` uses none of them.
The engine was not the constraint. The product fork it closes is C1 of the
2026-07-29 workbench audit, which ranked *cutting* this feature fourth.

---

```text
<context>
VoidLink (Tauri v2 + SolidJS + Rust, /Users/matiaslapolla/Developer/personal/voidlink)
has an embedded browser tab kind backed by real Tauri child webviews. It has a
live defect — the address bar stops responding once the user has interacted with
the page — and it is under an open product question: `docs/specs/2026-07-29-workbench-100x.md`
ranks **cutting** this feature as its #4 highest-value move (finding C1, still
open), because it alone holds `tauri` at `=2.11.2` with the `unstable` and
`devtools` features, and because every new modal surface pays it a line of tax
(`setOverlayOpen` registrations in `App.tsx` have grown from 3 to 10).

The product call has now been made: **keep it and invest.** This slice has to
earn that call rather than assume it. The direction it is being kept for is a
browser wired into the workbench — agents driving pages, dev-server awareness,
browser events in the journal, and previews attached to fan-out legs and compare
tabs. None of that is built here; this slice makes the surface trustworthy and
names the seams those four will attach to.

The load-bearing recon fact, confirmed against context7 for tauri 2.x: the
engine already exposes `Webview::set_focus`, `WebviewBuilder::on_navigation`
(fires on navigation *start*, returning false cancels), `url()`, `set_zoom`,
`print`, `cookies()` / `cookies_for_url()` / `set_cookie` / `delete_cookie`,
`clear_all_browsing_data`, `set_background_color`, `reparent` and `eval_script`.
`src-tauri/src/browser/mod.rs` uses **none** of them. Most of the quality gap is
unused surface on the engine already in the tree, not an argument for a
different engine.
</context>

<task>
Audit the embedded browser end to end, write the findings up as a versioned
audit document, and ship the address-bar fix plus the improvements the audit
rates highest — where "highest" is bounded by the constraint that this slice
adds no new dependency and does not change the `tauri` pin.

Three parts, in order:

1. **Diagnose the address-bar defect and fix it.** The reported symptom is that
   the address bar stops working after the user interacts with the page.
   Reproduce it before fixing it. The leading hypothesis, which you must confirm
   or refute rather than assume: a child webview is a sibling native view that
   takes OS keyboard focus, and nothing in this codebase ever gives focus back
   to the host webview — `set_focus` is called nowhere in `src-tauri/src/browser/`.
   Two consequences are consistent with the symptom and may both be live:
   keystrokes aimed at the address bar go to the page instead, and the
   `document.activeElement !== addressInput` guard at `BrowserPane.tsx:93` never
   sees the input as focused, so every `browser-navigated` event overwrites what
   the user typed. State in the audit which one you confirmed.

2. **Audit the whole feature.** Rust module, frontend pane, API bridge, tab
   persistence, and the overlay-tax mechanism. Report **every** finding with a
   severity and a confidence — do not filter to "what matters", do not drop
   nitpicks, do not cap the count. Dropping a finding requires a stated reason;
   silence is not a filter. Cover at minimum: focus and keyboard handling; the
   `browser_set_rect` command exposed in `api/webview.ts` that no caller
   invokes; error and loading states (there is no loading indication at all
   today — `on_navigation` is what would provide it); what happens to a tab
   whose first `open` failed; the `-20000,-20000` offscreen parking fallback;
   history edge cases beyond the six covered by the existing Rust unit tests;
   and the overlay-count mechanism's growth cost.

3. **Ship the improvements the audit ranks highest**, drawn from the unused API
   surface above. Do not build all of it — pick what the audit justifies, and
   say in the document what you deliberately left for later and why.
</task>

<reuse>
Read these before writing anything. They are the whole feature.

- `src-tauri/src/browser/mod.rs` (564 lines) — webview lifecycle, the `History`
  struct with cursor + `traversing` flag, all nine commands, both events, and
  six history unit tests at the bottom. The module header states two invariants
  that are load-bearing and must survive this change: the child webview holds
  **no capability** (`capabilities/default.json` is scoped by webview *label*
  `"webviews": ["main"]`, not by window), and **no script of VoidLink's ever
  enters a browser tab** — which is why history is app-tracked instead of
  driven through `history.back()`. If you reach for `eval_script`, you are
  breaking the second one; that needs to be raised as a decision, not taken
  quietly.
- `frontend/src/components/browser/BrowserPane.tsx` (267 lines) — the address
  bar, the `measure()` anchor rect, the `ResizeObserver` + window listeners,
  `shouldShow()`, and the `navigate()` retry path for a failed first open.
- `frontend/src/api/webview.ts` (122 lines) — the only module that knows a tab
  is a webview. Any new command goes here, nowhere else.
- `frontend/src/components/browser/url.ts` + `url.test.ts` — `normalizeUrl`,
  `browserTabLabel`. Pure and already unit-tested in the node project; extend
  these rather than adding parsing logic to the pane.
- `frontend/src/commands/overlay.ts` — the counted open-overlay registry the
  pane hides on. `App.tsx:418-432` holds the ten `setOverlayOpen` effects.
- `frontend/src/store/layout/tabs.ts` — `TAB_SPECS.browser`, persistence and the
  closed-tab snapshot shape. New persisted per-tab state (zoom, for instance)
  goes through the spec's `serialize`/`deserialize`, not a second store.
- `docs/features/browser.md` — the feature doc, including an explicit "What it
  doesn't do" list. Update it to match whatever ships.
- `docs/audits/2026-07-30-git-surfaces.md` — the format the new audit follows.
- `src-tauri/Cargo.toml:24-30` — the pin and the comment explaining it.

Reference for the seams, not for editing: `src-tauri/src/journal/mod.rs`
(`journal::note`, the event-kind families) and `src-tauri/src/agent/mod.rs`
(`agent_stream_query`). Where the audit identifies a seam for the four future
tie-ins, name it in the document with the file and symbol it would attach to.
</reuse>

<constraints>
- **Query context7 before calling any Tauri API you have not already seen used
  in this repo.** The multiwebview surface is behind the `unstable` feature and
  is allowed to break across patch releases; training data lags. `resolve-library-id`
  then `query-docs`.
- **No new dependencies, and do not change the `tauri` pin.** The point of this
  slice is that the engine already has what is needed. If you conclude something
  in the audit genuinely requires a dependency, write it up as a finding and
  leave it unbuilt.
- **Rust owns the webview; the frontend owns tab state.** A new capability means
  a Rust command plus a method on `browserApi`, keyed by the frontend's tab id.
  No component touches `@tauri-apps/api/webview` or `invoke` directly.
- **Do not widen the child webview's capability.** `capabilities/default.json`
  stays scoped to the `main` webview label. A page the user loads must not be
  able to reach an app command.
- **Pure logic goes in `.ts`/Rust functions with unit tests**, surfaces get
  render tests for wiring only. Rust history/state logic gets `#[cfg(test)]`
  tests in the module, as the existing six do.
- **jsdom has no layout engine.** Anything asserting geometry cannot be tested
  in the `render` project — `src/test/layout.ts` fakes a viewport for tests that
  opt in, and it makes "which elements exist" testable while leaving "where they
  landed" fiction. Use `src/test/tauri.ts` (`mockTauri`) to fake the Tauri
  boundary; do not add `vi.mock` calls.
- **Build exactly this slice.** Make routine calls yourself; check in only where
  two readings mean materially different work. If a premise here looks wrong,
  say so in one sentence and continue as asked rather than quietly widening or
  narrowing it.
</constraints>

<assumptions>
- The four workbench tie-ins (agent-driven pages, dev-server awareness, journal
  events, preview targets for fan-out legs and compare tabs) are **direction,
  not scope**. This slice names the seam for each in the audit document and
  builds none of them.
- The audit document goes to `docs/audits/2026-07-31-embedded-browser.md`
  unless the existing naming suggests otherwise.
- Closing finding C1 means adding a dated entry to the ledger in
  `docs/specs/2026-07-29-workbench-100x.md` recording that the product call went
  the other way and why — not deleting the finding.
</assumptions>

<out_of_scope>
- Replacing wry, embedding CEF, or adding any second browser engine.
- A CDP or automation layer, and any agent-callable browser tool.
- Bookmarks, a home page, or a start page.
- Downloads.
- Per-tab profiles or incognito.
- Persisted browsing history across sessions.
- Journal event kinds for browser activity.
- Dev-server detection or auto-open of localhost ports.
- Attaching a preview URL to a fan-out leg or a compare tab.
- Restoring scroll position across worktree switches.
- Removing the browser tab kind or unpinning `tauri`.
- Rewriting the overlay mechanism — audit its cost, propose the fix, do not
  build a replacement in this slice.
</out_of_scope>

<acceptance>
- The address-bar defect reproduces before the fix and does not after, and the
  audit states which root cause was confirmed.
- `docs/audits/2026-07-31-embedded-browser.md` exists, with every finding
  carrying a severity and a confidence, a ranked list of what shipped versus
  what was deferred with reasons, and a named seam (file + symbol) for each of
  the four future tie-ins.
- `docs/features/browser.md` matches what ships, including its "What it doesn't
  do" list.
- `docs/specs/2026-07-29-workbench-100x.md` has a ledger entry closing C1.
- Rust: `cargo test -p <crate> browser` passes, with new `#[cfg(test)]` tests
  covering any new state logic and the existing six history tests still green.
- Frontend: `npx vitest run --project unit src/components/browser` and any new
  render tests pass. Tests are written for touched files only.
- `npx tsc --noEmit` is clean, and `cargo clippy` reports nothing new on the
  files touched.
- `npm run tauri dev` launches, a browser tab opens, and the address bar accepts
  input after clicking into the page.
</acceptance>
```
