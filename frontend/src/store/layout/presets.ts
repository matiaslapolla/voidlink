/// Named layout presets: an *arrangement*, recalled by name.
///
/// ## What this is not
///
/// `commands/snapshots.ts` restores a whole **session** — it closes every tab,
/// reopens the ones it recorded by content key, respawns terminals and restores
/// the sidebar prefs. It is addressed by content because a restore mints fresh
/// tab ids.
///
/// A preset is the other half of that space and shares none of its machinery. It
/// carries the pane tree, the tab-group structure, each pane group's front tab
/// and the three panel widths — and **no tab contents at all**. Applying one is
/// cheap and non-destructive: nothing opens, nothing closes, nothing spawns. It
/// rearranges whatever happens to be open right now.
///
/// That is also why references here are plain tab ids rather than content keys.
/// A preset is applied to a live tab set, and a tab id is exactly the right
/// handle for "the terminal that is open in front of me". Ids the target
/// worktree does not have simply do not place — see `applyLayoutPreset`.
///
/// ## Degrading, never failing
///
/// Applying a preset whose groups name tabs that are not open places what
/// exists and leaves the rest of the geometry empty, where the pane's existing
/// `groupNoTabs` empty state already says what to do about it. There is no
/// failure path: an arrangement that half-fits is still an arrangement.
///
/// Presets are stored per workspace and applied to the active worktree. Reads
/// and writes go through `persistence.ts` like every other layout key.
import { createSignal } from "solid-js";
import {
  parsePaneLayout,
  resolveGroupTabs,
  serializePaneLayout,
  singleGroupLayout,
  type PaneNode,
} from "./panes";
import {
  emptyTabGroupState,
  parseTabGroupState,
  pruneTabGroups,
  serializeTabGroupState,
  type TabGroupState,
} from "./tabGroups";
import { PANEL_BOUNDS, clampPanelWidth, type PanelWidths } from "./prefs";
import { STORAGE_KEYS, readJson, writeJson } from "./persistence";

export const PRESET_VERSION = 1;

export interface LayoutPreset {
  version: number;
  name: string;
  savedAt: number;
  /// The serialized pane tree. Each pane group's front tab rides inside it as
  /// `activeTabId` — the tree already carries that field, and a second copy
  /// beside it would be one more thing that can disagree.
  panes: unknown;
  /// The serialized tab-group structure (`TabGroupState`).
  tabGroups: unknown;
  /// The shell's three resizable columns.
  panels: PanelWidths;
}

/// Capture the current arrangement under `name`.
export function captureLayoutPreset(
  name: string,
  layout: PaneNode,
  tabGroups: TabGroupState,
  panels: PanelWidths,
): LayoutPreset | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  return {
    version: PRESET_VERSION,
    name: trimmed,
    savedAt: Date.now(),
    panes: serializePaneLayout(layout),
    tabGroups: serializeTabGroupState(tabGroups),
    panels: { ...panels },
  };
}

/// What applying `preset` to a worktree holding `openTabIds` produces.
///
/// Pure, and total: a corrupt pane tree falls back to the single-group default
/// rather than throwing, and every reference to a tab that is not open is
/// dropped on the way through `mapPaneTabIds` / `pruneTabGroups`.
export function applyLayoutPreset(
  preset: LayoutPreset,
  openTabIds: readonly string[],
): { layout: PaneNode; tabGroups: TabGroupState; panels: PanelWidths } {
  const open = new Set(openTabIds);
  const parsed = parsePaneLayout(preset.panes);
  const layout = parsed ? restrictToOpen(parsed, open) : singleGroupLayout();
  const stored = parseTabGroupState(preset.tabGroups) ?? emptyTabGroupState();
  const tabGroups = pruneTabGroups(stored, resolveGroupTabs(layout, [...openTabIds]));
  return { layout, tabGroups, panels: parsePanels(preset.panels) };
}

/// Drop every reference to a tab that is not open, keeping the geometry.
///
/// Deliberately *not* `mapPaneTabIds`: that one drops a group's `activeTabId`
/// unless the group has an explicit claim on it, which is right for a snapshot
/// (every tab is claimed there) and wrong here — the first pane group's claim
/// list is empty by design, and honouring that rule would blank the front tab
/// of the one pane that matters most.
function restrictToOpen(node: PaneNode, open: ReadonlySet<string>): PaneNode {
  if (node.kind === "group") {
    const active = node.group.activeTabId;
    return {
      kind: "group",
      id: node.id,
      group: {
        id: node.group.id,
        tabIds: node.group.tabIds.filter((id) => open.has(id)),
        activeTabId: active && open.has(active) ? active : null,
      },
    };
  }
  return {
    kind: "split",
    id: node.id,
    orientation: node.orientation,
    ratios: [...node.ratios],
    children: node.children.map((child) => restrictToOpen(child, open)),
  };
}

function parsePanels(raw: unknown): PanelWidths {
  const r = (raw ?? {}) as Partial<PanelWidths>;
  return {
    rail: clampPanelWidth("rail", r.rail ?? PANEL_BOUNDS.rail.default),
    sidebar: clampPanelWidth("sidebar", r.sidebar ?? PANEL_BOUNDS.sidebar.default),
    gitSidebar: clampPanelWidth("gitSidebar", r.gitSidebar ?? PANEL_BOUNDS.gitSidebar.default),
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/// Rebuild one preset from disk, or reject it. A preset too broken to name is
/// dropped rather than resurrected as `"undefined"`.
export function parsePreset(raw: unknown): LayoutPreset | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.name !== "string" || raw.name.length === 0) return null;
  return {
    version: PRESET_VERSION,
    name: raw.name,
    savedAt: typeof raw.savedAt === "number" ? raw.savedAt : 0,
    panes: raw.panes ?? null,
    tabGroups: raw.tabGroups ?? null,
    panels: parsePanels(raw.panels),
  };
}

// ── Storage ───────────────────────────────────────────────────────────────

type AllPresets = Record<string, LayoutPreset[]>;

function load(): AllPresets {
  const parsed = readJson<Record<string, unknown> | null>(STORAGE_KEYS.layoutPresets, null);
  if (!parsed || typeof parsed !== "object") return {};
  const out: AllPresets = {};
  for (const [wsId, list] of Object.entries(parsed)) {
    if (!Array.isArray(list)) continue;
    const kept = list
      .map((entry) => parsePreset(entry))
      .filter((p): p is LayoutPreset => p !== null);
    if (kept.length > 0) out[wsId] = kept;
  }
  return out;
}

const [all, setAll] = createSignal<AllPresets>(load());

function persist() {
  writeJson(STORAGE_KEYS.layoutPresets, all());
}

export function allPresets(): AllPresets {
  return all();
}

export function presetsFor(wsId: string): LayoutPreset[] {
  return all()[wsId] ?? [];
}

/// Upsert by name, so re-saving under a name the user already used updates it
/// rather than leaving two rows they cannot tell apart.
export function upsertPreset(wsId: string, preset: LayoutPreset): void {
  setAll((cur) => {
    const list = (cur[wsId] ?? []).filter((p) => p.name !== preset.name);
    list.push(preset);
    list.sort((a, b) => b.savedAt - a.savedAt);
    return { ...cur, [wsId]: list };
  });
  persist();
}

export function removePreset(wsId: string, name: string): void {
  setAll((cur) => ({ ...cur, [wsId]: (cur[wsId] ?? []).filter((p) => p.name !== name) }));
  persist();
}

export type PresetRenameResult = "ok" | "not-found" | "empty-name" | "duplicate";

/// Rename in place, keeping `savedAt` — the preset is the same capture, so
/// re-dating it would reshuffle the list under the user's cursor.
export function renamePreset(
  wsId: string,
  from: string,
  to: string,
): PresetRenameResult {
  const trimmed = to.trim();
  if (!trimmed) return "empty-name";
  const list = all()[wsId] ?? [];
  if (!list.some((p) => p.name === from)) return "not-found";
  if (trimmed !== from && list.some((p) => p.name === trimmed)) return "duplicate";
  setAll((cur) => ({
    ...cur,
    [wsId]: (cur[wsId] ?? []).map((p) => (p.name === from ? { ...p, name: trimmed } : p)),
  }));
  persist();
  return "ok";
}

/// Test seam: forget everything loaded from disk.
export function resetPresetsForTest(): void {
  setAll({});
}
