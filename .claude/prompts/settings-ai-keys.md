# Stream C — settings view, AI keys in Keychain, sentence-case sweep

Branch: `feat/settings-ai-keys` · Worktree: `.worktrees/settings-ai-keys` · Merge order: **2nd**

---

<context>
voidlink is a local-first Tauri v2 + SolidJS git workbench. Its AI features are deliberately BYO-CLI: `frontend/src/store/settings.ts` stores `ai.commitCommand` and `ai.agentCommand` as shell templates, and the Rust side pipes a diff or a grounded prompt into whatever generative-text command the user already has installed. The README advertises this as "No cloud. No API keys. No telemetry."
The user now wants somewhere to store AI provider keys. The decision is: store *real* keys, but in the macOS Keychain via the OS credential store — never in localStorage, never in the settings JSON, never returned to the frontend for display. The keys are injected as environment variables into the AI commands voidlink already spawns, so the BYO-CLI architecture is preserved and only the "no API keys" line in the README becomes untrue and must be corrected.
This stream also carries the global typography rule: voidlink must not use uppercase or all-caps labels anywhere.
</context>

<task>
1. Add OS-keychain-backed secret storage: Rust commands to set / delete / check-presence of named secrets, with the value never crossing back into the frontend.
2. Extend the settings dialog with an AI section where the user manages provider keys (env var name + value), sees masked presence state, and can delete a key.
3. Inject stored secrets into the environment of the AI subprocesses voidlink already spawns.
4. Sweep every uppercase / all-caps label in the app to sentence case.
5. Correct the README's "No API keys" claim.
</task>

<reuse>
- `frontend/src/store/settings.ts` (152 lines) — `AppSettings { ui, terminal, ai, brain }`, `AiSettings { commitCommand, agentCommand }`, the localStorage-backed `createStore` under key `voidlink-settings`, `mergeDefaults`, `load()`, and the `useSettings()` accessor exposing `updateTerminal` / `updateUi` / `updateAi` / `updateBrain` / `reset`. Extend this store for non-secret AI config (which env var maps to which provider); secret *values* must never enter it.
- `frontend/src/components/settings/SettingsDialog.tsx` (728 lines) — the existing dialog with its section components; line 393 uses `<h3 class="ui-section-label">`. Add the AI keys section here in the same idiom; do not build a second settings surface.
- `src-tauri/src/git/ai_commit.rs` and `src-tauri/src/git/agent.rs` — read these first; they are the two places that spawn the user's AI CLI. Environment injection belongs at those spawn sites, nowhere else.
- `src-tauri/src/lib.rs` — `mod` declarations (lines 7-9) and `tauri::generate_handler![...]` (line 303) for registering new commands.
- `frontend/src/api/` — thin `invoke` wrapper modules (`git.ts`, `fs.ts`, `terminal.ts`, `brain.ts`). Add `secrets.ts` in the same style.
- `frontend/src/commands/toast.ts` — `pushToast` for success/failure feedback.
- `frontend/src/commands/secretScan.ts` + `SecretScanDialog.tsx` — the repo already ships secret scanning; the storage design must not contradict it by writing plaintext keys to disk.
- Uppercase sweep targets (verified by grep — 20 occurrences):
  - `frontend/src/index.css:254` — the `.ui-section-label` rule (`text-transform: uppercase`, `letter-spacing: 0.05em`). Fixing this one rule covers its consumers at `SettingsDialog.tsx:393` and `GitSidebar.tsx:800,822,841`.
  - `frontend/src/components/layout/TerminalSidebar.tsx:109,138` ("Files", "Terminals")
  - `frontend/src/components/brain/BrainSurface.tsx:170,218`
  - `frontend/src/components/layout/StatusBar.tsx:157` ("Blame")
  - `frontend/src/components/layout/MainSurface.tsx:1391`
  - `frontend/src/components/git/conflict/ConflictTab.tsx:314`
  - `frontend/src/components/git/GitSidebar.tsx:101, 813, 1101 ("HEAD"), 1293 ("main"), 1385`
  - `frontend/src/components/git/stack/StackSidebarSection.tsx:218`
  - `frontend/src/components/git/compare/RefPicker.tsx:207,311`
  - `frontend/src/commands/CommandPalette.tsx:160`
  - `frontend/src/components/git/stack/StackTab.tsx:334, 690`
</reuse>

<constraints>
- Query context7 before using any new crate or Tauri API. Pinned: `tauri = "2.11"`, `@tauri-apps/api ^2.10.1`, Solid 1.9.7, Tailwind v4.2.1, TS 5.9.3.
- Use the `keyring` crate (check the current major on crates.io / context7 before pinning) for OS credential storage — macOS Keychain, with the same API covering Windows Credential Manager and Linux secret-service. Do NOT use `tauri-plugin-stronghold` (heavier, own vault format) and do NOT roll your own encryption.
- **The secret value must never be returned to the frontend.** Commands: `secret_set(id, value)`, `secret_delete(id)`, `secret_status() -> Vec<{ id, present: bool, hint: String }>` where `hint` is at most the last 4 characters. There is no `secret_get` exposed to JS — only Rust-internal reads at the spawn sites. The settings UI shows "set · ••••1234" and a delete button, never the value, and its input is `type="password"` and cleared on submit.
- Separation of concerns: keychain access in its own module (`src-tauri/src/secrets/mod.rs`) with pure-ish functions and thin Tauri command wrappers; `frontend/src/api/secrets.ts` for `invoke`; store holds only non-secret config; components render. No `invoke` in components.
- Errors must surface. A keychain denial (user cancels the OS prompt, locked keychain) returns a distinct error the UI reports via `pushToast` — never a silent swallow that leaves the UI showing "saved".
- Sentence-case rule: fix `.ui-section-label` at the CSS level first (drop `text-transform: uppercase`; keep the small size and letter-spacing tuning if it still reads well), then the per-component `uppercase` classes. Preserve genuine proper nouns and identifiers — `HEAD` at `GitSidebar.tsx:1101` is a git ref name, not a styled label; keep the literal text and just remove the `uppercase` class so it isn't *forced* to caps. After the sweep, `grep -rn "uppercase" frontend/src` must return nothing.
- Do not weaken `frontend/src/commands/secretScan.ts` or add anything it would flag.
- README: replace the "No cloud. No API keys. No telemetry." line and the matching bullet in the "Why VoidLink" section with an accurate statement — keys are optional, stored in the OS keychain, never transmitted by voidlink itself. Do not overclaim.
</constraints>

<assumptions>
- Secret identity is `{ id, envVar, label }` stored in settings (non-secret), with the value in the keychain under a service name like `com.voidlink.app` and account = `id`. Bundled presets for the common providers (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`) plus a free-form "add custom" row.
- Injection is additive: stored secrets are added to the child process env of the AI commands; existing inherited environment variables win if already set, so a user's shell config is not overridden. State this in the UI in one line.
- The frontend has no test runner today; Rust has `cargo test` with `tempfile`. Keychain access itself is not unit-testable in CI — test the pure parts (id/env-var validation, hint masking, env-merge precedence) and verify keychain round-trip manually.
</assumptions>

<out_of_scope>
- Embedding a model client or making HTTP calls to any AI provider from voidlink. The BYO-CLI architecture stays; keys are only forwarded to the user's own command.
- Window chrome / icon (`feat/macos-shell`), layout restructure (`feat/workspace-worktree-layout`), keyboard shortcuts and feature docs (`feat/shortcuts-and-docs`).
- A settings *view* replacing the existing dialog — extend the dialog, don't rebuild it.
- Syncing settings anywhere.
</out_of_scope>

<acceptance>
- `cd frontend && npx tsc --noEmit` clean; `npm run lint` no new errors; `cargo check` and `cargo test` pass from `src-tauri/`.
- `grep -rn "uppercase" frontend/src` returns no results, and the app still reads correctly (section headers legible, `HEAD`/branch labels unchanged in content).
- Rust tests cover: hint masking never exposes more than 4 characters, env-merge leaves an already-present inherited variable untouched, and invalid env var names are rejected.
- Manual verification, reported with what you actually observed: settings dialog has an AI section; adding a key prompts/succeeds and the row shows masked presence; reloading the app still shows it present; deleting removes it; the value never appears in `localStorage` (check `voidlink-settings` explicitly) and never in any log; running the AI commit action with a key set passes it through to the spawned command.
- README no longer claims "No API keys" and accurately describes keychain storage.
</acceptance>
