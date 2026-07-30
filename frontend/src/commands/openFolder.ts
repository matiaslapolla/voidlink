/// The one folder pick, shared by everything that can re-point a workspace.
///
/// Two surfaces open a folder: the workspace rail (per workspace, from the
/// header row) and the files sidebar's header (the active workspace). They used
/// to be one surface, so the upward `.git` walk and the toast that explains it
/// lived inline in `TerminalSidebar`. Duplicating that into the rail would have
/// given the two buttons different repo-root behaviour for the same gesture,
/// which is the kind of divergence nobody notices until a subdirectory pick
/// works in one place and not the other.
import { open } from "@tauri-apps/plugin-dialog";
import { fsApi } from "@/api/fs";
import { pushToast } from "@/commands/toast";

/// Ask the OS for a folder to open, resolved to the repository root that
/// contains it.
///
/// Returns `null` when the user cancels — callers must treat that as "keep the
/// current root", never as "clear it". A folder that is not inside a repository
/// comes back exactly as picked; opening a plain directory is supported (you
/// get no worktrees and no git content, see `docs/features/workspaces-and-tabs.md`).
export async function pickWorkspaceFolder(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false, title: "Open folder" });
  if (!selected || Array.isArray(selected)) return null;
  // Walk upward for a .git so picking any subdir of a repo Just Works.
  // If the picked dir already is the root, we still get back the same path.
  try {
    const detected = await fsApi.findRepoRoot(selected);
    if (detected && detected !== selected) {
      pushToast(
        `Using repo root: ${detected.split("/").pop()} (detected from selected folder)`,
        "info",
      );
      return detected;
    }
  } catch {
    // Detection failure is non-fatal — fall through and use the raw pick.
  }
  return selected;
}
