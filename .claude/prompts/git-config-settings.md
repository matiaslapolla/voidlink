<context>
VoidLink is a local-first Tauri 2 + Solid.js git workbench (repo root: the cwd; frontend in `frontend/`, Rust in `src-tauri/`). Its Settings dialog already configures UI, theme, terminal, keyboard, AI, stack and brain — but the Git tab only lists VoidLink-side commit-identity overrides stored in localStorage, and the app deliberately never touched `.git/config`. That stance now costs users a context switch to a terminal for every `user.email`, `pull.rebase` or `push.default` change. We are reversing it deliberately: VoidLink becomes able to read and write real git config, with the scope always visible so a write is never a surprise.

Note: today's docs and code comments state "your git config is never modified". That claim becomes false for the new surface and must be updated where it appears — do not leave it standing next to a writer.
</context>

<task>
Add a real git-configuration surface to VoidLink: Rust commands that read the effective config cascade and write a single key at a chosen scope via libgit2, plus a Settings → Git pane that edits a curated set of keys with an explicit Local / Global scope switch.

Deliver:
1. `src-tauri/src/git/config.rs` — a new module with:
   - `git_config_list_impl(repo_path) -> Result<Vec<ConfigEntry>, String>` reading the full snapshot of the effective cascade. `ConfigEntry { key, value, level }` where `level` is `"system" | "global" | "local" | "worktree" | "app" | "unknown"`, derived from `git2::ConfigLevel`.
   - `git_config_get_impl(repo_path, key) -> Result<Option<ConfigEntry>, String>` — the effective (winning) value for one key.
   - `git_config_set_impl(repo_path, key, value, scope) -> Result<(), String>` where `scope` is `"local" | "global"`. Local opens the repo config and writes at `ConfigLevel::Local`; global writes to `git2::Config::open_default()`'s global file (open the highest-level writable global via `Config::open_level`). Validate the key against the allowlist below and reject anything else.
   - `git_config_unset_impl(repo_path, key, scope) -> Result<(), String>` — remove the key at that scope so the cascade falls through again.
   - An allowlist constant of writable keys: `user.name`, `user.email`, `user.signingkey`, `commit.gpgsign`, `core.editor`, `core.autocrlf`, `core.ignorecase`, `core.filemode`, `init.defaultBranch`, `pull.rebase`, `push.default`, `push.autoSetupRemote`, `fetch.prune`, `rebase.autoStash`, `merge.conflictstyle`, `diff.algorithm`. Reads are unrestricted; writes are allowlist-only.
2. Tauri commands `git_config_list`, `git_config_get`, `git_config_set`, `git_config_unset` in `src-tauri/src/git/mod.rs` following the existing `#[tauri::command] pub async fn … blocking_git!(…)` shape, registered in the `tauri::generate_handler![…]` list in `src-tauri/src/lib.rs`.
3. `gitApi.configList / configGet / configSet / configUnset` in `frontend/src/api/git.ts`, with `ConfigEntry` and `ConfigScope` types in `frontend/src/types/git.ts`.
4. A rewritten `GitPane` in `frontend/src/components/settings/SettingsDialog.tsx`:
   - A Local / Global segmented control at the top of the pane, driving which scope writes land in. Local is disabled with an explanatory line when no repo is open (`useAppStore().activeRepoPath()` is null).
   - Grouped rows for the allowlisted keys (Identity / Commit / Branching & sync / Diff & merge / Core), each showing the effective value, the level it currently comes from (e.g. "from global"), and an inherited-vs-overridden affordance. Editing writes at the selected scope; a Clear action calls unset. Booleans and enums render as toggles/segments, not free text.
   - Keep the existing per-repo VoidLink identity-override list as its own section below, unchanged in behavior, with copy clarifying it is a VoidLink-side override applied at commit time and distinct from `user.name`/`user.email` in git config.
   - Errors from Rust surface through the existing `pushToast` helper.
5. Update `docs/features/settings.md` (and any other doc or code comment asserting VoidLink never modifies git config — grep for "never modified" / "never writes") to describe the new surface accurately.
</task>

<reuse>
- `src-tauri/src/git/repo.rs` — `open_repo(&repo_path)`; use it, do not open repositories by hand.
- `src-tauri/src/git/staging.rs:73` — `git_config_identity_impl`, the existing read of `repo.signature()`. Leave it in place (the commit box depends on it); the new module is additive.
- `src-tauri/src/git/mod.rs:215` — the `blocking_git!` macro; every new command wraps its `_impl` in it and takes `_state: tauri::State<'_, GitState>` like its neighbours (see `git_config_identity` at mod.rs:323).
- `src-tauri/src/lib.rs:837` — the `invoke_handler(tauri::generate_handler![…])` list; add the four commands there.
- `frontend/src/api/git.ts` — the `gitApi` object of thin `invoke<T>("git_…", { repoPath, … })` wrappers. camelCase args on the JS side, `#[serde(rename_all = "camelCase")]` on the Rust structs, exactly as existing types do.
- `frontend/src/components/settings/SettingsDialog.tsx` — reuse the local `Section` (l.510), `TextRow` (l.575), `ToggleRow` (l.547) and `SegmentedRow` (l.595) helpers rather than writing new row primitives; `GitPane` is at l.987. `AiPane`'s `ProviderKeysSection` (l.704) is the closest existing example of a pane that does async I/O, holds an error signal and renders a dynamic list — mirror its structure.
- `frontend/src/store/settings.ts` — `GitSettings.identityByRepo` and `setRepoIdentity`. Real git config does NOT go in this store; git config is its own source of truth and is read on pane open, never mirrored into localStorage.
- `frontend/design-system/MASTER.md` — the visual conventions the pane must follow. Read §7.5 (liveness & presence), §7.6 (interaction states) and §10 (accessibility) before writing the pane, not after.
</reuse>

<design>
The pane is a writer that can touch a file outside the repo. Its design job is to make provenance and blast radius legible at a glance. Follow `frontend/design-system/MASTER.md`; the specifics below are binding.

**Scope switch — the one control that must not be misread.**
A Local/Global segmented control (MASTER §9.3, `bg-primary/15 border-primary/40 text-primary` active) is necessary but not sufficient: it looks identical to the diff-mode toggle, which is harmless. Add a persistent, non-dismissible scope line directly beneath it that names the resolved file path the writes will land in — `~/.gitconfig` for global, `<repo>/.git/config` for local — read back from Rust, not composed in the frontend. Global scope additionally tints the pane's section headers with `--warning` at low alpha. No modal, no confirm-per-write: the scope is stated continuously so a write is never a surprise (MASTER §7.5.1 *Anticipation*). When no repo is open, Local is disabled with `aria-disabled`, `cursor-not-allowed` and a `title` giving the reason (MASTER §7.6 — a disabled control with no stated reason is an anti-pattern).

**Provenance — the inherited/overridden affordance, defined.**
Each row shows the effective value plus exactly one provenance mark, in the row's reserved right-hand slot:
- *Inherited* — `text-[10px] uppercase tracking-wider text-muted-foreground` reading `from global` / `from system`, and the value renders at 80% opacity. It is a fact about someone else's file.
- *Set here* — the same label reading `local` / `global` matching the active scope, value at full opacity, plus the Clear action.
- *Overriding* — set at the active scope **and** also present at a lower-precedence level: label reads `local · overrides global`, and hovering reveals the shadowed value. This is the case a user most needs to see and the one a naive implementation drops.
- *Unset* — value slot shows the git default in `text-muted-foreground` italic-free ghosting, labelled `default`.
Provenance is never colour-only (MASTER §10.12) — the label text carries it.

**Feedback — no toasts on the happy path.**
A config write completes in single-digit milliseconds, so it falls in MASTER §7.5.2's `< 80ms` band: render the new value and its new provenance mark, and show nothing else. A success toast for a value the user is looking at is banned (MASTER §7.5.5). Failures use `pushToast` with the resolved file path from Rust's error, plus Retry. If a write does exceed 80ms, the row's own control enters the pending state (§7.6) — the pane does not.

**Loading, empty, error — all three are required.**
- *Loading* (pane opens, cascade read in flight): render the row scaffold with `animate-pulse` on the value slots only. Never a blank pane, never a centred spinner (§7.5.2).
- *Read failure*: an inline error block in the pane body naming what failed, with Retry. Not a toast — a toast for a pane that has no content leaves the user staring at nothing.
- *No repo open*: the Local option is disabled as above and the pane still renders the full global cascade. This is not an empty state.
- *Stale*: the pane reads on open and after each write and does not watch `.git/config`, so a value can go stale behind an external edit. Show a refresh affordance in the pane header; do not claim liveness the implementation doesn't have (§7.5.4).

**Optimistic updates are forbidden here.** A config write is a filesystem write outside VoidLink's control (§7.5.6). Show the value returned by the read-back, never the value the user typed.

**Controls, grouping, a11y.**
- Booleans → pill toggle (§9.4); enums → segmented (§9.3); free text → input. Never a text field for `pull.rebase`.
- Groups are `Section` (SettingsDialog l.510) with the standard `text-[10px] uppercase tracking-wider font-semibold text-muted-foreground` label. Rows use the density classes (`.density-row`) — do not hardcode `py-1.5`.
- Every input has a real `<label htmlFor>`, not a placeholder (MASTER §10.6). Placeholders show format (`you@example.com`), never instruction.
- Every control satisfies all nine states in §7.6, with constant `border-width` across them.
- The two identity sections (git config `user.name`/`user.email` vs. the VoidLink per-repo override) sit adjacent and *will* be confused. Give the override section a distinct label and one line of copy stating it is applied by VoidLink at commit time and does not touch git config — and make sure the git-config identity rows do not repeat that copy.

**Motion budget**: this pane is opened rarely, so `--dur-short` (180ms) is available for the scope switch's tint change and nothing else. No layout animation, no row entrance stagger.
</design>

<constraints>
- Solid.js 1.9, not React: `createSignal` / `createResource` / `createEffect` / `<For>` / `<Show>`, props accessed as functions. No hooks-era React idioms.
- Rust: `git2 = "0.19"` (vendored libgit2), `tauri = "=2.11.2"`. Query context7 for the `git2` `Config` API (`Config::open_default`, `open_level`, `snapshot`, `entries`, `set_str`, `remove`, `ConfigLevel`) before writing it — do not write config code from memory.
- Separation of concerns: config logic lives in `src-tauri/src/git/config.rs`; `mod.rs` holds only the thin command wrappers; `api/git.ts` holds only `invoke` calls; the pane holds only presentation and calls `gitApi`. No `invoke` calls inside the settings component beyond the `gitApi` wrappers.
- All libgit2 work runs inside `blocking_git!` — never on the async runtime thread.
- Writes are allowlist-gated in Rust, not just in the UI. An out-of-allowlist key must be rejected server-side with a clear error.
- Never shell out to `git config` for these commands; `cmd.rs`'s `run_git` exists for porcelain mid-states, and config is exactly the case libgit2 models correctly.
- Global writes touch a file outside the repo. The UI must make the active scope unmistakable before an edit commits, and the Rust layer must surface the resolved file path in its error messages when a write fails.
- Build exactly this slice. Make routine judgment calls yourself; check in only where two readings would produce materially different work. If a premise here looks wrong, say so in one sentence and continue as specified rather than quietly widening or narrowing it.
</constraints>

<assumptions>
- Curated allowlist, not a free-form "edit any git config key" editor — the point is a safe, discoverable surface, and an arbitrary-key editor is a terminal's job.
- Reads show the full cascade; writes are Local or Global only (no system scope — it needs elevation and is not a per-user concern).
- The pane reads config on open and after each write; no filesystem watcher on `.git/config`.
</assumptions>

<out_of_scope>
- System-scope writes.
- Editing arbitrary (non-allowlisted) config keys.
- Credential helper / remote URL / auth configuration — remotes already have their own surface.
- A config diff or history view.
- Migrating the existing `identityByRepo` overrides into real git config.
- Watching `.git/config` for external changes.
- Any change to the commit box, `git_commit_impl`, or the identity-override commit path.
- The editor module (a separate prompt covers it).
</out_of_scope>

<acceptance>
- `cd frontend && npx tsc --noEmit` clean; `cargo check --manifest-path src-tauri/Cargo.toml` clean.
- New Rust tests in `src-tauri/src/git/config.rs` using the existing `tempfile` dev-dependency (see the test patterns already in the `git/` modules): init a temp repo, set `user.email` at local scope, assert `git_config_get_impl` returns it with `level == "local"`; assert `git_config_unset_impl` makes it fall through; assert a non-allowlisted key (`core.hooksPath`) is rejected by `git_config_set_impl`.
- A vitest file for whatever pure helper the pane extracts (level-label formatting, allowlist grouping) under `frontend/src/components/settings/`, matching the existing `*.test.ts` style. Run only the touched tests: `cd frontend && npx vitest run src/components/settings` and `cargo test --manifest-path src-tauri/Cargo.toml config`.
- Manual: open Settings → Git in a repo, change `pull.rebase` at Local scope, confirm `git config --local pull.rebase` in a terminal reports the new value and the pane shows "from local"; switch to Global, change `init.defaultBranch`, confirm `git config --global init.defaultBranch`.
- Design acceptance, checked against `frontend/design-system/MASTER.md`:
  - The resolved target file path is visible at all times without hovering or opening anything, and it comes from Rust.
  - Set `user.email` at global, then set a different one at local: the row reads `local · overrides global` and the shadowed global value is reachable. Clear the local one: the row falls back to `from global` with the value at 80% opacity.
  - No toast fires on a successful write. Make a write fail (chmod the config file read-only) and confirm the toast names the resolved path and offers Retry.
  - Open the pane with a cold cache: the row scaffold renders with pulsing value slots, not a blank pane or a centred spinner.
  - Tab through the entire pane with no mouse: every control takes a visible `focus-visible` ring, the disabled Local option states its reason, and no control leaves the tab order while a write is in flight.
  - Toggle to `solarized-light` and `monokai` and confirm every provenance label and status tint still meets 4.5:1.
  - `prefers-reduced-motion: reduce` — the pane loses no information; the loading pulse remains legible as a state.
</acceptance>
