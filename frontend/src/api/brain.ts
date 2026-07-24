import { invoke } from "@tauri-apps/api/core";
import type { BrainEntry, BrainEntryDetail } from "@/types/brain";

export const brainApi = {
  listEntries(vaultPath: string): Promise<BrainEntry[]> {
    return invoke<BrainEntry[]>("brain_list_entries", { vaultPath });
  },

  readEntry(vaultPath: string, relPath: string): Promise<BrainEntryDetail> {
    return invoke<BrainEntryDetail>("brain_read_entry", { vaultPath, relPath });
  },

  saveEntry(
    vaultPath: string,
    relPath: string,
    content: string,
    message: string,
  ): Promise<string> {
    return invoke<string>("brain_save_entry", { vaultPath, relPath, content, message });
  },
};
