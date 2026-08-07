/// The bridge between the workbench window and its satellites.
///
/// voidlink runs three roots out of one bundle — `main` (terminals, workspaces,
/// agents), `git` (the standalone git client) and `editor` (the code editor).
/// Each is a separate webview, so each is a separate JS context: separate Solid
/// stores, separate module state, no shared reactivity. Rather than try to
/// mirror the whole layout store across the gap, only a few things cross it:
///
///   1. **Which repository is active.** `main` owns that decision (it has the
///      rail and the worktree switcher) and broadcasts it. The satellites are
///      pure consumers — they never pick a repo, so they can never disagree.
///   2. **"Refs changed."** Any window can commit, fetch, or rebase, and the
///      others have to refetch. This re-broadcasts the in-process
///      `voidlink:refresh-git` pulse across windows.
///   3. **The editor window's tab list.** `main` is the only window that writes
///      (and persists) tab state, so the editor window renders from a snapshot
///      `main` broadcasts and asks for mutations by sending requests back. See
///      `EditorTabsSnapshot` / `EditorRequest` below for why it is shaped that
///      way rather than as a second writer.
///   4. **Appearance and view preferences** — the active theme and whether
///      inline blame is on. Both are single localStorage keys the workbench's
///      UI writes, and a satellite that hydrated once at module eval would show
///      the *previous* theme for the rest of its life (the editor window is
///      reused, not recreated). See `publishThemeChange` / `publishBlameEnabled`.
///
/// Everything else the satellites show they read straight from the Rust git and
/// fs commands, which are stateless and window-agnostic — so there is nothing
/// else to synchronise.
///
/// **Stacked mode** (`settings.ui.environmentMode`) collapses all three into one
/// window as switchable views. Nothing above changes shape: the workbench
/// installs a `StackedViewRouter` here and the open/focus functions redirect to
/// a view switch, while the surfaces get their context and tab snapshot from the
/// store directly instead of off the wire. That is why none of the call sites
/// scattered through the app know which mode they are in.

import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emitRemoteGitRefsChanged, onGitRefsChanged } from "@/commands/gitEvents";
import { GIT_CHANGED_EVENT } from "@/api/watch";
import type { AgentSession } from "@/components/agent/agentBoard";
import type {
  ActiveItem,
  ConflictTab,
  DiffTab,
  OpenFileTab,
  PreviewTab,
} from "@/store/layout";

/// Window label used by the git client. Must match `GIT_WINDOW_LABEL` in
/// `src-tauri/src/window.rs`.
export const GIT_WINDOW_LABEL = "git";

/// Window label used by the code editor. Must match `EDITOR_WINDOW_LABEL` in
/// `src-tauri/src/window.rs`.
export const EDITOR_WINDOW_LABEL = "editor";

/// The workbench's own label. Not a satellite — the sole writer of state.
export const MAIN_WINDOW_LABEL = "main";

/// Window label for a detached sidebar panel. Must match `PANEL_SPECS` in
/// `src-tauri/src/window.rs`, and must have an entry in
/// `src-tauri/capabilities/` — a webview with no capability entry has *no*
/// permissions at all, not even `core:event`, which is the failure the editor
/// window's capability file documents.
export const FILES_PANEL_WINDOW_LABEL = "panel-files";

/// Which window hosts each sidebar when it is detached. `null` means "this one
/// cannot be detached" and the affordance is absent rather than disabled.
///
/// **The git panel reuses the existing git window rather than getting a
/// panel-scoped one of its own.** The standalone git client (`GitApp`, label
/// `git`) is already the git surface with a whole window around it — the very
/// same panes, laid out as nav plus detail instead of a 300px column. A second
/// window that also showed the git panel would be two answers to "the git panel
/// is in a window", with two labels, two capability entries and two things for
/// a user to have open at once. So "detach git" opens *that* window and marks
/// the sidebar detached, which is what collapses its slot in the shell.
///
/// The pre-existing "Open git window" button is left as it was: it opens the
/// same one window without detaching. Opening the fuller surface beside the
/// sidebar is a different intent from moving the sidebar out, and the panel
/// still lives in exactly one window either way.
///
/// The workspace rail is deliberately not detachable. It is the workbench's own
/// writer — creating a workspace or a worktree registers state and spawns a
/// PTY — and a satellite's store is an unpersisted private copy, so every one
/// of its buttons would be the silent no-op `requestOpenWorktreeOnMain` exists
/// to fix. Making it work means mirroring the whole workspace model across the
/// gap, which is a stream of its own.
export const SIDEBAR_WINDOW_LABEL: Record<string, string | null> = {
  workspaces: null,
  files: FILES_PANEL_WINDOW_LABEL,
  git: GIT_WINDOW_LABEL,
};

/// Which sidebar this window *is*, or `null` in the workbench and the two
/// full-surface satellites. Read at render time by `main.tsx`, the same way the
/// git and editor roots are chosen.
export function currentPanelSidebar(): string | null {
  const label = currentWindowLabel();
  for (const [id, windowLabel] of Object.entries(SIDEBAR_WINDOW_LABEL)) {
    if (windowLabel && windowLabel === label && label !== GIT_WINDOW_LABEL) return id;
  }
  return null;
}

const CONTEXT_EVENT = "voidlink://window-context";
const CONTEXT_REQUEST_EVENT = "voidlink://window-context-request";
const REFS_EVENT = "voidlink://git-refs-changed";

/// The slice of workbench state a satellite window needs to do its job.
export interface WindowContext {
  /// Working directory of the active worktree — what every git command is run
  /// against. `null` when no repository is open in the workbench.
  repoPath: string | null;
  /// Layout-store id of the active worktree. Echoed back on refresh pings so
  /// the workbench knows which panes to invalidate.
  worktreeId: string;
  branch: string | null;
  /// Human labels for the satellite's header, so it can say *which* repo it is
  /// showing without duplicating the rail.
  workspaceName: string;
  worktreeLabel: string;
}

/// The label of the window this code is running in. Cheap and synchronous —
/// it reads Tauri's injected metadata rather than doing IPC.
export function currentWindowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    // Running outside Tauri (vitest, a plain browser): treat as the workbench.
    return MAIN_WINDOW_LABEL;
  }
}

export function isGitWindow(): boolean {
  return currentWindowLabel() === GIT_WINDOW_LABEL;
}

export function isEditorWindow(): boolean {
  return currentWindowLabel() === EDITOR_WINDOW_LABEL;
}

/// True in the workbench — including outside Tauri, where there is no window
/// label to read and the workbench is the only sensible default.
export function isMainWindow(): boolean {
  return currentWindowLabel() === MAIN_WINDOW_LABEL;
}

// ─── Stacked mode ───────────────────────────────────────────────────────────
//
// In stacked mode there are no satellite windows: the workbench hosts the git
// client and the editor as switchable views. Every "show me the editor" call
// site — the title bar, the git sidebar's file rows, the file tree, the command
// palette, a terminal deep-link — would otherwise need its own mode check. So
// the workbench registers a router here instead and the functions below route
// to it, which keeps every one of those call sites written once.

export interface StackedViewRouter {
  showWorkbench(): void;
  showEditor(): void;
  showGit(): void;
}

let stackedRouter: StackedViewRouter | null = null;

/// Install (or clear, with `null`) the stacked-mode router. Only the workbench
/// calls this, from an effect on the environment-mode setting.
export function setStackedViewRouter(router: StackedViewRouter | null): void {
  stackedRouter = router;
}

/// True when this window is hosting the other two as views. Reads the installed
/// router rather than the settings store so `api/` keeps no dependency on it.
export function isStackedRouting(): boolean {
  return stackedRouter !== null;
}

// ─── Opening and closing ────────────────────────────────────────────────────

/// Open the git window, or focus it if it is already open. Resolves to `true`
/// when a window was actually created.
///
/// In stacked mode there is nothing to create — this switches the workbench to
/// its git view and reports `true`, which callers read as "you are looking at it
/// now" rather than "it was already open behind something".
export async function openGitWindow(): Promise<boolean> {
  if (stackedRouter) {
    stackedRouter.showGit();
    return true;
  }
  return invoke<boolean>("open_git_window");
}

export async function closeGitWindow(): Promise<void> {
  await invoke("close_git_window");
}

export async function isGitWindowOpen(): Promise<boolean> {
  // A view is not a window: stacked mode has nothing open to report, and
  // answering `true` here would make the workbench try to close itself.
  if (stackedRouter) return false;
  return invoke<boolean>("is_git_window_open");
}

/// Open the editor window, or focus it if it is already open. Resolves to
/// `true` when a window was actually created.
export async function openEditorWindow(): Promise<boolean> {
  if (stackedRouter) {
    stackedRouter.showEditor();
    return true;
  }
  return invoke<boolean>("open_editor_window");
}

export async function closeEditorWindow(): Promise<void> {
  await invoke("close_editor_window");
}

export async function isEditorWindowOpen(): Promise<boolean> {
  if (stackedRouter) return false;
  return invoke<boolean>("is_editor_window_open");
}

// ─── Detached sidebar panels ────────────────────────────────────────────────
//
// A detached panel is a fourth root off the same bundle, not a new
// architecture: `main.tsx` picks it on the window label exactly as it picks
// `GitApp` and `EditorApp`, and it consumes the same `WindowContext` broadcast
// every other satellite does. Nothing new crosses the gap — which is why there
// is one new event here (the panel saying "I am closing, dock me back") and not
// a second channel.

/// Open the window that hosts `sidebarId` while it is detached, or focus it if
/// it is already open. Resolves to `true` when a window was actually created.
///
/// Rejects for a sidebar that has no window (see `SIDEBAR_WINDOW_LABEL`), and
/// in stacked mode, where there are no satellite windows to detach *into* — the
/// caller shows the reason rather than leaving a menu row that does nothing.
export async function openSidebarWindow(sidebarId: string): Promise<boolean> {
  const label = SIDEBAR_WINDOW_LABEL[sidebarId];
  if (!label) throw new Error(`"${sidebarId}" cannot be detached`);
  if (stackedRouter) {
    throw new Error("This environment shows the other surfaces as views, not windows");
  }
  if (label === GIT_WINDOW_LABEL) return invoke<boolean>("open_git_window");
  return invoke<boolean>("open_panel_window", { label });
}

/// Close a detached panel's window. Idempotent, and a no-op for a sidebar with
/// no window of its own.
export async function closeSidebarWindow(sidebarId: string): Promise<void> {
  const label = SIDEBAR_WINDOW_LABEL[sidebarId];
  if (!label || stackedRouter) return;
  if (label === GIT_WINDOW_LABEL) {
    await closeGitWindow();
    return;
  }
  await invoke("close_panel_window", { label });
}

/// Whether a detached panel's window is currently open. Used on boot to decide
/// whether a persisted detachment still has a window behind it.
export async function isSidebarWindowOpen(sidebarId: string): Promise<boolean> {
  const label = SIDEBAR_WINDOW_LABEL[sidebarId];
  if (!label || stackedRouter) return false;
  if (label === GIT_WINDOW_LABEL) return isGitWindowOpen();
  return invoke<boolean>("is_panel_window_open", { label });
}

const PANEL_DOCK_BACK_EVENT = "voidlink://panel-dock-back";

/// "Put me back in the shell." Emitted by a detached panel's own window as it
/// closes, so that closing the window *is* re-docking — the panel comes back at
/// the edge and width it had, because neither was ever thrown away.
///
/// Quiet, like every other broadcast here: a window on its way out cannot act
/// on a rejected emit, and the workbench reconciles on its next boot anyway.
export async function requestSidebarDockBack(sidebarId: string): Promise<void> {
  await emitQuietly(PANEL_DOCK_BACK_EVENT, sidebarId);
}

/// Subscribe to dock-back requests. Workbench side.
export function onSidebarDockBack(
  handler: (sidebarId: string) => void,
): Promise<UnlistenFn> {
  return listenLoudly<string>(PANEL_DOCK_BACK_EVENT, handler);
}

/// Bring the workbench window to the front.
export async function focusMainWindow(): Promise<void> {
  // Stacked mode: "go back to the workbench" is a view switch, and the window
  // is already in front by definition.
  if (stackedRouter) {
    stackedRouter.showWorkbench();
    return;
  }
  await invoke("focus_main_window");
}

/// Bring the editor window to the front. No-op when it isn't open.
export async function focusEditorWindow(): Promise<void> {
  if (stackedRouter) {
    stackedRouter.showEditor();
    return;
  }
  await invoke("focus_editor_window");
}

/// Make sure the editor window exists and is in front.
///
/// The workbench calls this after every action that puts a file into the
/// editor's tab list — a terminal deep-link, the file finder, a click in the
/// git sidebar. Opening already focuses a freshly-created window, so the extra
/// `focusEditorWindow` only matters for the "already open, behind us" case.
export async function showEditorWindow(): Promise<void> {
  const created = await openEditorWindow();
  if (!created) await focusEditorWindow();
}

// ─── Actions the git window hands back to the workbench ─────────────────────

const WORKTREE_WIZARD_EVENT = "voidlink://open-worktree-wizard";

/// Payload for a forwarded new-worktree request. Mirrors the fields
/// `requestNewWorktree` needs, minus the workspace id — the workbench resolves
/// that itself, since it is the one that owns the workspace list.
export interface WorktreeWizardRequest {
  repoRoot: string;
  sourcePath: string;
}

/// Ask the workbench to open the new-worktree wizard, and focus it.
///
/// Creating a worktree registers it in the layout store and spawns a terminal
/// for the post-create command. Both of those belong to `main`: the git
/// window's store is not persisted, and it has no terminal surface to attach a
/// PTY to, so running the wizard there would leak a shell nobody can see.
export async function requestWorktreeWizardOnMain(
  req: WorktreeWizardRequest,
): Promise<void> {
  await emit(WORKTREE_WIZARD_EVENT, req);
  await focusMainWindow();
}

/// Subscribe to forwarded wizard requests. Workbench side.
export function onWorktreeWizardRequest(
  handler: (req: WorktreeWizardRequest) => void,
): Promise<UnlistenFn> {
  return listenLoudly<WorktreeWizardRequest>(WORKTREE_WIZARD_EVENT, handler);
}

const OPEN_WORKTREE_EVENT = "voidlink://open-worktree";

/// Payload for "focus this worktree". The path is git's, so the workbench
/// matches it against its own list and registers it when it is one git knows
/// about but the store has not seen yet.
export interface OpenWorktreeRequest {
  path: string;
  branch: string | null;
}

/// Ask the workbench to open a worktree, and focus it.
///
/// Same reason as the wizard: the git window's store is a private, unpersisted
/// copy with no rail attached, so selecting a worktree there changed a store
/// nobody renders — the button was a **silent no-op** in that window, which is
/// the worst possible outcome for a button that looks like it works.
export async function requestOpenWorktreeOnMain(req: OpenWorktreeRequest): Promise<void> {
  await emit(OPEN_WORKTREE_EVENT, req);
  await focusMainWindow();
}

/// Subscribe to forwarded open-worktree requests. Workbench side.
export function onOpenWorktreeRequest(
  handler: (req: OpenWorktreeRequest) => void,
): Promise<UnlistenFn> {
  return listenLoudly<OpenWorktreeRequest>(OPEN_WORKTREE_EVENT, handler);
}

// ─── Context: main broadcasts, satellites consume ───────────────────────────

/// Fire-and-forget emit.
///
/// These are all broadcasts to a window that may not exist, sent from effects
/// that run during boot. A rejection here means the other window did not hear
/// something optional — never a reason to fail the caller, and never something
/// the user can act on, so it does not propagate.
///
/// It *is* logged, though. An empty catch here once hid a real bug for a whole
/// release: the editor window had no entry in `src-tauri/capabilities/`, so
/// `core:event` was denied, every emit and listen rejected, and the window sat
/// on "Waiting for the workbench…" with a silent console. The next missing
/// capability should be one glance away.
async function emitQuietly(event: string, payload?: unknown): Promise<void> {
  try {
    await emit(event, payload);
  } catch (e) {
    console.error(`[windows] emit ${event} failed in "${currentWindowLabel()}":`, e);
  }
}

/// Register a cross-window listener, logging a rejected subscription instead of
/// leaving it as an unhandled rejection. Same reasoning as `emitQuietly`: a
/// permission problem must not look like "nothing happened".
async function listenLoudly<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  try {
    return await listen<T>(event, (e) => handler(e.payload));
  } catch (e) {
    console.error(`[windows] listen ${event} failed in "${currentWindowLabel()}":`, e);
    // A no-op disposer keeps every caller's cleanup path uniform.
    return () => {};
  }
}

/// Broadcast the active repository. Called by the workbench whenever the
/// active worktree changes, and again whenever a satellite asks.
///
/// Safe to call when no satellite is open — the event simply has no listener.
export async function publishWindowContext(ctx: WindowContext): Promise<void> {
  await emitQuietly(CONTEXT_EVENT, ctx);
}

/// Subscribe to context broadcasts. Satellite side.
export function onWindowContext(
  handler: (ctx: WindowContext) => void,
): Promise<UnlistenFn> {
  return listenLoudly<WindowContext>(CONTEXT_EVENT, handler);
}

/// Ask the workbench to re-broadcast the current context.
///
/// A satellite emits this on mount because it may have opened *after* the last
/// context change, in which case it missed the broadcast and would otherwise
/// sit empty until the user switched worktrees.
export async function requestWindowContext(): Promise<void> {
  await emitQuietly(CONTEXT_REQUEST_EVENT);
}

/// Subscribe to context requests. Workbench side.
export function onWindowContextRequest(handler: () => void): Promise<UnlistenFn> {
  return listenLoudly(CONTEXT_REQUEST_EVENT, () => handler());
}

// ─── Refs changed: either direction ─────────────────────────────────────────

interface RefsPayload {
  /// Window label that produced the change. Used to drop our own echo —
  /// Tauri delivers an emitted event to every window including the sender,
  /// and re-handling it here would loop straight back out through
  /// `bridgeLocalRefsChanges`.
  source: string;
}

/// Tell the other window that refs moved.
export async function publishGitRefsChanged(): Promise<void> {
  await emitQuietly(REFS_EVENT, { source: currentWindowLabel() } satisfies RefsPayload);
}

/// Turn cross-window ref pings into the in-process pulse every pane already
/// listens to, and vice versa. Returns a disposer.
///
/// Call once per window, at the root. The `source` guard is what stops the
/// windows from ping-ponging a single commit forever.
export function bridgeGitRefsAcrossWindows(): () => void {
  const self = currentWindowLabel();
  let disposed = false;
  let unlisten: UnlistenFn | null = null;

  // Remote → local. The local pulse is *marked* remote rather than guarded by a
  // latch: pulses are coalesced now, so the DOM event fires after any latch we
  // could hold here has been released — and a re-published remote pulse
  // ping-pongs between the windows forever.
  void listenLoudly<RefsPayload>(REFS_EVENT, (payload) => {
    if (payload?.source === self) return;
    emitRemoteGitRefsChanged();
  }).then((fn) => {
    if (disposed) void fn();
    else unlisten = fn;
  });

  // The filesystem watcher → local. Rust broadcasts to *every* window, so each
  // one hears this directly and there is nothing to re-publish.
  //
  // Marked remote for exactly that reason: publishing it would send a pulse to
  // windows that already got the same news straight from Rust, and the
  // `remote` flag is what stops that second lap.
  let unlistenWatch: UnlistenFn | null = null;
  void listenLoudly<string>(GIT_CHANGED_EVENT, () => {
    emitRemoteGitRefsChanged();
  }).then((fn) => {
    if (disposed) void fn();
    else unlistenWatch = fn;
  });

  // Local → remote. Anything that originated here is published; anything that
  // arrived from another window is not.
  const offLocal = onGitRefsChanged((pulse) => {
    if (pulse.remote) return;
    void publishGitRefsChanged();
  });

  return () => {
    disposed = true;
    offLocal();
    if (unlisten) void unlisten();
    if (unlistenWatch) void unlistenWatch();
  };
}

// ─── Preferences: any window may write, every window follows ─────────────────
//
// Theme and blame-enabled are not owned by `main` the way tab state is: they
// live in `localStorage`, the workbench happens to be the only window with a
// picker today, and a satellite toggling blame off its own keymap has to be
// just as authoritative. So these are symmetric broadcasts rather than the
// one-writer/one-reader shape above, and the payload carries `source` for the
// same reason `RefsPayload` does — Tauri delivers an emit back to the sender,
// and re-applying our own echo would put the value through a second time.

interface SourcedPayload<T> {
  source: string;
  value: T;
}

/// Broadcast a value every window mirrors. See `onSourced` for the pairing.
async function publishSourced<T>(event: string, value: T): Promise<void> {
  await emitQuietly(event, { source: currentWindowLabel(), value } satisfies SourcedPayload<T>);
}

/// Subscribe to a symmetric broadcast, dropping our own echo.
///
/// Handlers must apply the value *without* re-publishing it. Even with the echo
/// dropped, a handler that re-broadcasts turns two windows into a ping-pong: A
/// publishes, B applies and publishes, A applies and publishes… The `source`
/// guard only removes the self-hop, not that cycle, so the no-republish rule is
/// on the handler and each one below states it.
function onSourced<T>(event: string, handler: (value: T) => void): Promise<UnlistenFn> {
  const self = currentWindowLabel();
  return listenLoudly<SourcedPayload<T>>(event, (payload) => {
    if (!payload || payload.source === self) return;
    handler(payload.value);
  });
}

const THEME_EVENT = "voidlink://theme-changed";
const BLAME_EVENT = "voidlink://blame-enabled";

/// Tell every other window which theme is now active.
///
/// Called from `applyTheme` in `store/theme.ts` — the single mutation point for
/// the `<html>` class and `data-theme` attribute, and therefore the only place
/// that knows a theme change happened at all.
export async function publishThemeChange(themeId: string): Promise<void> {
  await publishSourced(THEME_EVENT, themeId);
}

/// Subscribe to theme broadcasts. The handler must apply the theme without
/// re-publishing it (see `onSourced`).
export function onThemeChange(handler: (themeId: string) => void): Promise<UnlistenFn> {
  return onSourced<string>(THEME_EVENT, handler);
}

/// Tell every other window whether inline blame is on.
export async function publishBlameEnabled(enabled: boolean): Promise<void> {
  await publishSourced(BLAME_EVENT, enabled);
}

/// Subscribe to blame-enabled broadcasts. Same no-republish rule.
export function onBlameEnabled(handler: (enabled: boolean) => void): Promise<UnlistenFn> {
  return onSourced<boolean>(BLAME_EVENT, handler);
}

const UI_VISUAL_EVENT = "voidlink://ui-visual-changed";

/// The background image, its opacity mix and its fit mode — one payload
/// because they are set together from Settings → UI and there is no useful
/// state in which one arrives without the other two. Typed here rather than
/// imported from `store/settings.ts`: this module defines its own payload
/// shapes for every channel above, and `store/settings.ts` is the one that
/// depends on this file, not the other way round.
export interface UiVisualSettings {
  backgroundImage: string | null;
  surfaceOpacity: number;
  backgroundFit: "cover" | "contain" | "tile";
}

/// Tell every other window the background/opacity/fit changed. Symmetric like
/// the theme and blame channels above — any window may open Settings → UI —
/// and for the same reason: these live in `localStorage` (`voidlink-settings`)
/// and each window's store hydrates once at module eval, so nothing but a
/// broadcast reaches an already-open satellite.
export async function publishUiVisualChange(value: UiVisualSettings): Promise<void> {
  await publishSourced(UI_VISUAL_EVENT, value);
}

/// Subscribe to background/opacity/fit broadcasts. Same no-republish rule as
/// `onThemeChange` / `onBlameEnabled`.
export function onUiVisualChange(
  handler: (value: UiVisualSettings) => void,
): Promise<UnlistenFn> {
  return onSourced<UiVisualSettings>(UI_VISUAL_EVENT, handler);
}

// ─── Editor tabs: main owns them, the editor window renders them ─────────────
//
// The editor window is the *view* over four tab collections that live in the
// workbench's store (`openFilesByWorktree`, `diffTabsByWorktree`,
// `conflictTabsByWorktree`, `previewTabsByWorktree`). It is deliberately not a
// second writer: two windows persisting the same localStorage keys would race,
// and the last writer would silently clobber the other's tabs. So the flow is
// one-directional in each direction —
//
//   main   → editor:  the whole tab slice, as a snapshot, on every change
//   editor → main:    "please open / close / activate / reorder / pin this"
//
// which means there is exactly one copy of the truth and no merge to get wrong.
// Everything Monaco owns (models, dirty flags, cursor, scroll, folding) stays
// local to the editor window and never crosses.

/// The tab kinds the editor window renders. `main` keeps terminals, compares,
/// stacks, the commit graph, brain and browser tabs.
export type EditorTabKind = "file" | "diff" | "conflict" | "preview";

/// Only three of the four collections are reorderable — conflict tabs have no
/// list in `reorderItemTab`, and a merge in progress is not something you sort.
export type EditorReorderableKind = Exclude<EditorTabKind, "conflict">;

/// A "jump to this line" ping riding along with the snapshot.
export interface EditorReveal {
  path: string;
  line?: number;
  column?: number;
  /// Monotonic counter, assigned by the workbench. The editor window applies a
  /// reveal only when the seq is new: the same snapshot gets re-sent whenever a
  /// freshly-opened window asks for one, and without this the cursor would be
  /// yanked back to the last deep-link on every rebroadcast.
  seq: number;
}

/// Everything the editor window needs to render its tab strip.
export interface EditorTabsSnapshot {
  worktreeId: string;
  repoPath: string | null;
  files: OpenFileTab[];
  diffs: DiffTab[];
  conflicts: ConflictTab[];
  previews: PreviewTab[];
  /// Pinned tab ids for this worktree — the same flat list the workbench keeps,
  /// filtered to nothing in particular because ids are unique across kinds.
  pinned: string[];
  /// Which editor tab is in front. Tracked separately from the workbench's own
  /// `activeItem` so the two windows can focus independently: clicking a file
  /// here must not blank out the terminal the user is watching there.
  active: ActiveItem | null;
  reveal: EditorReveal | null;
}

/// A mutation the editor window asks the workbench to perform. Fire-and-forget:
/// the workbench applies it, persists, and rebroadcasts the snapshot, which is
/// what actually updates the editor window's UI.
export type EditorRequest =
  | { kind: "open-file"; path: string }
  // `staged` picks the side of the index — `git diff --cached` vs `git diff`.
  // Optional so a request serialized by an older window still applies; absent
  // means the unstaged view, which is the only one that used to exist.
  | { kind: "open-diff"; filePath: string; staged?: boolean }
  | { kind: "open-conflict"; filePath: string }
  | { kind: "open-preview"; filePath: string }
  | { kind: "close"; tab: EditorTabKind; id: string }
  | { kind: "activate"; tab: EditorTabKind; id: string }
  | { kind: "reorder"; tab: EditorReorderableKind; fromId: string; toId: string | null }
  | { kind: "toggle-pin"; id: string }
  /// Compare is a workbench surface; the editor's file tree can still start one
  /// (its right-click menu offers "Compare with <trunk>"), it just lands over
  /// there. The sender focuses `main` itself so the tab isn't opened offscreen.
  | {
      kind: "open-compare";
      baseRef: string;
      headRef: string;
      useMergeBase: boolean;
      selectedFilePath: string | null;
    };

const EDITOR_TABS_EVENT = "voidlink://editor-tabs";
const EDITOR_TABS_REQUEST_EVENT = "voidlink://editor-tabs-request";
const EDITOR_REQUEST_EVENT = "voidlink://editor-request";

/// Broadcast the editor tab slice. Workbench side; safe when the editor window
/// is closed.
export async function publishEditorTabs(snapshot: EditorTabsSnapshot): Promise<void> {
  await emitQuietly(EDITOR_TABS_EVENT, snapshot);
}

/// Subscribe to tab-slice broadcasts. Editor-window side.
export function onEditorTabs(
  handler: (snapshot: EditorTabsSnapshot) => void,
): Promise<UnlistenFn> {
  return listenLoudly<EditorTabsSnapshot>(EDITOR_TABS_EVENT, handler);
}

/// Ask the workbench to re-broadcast the tab slice. Same late-join problem the
/// context request solves: an editor window that opened after the last change
/// would otherwise render an empty strip until the next one.
export async function requestEditorTabs(): Promise<void> {
  await emitQuietly(EDITOR_TABS_REQUEST_EVENT);
}

/// Subscribe to tab-slice requests. Workbench side.
export function onEditorTabsRequest(handler: () => void): Promise<UnlistenFn> {
  return listenLoudly(EDITOR_TABS_REQUEST_EVENT, () => handler());
}

/// Send a tab mutation to the workbench. Editor-window side.
///
/// Deliberately does not focus `main`: these fire on every tab click, and
/// stealing the front window out from under someone editing code would make the
/// editor unusable. The one request that needs focus (`open-compare`) is
/// followed by an explicit `focusMainWindow()` at its call site.
export async function sendEditorRequest(req: EditorRequest): Promise<void> {
  await emitQuietly(EDITOR_REQUEST_EVENT, req);
}

/// Subscribe to tab mutations from the editor window. Workbench side.
export function onEditorRequest(
  handler: (req: EditorRequest) => void,
): Promise<UnlistenFn> {
  return listenLoudly<EditorRequest>(EDITOR_REQUEST_EVENT, handler);
}

/// Put a tab in the editor window and bring it forward, from any window.
///
/// The workbench owns the tab list, so there it applies the change directly;
/// anywhere else the same intent has to travel as a request, because that
/// window's store is a read-only mirror and writing to it would produce a tab
/// nobody ever renders. Callers pass both halves and this picks the right one.
export async function openEditorTab(
  req: EditorRequest,
  applyInWorkbench: () => void,
): Promise<void> {
  if (isMainWindow()) applyInWorkbench();
  else await sendEditorRequest(req);
  await showEditorWindow();
}

// ── The agent board ─────────────────────────────────────────────────────────

const AGENT_BOARD_EVENT = "voidlink://agent-board";
const AGENT_BOARD_REQUEST_EVENT = "voidlink://agent-board-request";

/// The agent dashboard's whole state, as one value.
///
/// Same one-directional model as the editor tab list, and for the same reason:
/// only the workbench can see every worktree's terminals and only the workbench
/// runs the PTY poll that derives their signals, so it is the sole writer. A
/// satellite renders what it is handed and asks for a fresh copy when it mounts.
///
/// It is a *snapshot of sessions*, not of columns. The column derivation lives
/// in `components/agent/agentBoard.ts` and the receiving window runs it itself,
/// against its own clock — which is what keeps the thirty-minute idle threshold
/// from freezing at whatever it was when the last snapshot happened to be sent.
///
/// There is deliberately no request channel back. The dashboard is
/// read-and-navigate: the one mutation it offers is "focus this agent's tab",
/// and that is a `focusMainWindow` plus a selection the workbench already
/// exposes — not a new kind of write. A second, bidirectional channel would be
/// two writers for one board.
export interface AgentBoardSnapshot {
  /// Every terminal session in every worktree of the active workspace, agent
  /// or not. The receiver filters; see `buildAgentBoard`.
  sessions: AgentSession[];
  /// `experimental.showIdleAgents`, carried with the data so a satellite does
  /// not need its own copy of a setting the workbench owns.
  showIdle: boolean;
}

/// Publish the board. Workbench side, on every change.
export async function publishAgentBoard(snapshot: AgentBoardSnapshot): Promise<void> {
  await emitQuietly(AGENT_BOARD_EVENT, snapshot);
}

/// Subscribe to the board. Satellite side.
export function onAgentBoard(
  handler: (snapshot: AgentBoardSnapshot) => void,
): Promise<UnlistenFn> {
  return listenLoudly<AgentBoardSnapshot>(AGENT_BOARD_EVENT, handler);
}

/// Ask for a fresh snapshot. Satellite side, once both subscriptions are live —
/// see `EditorApp` for why asking before `listen` resolves races the reply.
export async function requestAgentBoard(): Promise<void> {
  await emitQuietly(AGENT_BOARD_REQUEST_EVENT);
}

/// A satellite joined late and wants the board. Workbench side.
export function onAgentBoardRequest(handler: () => void): Promise<UnlistenFn> {
  return listenLoudly(AGENT_BOARD_REQUEST_EVENT, () => handler());
}
