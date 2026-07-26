/// The bridge between the workbench window and the standalone git window.
///
/// The two windows are separate webviews, so they are separate JS contexts:
/// separate Solid stores, separate module state, no shared reactivity. Rather
/// than try to mirror the whole layout store across the gap, only two things
/// actually cross it:
///
///   1. **Which repository is active.** `main` owns that decision (it has the
///      rail and the worktree switcher) and broadcasts it. The git window is a
///      pure consumer — it never picks a repo, so the two can never disagree.
///   2. **"Refs changed."** Either side can commit, fetch, or rebase, and the
///      other has to refetch. This re-broadcasts the in-process
///      `voidlink:refresh-git` pulse across windows.
///
/// Everything else the git window shows it reads straight from the Rust git
/// commands, which are stateless and window-agnostic — so there is nothing
/// else to synchronise.

import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emitGitRefsChanged } from "@/commands/gitEvents";

/// Window label used by the git client. Must match `GIT_WINDOW_LABEL` in
/// `src-tauri/src/window.rs`.
export const GIT_WINDOW_LABEL = "git";

const CONTEXT_EVENT = "voidlink://git-context";
const CONTEXT_REQUEST_EVENT = "voidlink://git-context-request";
const REFS_EVENT = "voidlink://git-refs-changed";

/// The slice of workbench state the git window needs to do its job.
export interface GitWindowContext {
  /// Working directory of the active worktree — what every git command is run
  /// against. `null` when no repository is open in the workbench.
  repoPath: string | null;
  /// Layout-store id of the active worktree. Echoed back on refresh pings so
  /// the workbench knows which panes to invalidate.
  worktreeId: string;
  branch: string | null;
  /// Human labels for the git window's header, so it can say *which* repo it
  /// is showing without duplicating the rail.
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
    return "main";
  }
}

export function isGitWindow(): boolean {
  return currentWindowLabel() === GIT_WINDOW_LABEL;
}

// ─── Opening and closing ────────────────────────────────────────────────────

/// Open the git window, or focus it if it is already open. Resolves to `true`
/// when a window was actually created.
export async function openGitWindow(): Promise<boolean> {
  return invoke<boolean>("open_git_window");
}

export async function closeGitWindow(): Promise<void> {
  await invoke("close_git_window");
}

export async function isGitWindowOpen(): Promise<boolean> {
  return invoke<boolean>("is_git_window_open");
}

/// Bring the workbench window to the front.
export async function focusMainWindow(): Promise<void> {
  await invoke("focus_main_window");
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
  return listen<WorktreeWizardRequest>(WORKTREE_WIZARD_EVENT, (e) =>
    handler(e.payload),
  );
}

// ─── Context: main broadcasts, git window consumes ──────────────────────────

/// Fire-and-forget emit.
///
/// These are all broadcasts to a window that may not exist, sent from effects
/// that run during boot. A rejection here means the other window did not hear
/// something optional — never a reason to fail the caller, and never something
/// the user can act on, so it is swallowed rather than left to surface as an
/// unhandled rejection.
async function emitQuietly(event: string, payload?: unknown): Promise<void> {
  try {
    await emit(event, payload);
  } catch {
    /* no listener, or Tauri not ready yet */
  }
}

/// Broadcast the active repository. Called by the workbench whenever the
/// active worktree changes, and again whenever the git window asks.
///
/// Safe to call when the git window is closed — the event simply has no
/// listener.
export async function publishGitContext(ctx: GitWindowContext): Promise<void> {
  await emitQuietly(CONTEXT_EVENT, ctx);
}

/// Subscribe to context broadcasts. Git-window side.
export function onGitContext(
  handler: (ctx: GitWindowContext) => void,
): Promise<UnlistenFn> {
  return listen<GitWindowContext>(CONTEXT_EVENT, (e) => handler(e.payload));
}

/// Ask the workbench to re-broadcast the current context.
///
/// The git window emits this on mount because it may have opened *after* the
/// last context change, in which case it missed the broadcast and would
/// otherwise sit empty until the user switched worktrees.
export async function requestGitContext(): Promise<void> {
  await emitQuietly(CONTEXT_REQUEST_EVENT);
}

/// Subscribe to context requests. Workbench side.
export function onGitContextRequest(handler: () => void): Promise<UnlistenFn> {
  return listen(CONTEXT_REQUEST_EVENT, () => handler());
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
/// two windows from ping-ponging a single commit forever.
export function bridgeGitRefsAcrossWindows(): () => void {
  const self = currentWindowLabel();
  let disposed = false;
  let unlisten: UnlistenFn | null = null;

  // Remote → local. `emitGitRefsChanged` dispatches a DOM event, which our own
  // `bridgeLocalRefsChanges` listener below would re-publish; the `echoing`
  // latch suppresses exactly that one hop.
  let echoing = false;
  void listen<RefsPayload>(REFS_EVENT, (e) => {
    if (e.payload?.source === self) return;
    echoing = true;
    try {
      emitGitRefsChanged();
    } finally {
      echoing = false;
    }
  }).then((fn) => {
    if (disposed) void fn();
    else unlisten = fn;
  });

  // Local → remote.
  const onLocal = () => {
    if (echoing) return;
    void publishGitRefsChanged();
  };
  window.addEventListener("voidlink:refresh-git", onLocal);

  return () => {
    disposed = true;
    window.removeEventListener("voidlink:refresh-git", onLocal);
    if (unlisten) void unlisten();
  };
}
