# Agent as pane citizen — Stage 1 of the AI Agent OS path

Written 2026-07-30. Stage 1 of three (Stage 2: event log + fan-out + annotated
diffs. Stage 3: cross-workspace Mission Control + hill charts). Derived from the
design audit of 2026-07-29 — resolves findings 3 (agent panel outside the island
system), 13 (worktree scope remembered, not structural) and 14 (no cancel, no
retry).

Scope decisions taken before writing: all three sub-features in one pass; riskiest
assumption is *agent-as-pane-citizen*; Rust gets a new streaming + cancellable
command; the slide-over is kept as a second renderer over one store.

---

```text
<context>
VoidLink (Tauri v2 + SolidJS + Rust, /Users/matiaslapolla/Developer/personal/voidlink) is
becoming an AI Agent OS for engineers and product people. Today its agent is a
fixed right-edge slide-over: one anonymous "Repo agent" per worktree, thread in
memory only, no cancel, no retry, no streaming, and — because `git_agent_query`
runs through the `blocking_git!` macro — an agent turn holds the per-repo git
lock for its entire duration, stalling every other git operation on that repo.

This is Stage 1 of three. It tests the load-bearing assumption: that an agent
thread wants to live in the split-pane tree next to a diff and a terminal, as a
peer, rather than as an overlay you toggle. If that's right, Stage 2 (append-only
event log, one-prompt-to-N-worktrees fan-out, annotated diffs) and Stage 3
(cross-workspace Mission Control with hill charts) build on this substrate. If
it's wrong, we learn it before either is built.

Promoting the agent to a tab kind also buys, for free, everything the pane tree
already gives every other kind: splits, drag-between-groups, the activity LED,
tab-group colouring, the tab switcher, MRU, reopen-last-closed, session restore,
and — critically — worktree scope becomes *structural* rather than remembered,
which fixes a live defect where switching worktrees with the slide-over open
silently swaps the conversation with no indication.
</context>

<task>
Ship Stage 1 in one pass:

1. **Agent becomes a tab kind.** A new `agent` kind in the tab registry, renderable
   in any pane group, multiple per worktree, persisted across reloads (tab AND
   conversation).
2. **Named agents.** A per-workspace roster of named agents (name + CLI command
   template each). An agent tab is bound to one roster entry. The existing single
   `settings.ai.agentCommand` becomes the default roster entry so nobody loses
   their configured CLI.
3. **Streaming + cancellable turns, outside the git lock.** A new Rust command
   that spawns the user's CLI, streams stdout to the frontend over a
   `tauri::ipc::Channel`, and can be killed by turn id. It must NOT go through
   `blocking_git!`.
4. **Cancel and retry in the UI.** A turn in flight shows a Cancel affordance; a
   failed or cancelled turn shows Retry. Never disable a control as the only way
   of saying "busy".
5. **Keep the slide-over.** `AgentPanel.tsx` stays for quick questions, but
   becomes a second renderer over the same store — not a second implementation.
   `agent.toggle` keeps opening it. Add a separate action that opens/focuses an
   agent *tab* in the active worktree.
</task>

<reuse>
**The tab registry is the spine — read it before writing anything.**
`frontend/src/store/layout/tabs.ts` exists specifically so adding a kind is one
spec entry plus a handful of declared sites. Its header comment explains the two
deliberate non-goals (state fields are NOT collapsed into one record; storage
keys are NOT consolidated) — respect both.

Model the `agent` kind on **`browser`**, not `brain`: like browser it has its own
per-tab payload, multiple instances per worktree, and `equals: (a, b) => a.id === b.id`
(two threads with the same agent is a normal thing to want). Copy the
`TAB_SPECS.browser` entry shape at `tabs.ts:471-490` — `serialize`/`deserialize`/
`restore`/`equals`/`label`/`closedSnapshot`.

Sites to touch, all found by tracing `"brain"` and `browserTab` through the store:
- `frontend/src/store/layout/tabs.ts` — `AgentTab` interface; `ActiveItem` variant
  (~line 109); `ClosedTab` variant (~139); `TabKind` union (~153); `TabTypes`;
  `TabCollectionKey` (`agentTabsByWorktree`); `TAB_SPECS.agent`;
  `TAB_KIND_GROUP_LABELS`; `TAB_KINDS` render order.
- `frontend/src/store/layout/persistence.ts` — two new `STORAGE_KEYS` entries
  (tabs + threads). Comment each the way its neighbours are commented.
  **No module outside this one touches localStorage — that rule has no exceptions.**
- `frontend/src/store/layout/state.ts` — the `agentTabsByWorktree` field.
- `frontend/src/store/layout/index.ts` — `loadKindRecord` (~345), `activeOf` (~504),
  the kind list (~567), the `activeItem` case (~856), (~1630), the
  open/close/select trio (follow the brain pattern at ~1758-1789), (~1924), (~2095).
- `frontend/src/store/layout/navigation.ts` — `ITEM_TYPES` (~180).
- `frontend/src/components/layout/TabStrip.tsx` — its local `TabKind` union (~67).
  The strip attaches no behaviour to any value, so this is the whole cost there.
- `frontend/src/components/layout/MainSurface.tsx` — descriptor push (follow the
  brain block at ~192-203), `select` case (~532), `close` case (~547), and a
  `<For each={activeAgentTabs()}>` pane body next to the browser/brain blocks
  (~995-1020). Reuse `paneClass()`, `paneStyle(tab.id)`, `tabMark(tab.id)`.

**Frontend agent logic:** `frontend/src/commands/agent.ts` already owns
`assembleContext` — the grounded-prompt assembly (repo info, changed files, log,
staged diff, open files, conversation history) and the per-source `AuditItem`
trail. **Keep all of it.** Rework the module's *state* (roster, per-tab threads,
per-turn busy/cancel) and its *transport* (streaming), not its context assembly.
`AuditItem` and the "Context used (N)" disclosure are the product's trust story.

**Rendering:** `frontend/src/components/agent/AgentPanel.tsx` already has the
message bubbles, `marked` + `DOMPurify` markdown pipeline, `AuditDisclosure`,
auto-scroll, and the Enter/Shift+Enter composer. Extract that into a shared
`AgentThreadView` (or equivalent) that both the slide-over and the tab body
render. Do not fork it — a second copy is exactly the drift this slice exists to
prevent.

**Rust:** `src-tauri/src/git/cli.rs:23` `run_cli` already solves the three hard
parts — login-shell re-exec so Finder-launched apps find `claude` on PATH
(`cli.rs:46-66`, read that comment), keychain secret injection with the user's own
env winning (`cli.rs:68-85`), and template parsing via `split_command`. **Refactor
the command-building half of `run_cli` into a shared helper both the existing
one-shot and the new streaming path call.** Duplicating the login-shell/secret
logic is the sin to avoid; it will drift and the drift will be a
"works in dev, broken from the Dock" bug.
- `src-tauri/src/git/agent.rs` — read its header comment; the trust model it
  states (no embedded model, no telemetry, BYO CLI) is a constraint, not a note.
- Register the new command(s) in the `invoke_handler` near `src-tauri/src/lib.rs:1252`.
- Streaming template: `src-tauri/src/lsp/mod.rs:225,325,369` and
  `src-tauri/src/browser/mod.rs:210` show the existing emit patterns; the frontend
  listener side is `frontend/src/api/lsp.ts:70-78`.
- New frontend API module alongside `frontend/src/api/git.ts:366` `agentQuery`.

**Design system:** `frontend/design-system/MASTER.md` outranks every default.
Non-negotiable for this slice: §6 islands take no border and no `shadow-xl`
unscrimmed (the current slide-over violates both — fix it while you're in there);
the named `--z-*` scale, never a raw `z-40`; §7.5 liveness channels; §7.6's nine
interaction states, incl. `focus-visible:` not `focus:`. Any looping spinner or
pulse you add MUST carry the `motion-loop` class or it freezes on its final
keyframe under `prefers-reduced-motion` and the pending state loses its only
visual channel. `frontend/src/components/layout/StatusLed.tsx` is the model for a
liveness signal that survives reduced motion.
</reuse>

<constraints>
- **Separation of concerns.** Transport in `api/`, orchestration and state in
  `commands/agent.ts`, layout/persistence in `store/layout/*`, rendering in
  `components/agent/*`. No component invoking Tauri directly; no store module
  assembling prompts.
- **Reuse before invent.** Grep before adding any helper. This codebase has
  `commands/inflight.ts`, `commands/toast.ts`, `store/activity.ts` and an
  existing event-bus convention — check them before writing a new one.
- **context7 before any library API call** (`resolve-library-id` → `query-docs`).
  Specifically: `tauri::ipc::Channel<T>` on the Rust side and
  `Channel` from `@tauri-apps/api/core` on the frontend are the confirmed v2
  streaming primitive — verify the current signatures rather than working from
  memory. Same for anything you reach for in `marked`/`DOMPurify`.
- **The new agent command must not take the git lock.** That is half the point of
  the Rust work. Killing a turn must kill the actual child process, not just
  discard its output — a cancel that leaves the CLI running is the bug this
  replaces.
- **Malformed persisted state costs one tab, not the boot.** `deserialize`
  returning `null` on bad input is the registry's contract; threads read off disk
  get the same defensive treatment.
- **Streaming is append-in-place.** The assistant message grows; the audit list
  attaches on completion. Never blank a rendered region to show it's updating
  (MASTER §7.5.2/§7.5.4) — the existing commit graph gets this wrong; don't copy it.
- **Migration must be silent.** An existing user with `settings.ai.agentCommand`
  set and no roster boots into a one-entry roster using that command, with their
  slide-over thread behaviour unchanged. No orphaned tabs, no reset settings.
- **Build exactly this slice.** Make routine calls yourself; check in only where
  two readings mean materially different work. If a premise here looks wrong, say
  so in one sentence and continue as asked rather than quietly widening or
  narrowing scope.
</constraints>

<assumptions>
Chosen where unspecified — change only with a stated reason:
- **Roster lives in settings, not layout.** `settings.ai.agents: { id, name,
  commandTemplate }[]` in `store/settings.ts` — it's configuration, not geometry.
  `settings.ai.agentCommand` is kept and used as the default entry's template for
  back-compat.
- **`AgentTab = { id, agentId, title?: string }`.** The thread is keyed by tab id,
  persisted as `Record<worktreeId, Record<tabId, AgentMessage[]>>` under its own
  storage key. The slide-over reads the same store under a reserved constant tab
  id, so both renderers share one thread model.
- **Tab label** is the agent's name, with the tab's first user message as the
  tooltip. `pinnable: true`, `draggable: true` — unlike brain/browser there's
  nothing structural stopping either.
- **Busy is per-turn, not global.** The current module-level `busy` signal blocks
  every thread at once; with N agents that's wrong. Key it by tab id.
- **Cancel keeps partial output**, marked as cancelled, rather than discarding it.
- **Retry** drops the failed/cancelled assistant turn and re-sends the last user
  message with freshly assembled context.
- **Roster editing** lives in the existing Settings → AI pane
  (`components/settings/SettingsDialog.tsx`), not a new surface.
</assumptions>

<out_of_scope>
Each of these is separately named because none of them generalize from the others:
- Fan-out: one prompt to N worktrees, and any side-by-side compare of N results.
- Annotated diffs — commenting on a hunk to feed the agent.
- The append-only event log (Stage 2). Persisting threads here is a *tab* concern;
  do not generalize it into an event log or invent its schema.
- Mission Control / The Lineup / any cross-workspace surface (Stage 3).
- Hill charts, hill positions, and any progress model beyond running/done/failed.
- Scheduled check-ins, standup generation, brain-vault writes.
- Design Mode in `BrowserPane`; SSH remote execution; a mobile companion; a CLI
  scripting layer.
- Agent tool use, file writes, or any agent-initiated git mutation. The agent
  answers; it does not act.
- Account/rate-limit tracking and hot-swapping provider accounts.
- Agents in the satellite editor/git windows. Workbench only.
- The other audit findings (`motion-loop` sweep across the other 20 sites, the
  `PANEL_BOUNDS` overflow, the type-scale rem conversion, the `lanes.ts` colour
  bug). Fix them only where they fall inside a file this slice already rewrites.
- Rewriting `MASTER.md §1`'s three-feature scope statement. Needed, separate task.
</out_of_scope>

<acceptance>
- An agent tab opens in any pane group, splits, drags between groups, survives a
  reload with its conversation intact, appears in the tab switcher and MRU, and
  reopens via reopen-last-closed.
- Two agent tabs with different roster entries run concurrently in one worktree;
  one being busy does not block the other.
- Cancel mid-turn terminates the child process (verify with `ps` — no orphan) and
  leaves the partial answer visible and marked cancelled.
- Retry after a failure produces a fresh turn.
- An agent turn no longer blocks concurrent git operations on the same repo:
  start a long turn, then stage a file from the git sidebar and confirm it lands
  immediately.
- Answers still stream token-by-token and still show "Context used (N)" with the
  same audit sources as before.
- The slide-over and the tab render the same thread when pointed at the same one,
  from one component.
- Reduced motion: `prefers-reduced-motion: reduce` still shows a distinguishable
  pending state on a streaming turn.

Tests — touched files only:
- `frontend/src/store/layout/tabs.test.ts` — the agent kind round-trips
  serialize→deserialize, and malformed input yields `null`. This file already
  round-trips every kind; extend it rather than adding a parallel file.
- `frontend/src/store/layout/durability.test.ts` and `navigation.test.ts` — extend
  their kind coverage the way the existing entries do.
- New unit test for the per-tab busy/cancel/retry state machine in
  `commands/agent.ts`: cancel clears busy for that tab only; retry drops exactly
  the failed turn.
- Rust: a test that the shared command-builder produces identical argv/env for the
  one-shot and streaming paths, and one that a killed turn reaps its child.

Commands:
- `cd frontend && npx tsc -b` — clean.
- `cd frontend && npx vitest run` on the touched test files only.
- `cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings` — clean.
</acceptance>
```
