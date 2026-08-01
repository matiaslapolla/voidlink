import { invoke } from "@tauri-apps/api/core";
import type { BrainEntry, BrainEntryDetail } from "@/types/brain";

/// The project brain: entries under `<repoRoot>/.voidlink/brain`. Every call is
/// scoped by repo root rather than by a configured path — a brain belongs to
/// the project you have open, and there is nothing global to point at.
export const brainApi = {
  listEntries(repoPath: string): Promise<BrainEntry[]> {
    return invoke<BrainEntry[]>("brain_list_entries", { repoRoot: repoPath });
  },

  readEntry(repoPath: string, relPath: string): Promise<BrainEntryDetail> {
    return invoke<BrainEntryDetail>("brain_read_entry", { repoRoot: repoPath, relPath });
  },

  /// Write an entry and stop. Returns the repo-relative path written; there is
  /// no commit, deliberately — see `brain_save_entry`.
  saveEntry(repoPath: string, relPath: string, content: string): Promise<string> {
    return invoke<string>("brain_save_entry", { repoRoot: repoPath, relPath, content });
  },
};
