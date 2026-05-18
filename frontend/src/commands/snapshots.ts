import { createSignal } from "solid-js";
import type { CompareTreeMode, DiffMode, GitTab, SidebarTab } from "@/store/layout";

/// Persistent serializable view of everything a user might want to
/// restore later: which tabs were open, which one was active, which
/// were pinned, and the surrounding UI state. We capture by content
/// (paths, refs, branch names) — not by tab id — so a restore on a
/// later session still finds the right slots.
export interface WorkspaceSnapshot {
  name: string;
  savedAt: number;
  files: string[];
  terminals: { label: string; cwd: string }[];
  diffs: string[];
  compares: Array<{
    baseRef: string;
    headRef: string;
    useMergeBase: boolean;
    selectedFilePath: string | null;
    treeMode: CompareTreeMode;
    treeFilter: string;
  }>;
  stacks: Array<{ trunk: string; topBranch: string }>;
  /// Content key of the active item, format "kind:identifier". Identifiers:
  /// file → absolute path, terminal → index, diff → filePath, compare →
  /// baseRef..headRef, stack → topBranch.
  active: string | null;
  /// Content keys of pinned tabs (same format as active).
  pinned: string[];
  ui: {
    gitSidebarCollapsed: boolean;
    leftSidebarCollapsed: boolean;
    sidebarsSwapped: boolean;
    diffMode: DiffMode;
    gitTab: GitTab;
    ignoreWhitespace: boolean;
    sidebarTab: SidebarTab;
  };
}

type AllSnapshots = Record<string, WorkspaceSnapshot[]>;

const KEY = "voidlink-snapshots";

function load(): AllSnapshots {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as AllSnapshots;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

const [all, setAll] = createSignal<AllSnapshots>(load());

function persist() {
  localStorage.setItem(KEY, JSON.stringify(all()));
}

export function allSnapshots() {
  return all();
}

export function snapshotsFor(wsId: string): WorkspaceSnapshot[] {
  return all()[wsId] ?? [];
}

/// Upsert by `name` so re-saving with the same name overwrites cleanly
/// (matches the principle of least surprise — users expect re-save to
/// update, not duplicate).
export function upsertSnapshot(wsId: string, snap: WorkspaceSnapshot) {
  setAll((cur) => {
    const list = (cur[wsId] ?? []).filter((s) => s.name !== snap.name);
    list.push(snap);
    list.sort((a, b) => b.savedAt - a.savedAt);
    return { ...cur, [wsId]: list };
  });
  persist();
}

export function removeSnapshot(wsId: string, name: string) {
  setAll((cur) => {
    const list = (cur[wsId] ?? []).filter((s) => s.name !== name);
    return { ...cur, [wsId]: list };
  });
  persist();
}
