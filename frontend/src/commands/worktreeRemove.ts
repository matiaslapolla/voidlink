/// Removing a worktree, once, for all three places that offer it.
///
/// It was implemented three times — the sidebar's worktrees pane, the workspace
/// rail, and the command palette — and only the sidebar's version was right.
/// The rail offered force-remove on *any* failure, so a lock or a permissions
/// error routed the user to a button whose entire job is discarding changes.
/// The palette's entry deleted a directory with **no confirmation at all**,
/// despite its label ending in the `…` that promises one. Neither emitted a
/// refresh pulse, so every other surface kept listing the worktree until some
/// unrelated git action happened to fire one.
///
/// Those are not three bugs to fix in three files; they are one flow that
/// should only exist once.
import { confirm as dialogConfirm } from "@tauri-apps/plugin-dialog";
import { gitApi } from "@/api/git";
import { emitGitRefsChanged } from "@/commands/gitEvents";
import { pushToast } from "@/commands/toast";

/// Does this failure mean "there is uncommitted work here", the one thing
/// `--force` actually answers?
///
/// `git worktree remove` refuses for several unrelated reasons and `--force`
/// only overrides one of them, so the classification decides whether offering
/// force is help or a trap.
export function isDirtyRefusal(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("contains modified or untracked files") ||
    m.includes("is dirty") ||
    m.includes("use --force") ||
    // Not `use 'remove -f'` with the closing quote: git writes
    // `use 'remove -f -f'` for a locked worktree and `use 'remove -f'` for a
    // dirty one, and matching the quote meant the locked wording never
    // matched at all.
    m.includes("use 'remove -f")
  );
}

/// Is this git refusing because the worktree is locked?
///
/// Distinct from dirty because the answer is different: a lock is not
/// discarded by `--force`, it is cleared by `git worktree unlock`. Sending
/// force at a lock fails a second time and tells the user nothing new.
export function isLockRefusal(message: string): boolean {
  return message.toLowerCase().includes("is locked");
}

export interface RemoveWorktreeRequest {
  repoRoot: string;
  path: string;
  /// What to call it in the confirm and the toasts.
  label: string;
}

/// Confirm, remove, and pulse. Returns true only when the worktree is actually
/// gone, so a caller can update its own store on that basis and not otherwise.
///
/// Every exit emits `emitGitRefsChanged()`, including the failures: the other
/// surfaces need to re-read either way, and a removal that failed halfway
/// (git removed the directory, the prune did not run) leaves state they should
/// see.
export async function removeWorktreeWithConfirm(
  req: RemoveWorktreeRequest,
): Promise<boolean> {
  const ok = await dialogConfirm(
    `Remove worktree "${req.label}"? Its directory will be deleted.`,
    { title: "Remove worktree", kind: "warning" },
  );
  if (!ok) return false;

  try {
    const warning = await gitApi.removeWorktree(req.repoRoot, req.path, false);
    pushToast(`Removed worktree ${req.label}`, "info", 2500);
    // A prune that failed after a removal that succeeded. Two of the three
    // call sites used to drop this on the floor, leaving stale admin entries
    // nobody was told about.
    if (warning) pushToast(warning, "warning", 6000);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);

    if (isLockRefusal(msg)) {
      const unlock = await dialogConfirm(
        `${msg}\n\nUnlock it and remove it anyway?`,
        { title: "Worktree is locked", kind: "warning" },
      );
      if (!unlock) return false;
      try {
        await gitApi.unlockWorktree(req.repoRoot, req.path);
      } catch (e2) {
        pushToast(
          `Could not unlock: ${e2 instanceof Error ? e2.message : String(e2)}`,
          "error",
          6000,
        );
        return false;
      }
      // Unlocked, but the worktree may also be dirty — re-enter rather than
      // assuming the second attempt succeeds.
      return removeAfterUnlock(req);
    }

    if (!isDirtyRefusal(msg)) {
      pushToast(msg, "error", 7000);
      return false;
    }

    const force = await dialogConfirm(
      `${msg}\n\nForce-remove anyway (discards uncommitted changes in that worktree)?`,
      { title: "Force-remove worktree", kind: "warning" },
    );
    if (!force) return false;
    return forceRemove(req);
  } finally {
    emitGitRefsChanged();
  }
}

async function removeAfterUnlock(req: RemoveWorktreeRequest): Promise<boolean> {
  try {
    const warning = await gitApi.removeWorktree(req.repoRoot, req.path, false);
    pushToast(`Removed worktree ${req.label}`, "info", 2500);
    if (warning) pushToast(warning, "warning", 6000);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!isDirtyRefusal(msg)) {
      pushToast(msg, "error", 7000);
      return false;
    }
    const force = await dialogConfirm(
      `${msg}\n\nForce-remove anyway (discards uncommitted changes in that worktree)?`,
      { title: "Force-remove worktree", kind: "warning" },
    );
    if (!force) return false;
    return forceRemove(req);
  }
}

async function forceRemove(req: RemoveWorktreeRequest): Promise<boolean> {
  try {
    const warning = await gitApi.removeWorktree(req.repoRoot, req.path, true);
    pushToast(`Removed worktree ${req.label}`, "info", 2500);
    if (warning) pushToast(warning, "warning", 6000);
    return true;
  } catch (e) {
    pushToast(e instanceof Error ? e.message : String(e), "error", 6000);
    return false;
  }
}
