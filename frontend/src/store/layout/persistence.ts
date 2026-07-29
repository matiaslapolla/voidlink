/// Every `localStorage` touch the layout store makes, in one module.
///
/// Before this, eight keys were read by eight bespoke loaders and written by
/// six `createEffect`s scattered through a 2000-line file, each with its own
/// `try/catch` (or, in two cases, none). That is six chances to forget that
/// `localStorage` throws — on a quota overflow, in private mode, and in a
/// non-browser host such as the test runner. It is now one read path, one
/// write path and one policy.
///
/// **No other module may call `localStorage`.** Components read persisted
/// state through `useAppStore()`; the store reads it through here.
import { WORKSPACES_KEY } from "@/store/migrate";

/// The layout store's keys. `migrate.ts` owns `voidlink-layout-version` and
/// `voidlink-workspaces`; everything else is declared here.
///
/// These names are load-bearing: they are what is already on every user's
/// disk. A rename is a migration, not an edit.
export const STORAGE_KEYS = {
  workspaces: WORKSPACES_KEY,
  activeWorkspace: "voidlink-active-workspace",
  gitPrefs: "voidlink-git-prefs",
  compareTabs: "voidlink-compare-tabs",
  stackTabs: "voidlink-stack-tabs",
  pinnedTabs: "voidlink-pinned-tabs",
  browserTabs: "voidlink-browser-tabs",
  /// The editor window's four tab collections, in one blob. These used to be
  /// memory-only — the workbench reseeded them empty on every boot — but now
  /// that they are the entire contents of another window, losing them on a
  /// workbench reload would close somebody's editor out from under them.
  editorTabs: "voidlink-editor-tabs",
  /// `Record<worktreeId, PaneNode>` — the split tree per worktree. Geometry is
  /// per worktree and not synced across windows, so it sits beside the tab
  /// blobs rather than inside them.
  paneLayout: "voidlink-pane-layout",
  /// `Record<worktreeId, Record<groupId, tabId[]>>` — the per-group tab MRU
  /// `Ctrl+Tab` cycles. Persisted so the first cycle after a reload lands
  /// somewhere meaningful instead of on whatever happens to be leftmost.
  tabMru: "voidlink-tab-mru",
  /// `Record<worktreeId, NavHistory>` — back/forward. Per worktree, like the
  /// geometry it navigates.
  navHistory: "voidlink-nav-history",
  /// `Record<worktreeId, TerminalSession[]>` — the terminal *sessions*, not
  /// their PTYs. A persisted `ptyId` names a process that died with the app;
  /// what survives a reload is the cwd and the label, and boot spawns a fresh
  /// PTY under the same tab id (see `TAB_SPECS.terminal.restore`).
  terminalTabs: "voidlink-terminal-tabs",
  /// The two repo-wide singleton kinds. One id each, per worktree — tiny, but
  /// without them a reload silently closes the commit graph you left open.
  historyTabs: "voidlink-history-tabs",
  brainTabs: "voidlink-brain-tabs",
  /// `Record<worktreeId, ActiveItem | null>` — the *workbench's* front tab.
  /// The editor window's pointer rides inside `voidlink-editor-tabs`; this one
  /// had no key at all until session restore needed it.
  activeItem: "voidlink-active-item",
  /// `Record<worktreeId, ClosedTab[]>` — reopen-last-closed, across reloads.
  closedTabs: "voidlink-closed-tabs",
  /// `Record<worktreeId, WorkspaceSnapshot[]>`. Read and written by
  /// `commands/snapshots.ts` *through this module* — it is layout state, and
  /// the no-other-module-touches-localStorage rule has no exceptions.
  snapshots: "voidlink-snapshots",
} as const;

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];

/// Every key a layout reset clears — which is every key above *except*
/// snapshots. A snapshot is a document the user named and saved; "my panes are
/// broken, start over" must not also throw those away. Settings and AI keys
/// live under their own names and are likewise untouched.
export const LAYOUT_STORAGE_KEYS: string[] = Object.values(STORAGE_KEYS).filter(
  (key) => key !== STORAGE_KEYS.snapshots,
);

/// `localStorage` is absent in the test runner and in any non-browser host, and
/// throws rather than returning `undefined` when it is disabled. One guard,
/// here, instead of a `try/catch` at each of the fourteen former call sites.
function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readRaw(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

// ── Corruption policy ─────────────────────────────────────────────────────

/// Suffix of the shadow key a write lands on before it is committed. See
/// `commit()` — this is the half of the crash-safe write that the read side
/// has to know about.
const PENDING_SUFFIX = "~pending";

/// Set once per key, so a blob that fails to parse reports itself on the boot
/// that found it and not again on every subsequent read of the same key.
const reported = new Set<string>();
let onCorruptKey: ((key: string) => void) | null = null;

/// Install the handler that tells the user a key was quarantined. Called once
/// from the store; kept as a hook so this module stays free of UI imports.
export function setCorruptKeyHandler(fn: (key: string) => void) {
  onCorruptKey = fn;
}

/// Test seam: forget which keys have already been reported.
export function resetCorruptionReports() {
  reported.clear();
}

function reportCorrupt(key: string) {
  if (reported.has(key)) return;
  reported.add(key);
  onCorruptKey?.(key);
}

function tryParse(raw: string | null): { ok: boolean; value: unknown } {
  if (raw === null) return { ok: false, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, value: undefined };
  }
}

/// Read one key, healing what can be healed.
///
/// Three outcomes, in order: the committed value parses and is used; it does
/// not, but the shadow key from an interrupted write does, and *that* is used
/// (the crash landed between the two `setItem`s); neither parses, the key is
/// quarantined — reported once, defaulted for this boot, and overwritten by
/// the first legitimate write. A partially-written blob therefore costs at
/// most the last change to one key, and never the boot.
function readChecked(key: string): { present: boolean; parsed: unknown } {
  const direct = tryParse(readRaw(key));
  if (direct.ok) return { present: true, parsed: direct.value };
  const pending = tryParse(readRaw(key + PENDING_SUFFIX));
  if (pending.ok) return { present: true, parsed: pending.value };
  if (readRaw(key) === null) return { present: false, parsed: undefined };
  reportCorrupt(key);
  return { present: false, parsed: undefined };
}

/// The raw text of a key, or `null` when it is absent or corrupt. For the one
/// caller that parses the blob itself (`parseEditorTabs`) and so cannot go
/// through `readJson`.
export function readRawChecked(key: string): string | null {
  const { present, parsed } = readChecked(key);
  if (!present) return null;
  try {
    return JSON.stringify(parsed);
  } catch {
    return null;
  }
}

/// Parse a key as JSON, falling back to `fallback` on absence *or* corruption.
/// The whole quarantine policy in one line: a bad blob costs that one key, and
/// never the boot.
export function readJson<T>(key: string, fallback: T): T {
  const { present, parsed } = readChecked(key);
  if (!present) return fallback;
  return parsed === null || parsed === undefined ? fallback : (parsed as T);
}

// ── The single write path ─────────────────────────────────────────────────

/// Trailing-edge coalescing window. The store's persist effects fire on every
/// keystroke in a compare tab's filter box; without this each one is a
/// synchronous `JSON.stringify` of the whole collection.
const WRITE_DEBOUNCE_MS = 120;

const pending = new Map<string, string>();
let timer: ReturnType<typeof setTimeout> | null = null;
/// Set once when a write fails, so a full disk reports itself once rather than
/// on every subsequent keystroke.
let quotaExceeded = false;
let onQuotaError: ((key: string) => void) | null = null;

/// Install the handler that surfaces a failed write to the user. Called once
/// from the store; kept as a hook so this module stays free of UI imports.
export function setPersistenceErrorHandler(fn: (key: string) => void) {
  onQuotaError = fn;
}

function commit() {
  timer = null;
  const store = storage();
  if (!store) {
    pending.clear();
    return;
  }
  for (const [key, value] of pending) {
    try {
      // Write-to-shadow, then commit, then drop the shadow. `setItem` is
      // atomic per key, so the only state a crash can leave behind is "shadow
      // present, committed value stale or half-written" — which `readChecked`
      // resolves in the shadow's favour. Without this, a process killed
      // mid-write leaves a truncated blob and the key defaults on next boot.
      store.setItem(key + PENDING_SUFFIX, value);
      store.setItem(key, value);
      store.removeItem(key + PENDING_SUFFIX);
      // The key is legible again; a future corruption should be reported.
      reported.delete(key);
    } catch {
      // Quota, private mode, or a disabled store. The in-memory state is still
      // correct; only durability is lost, and telling the user once is the
      // right interruption level (MASTER §7.5.5 — transient, not blocking).
      if (!quotaExceeded) {
        quotaExceeded = true;
        onQuotaError?.(key);
      }
    }
  }
  pending.clear();
}

/// Queue `value` for `key`. Later writes to the same key replace earlier ones,
/// so the coalescing window never persists a stale intermediate state.
export function writeRaw(key: string, value: string): void {
  pending.set(key, value);
  if (timer === null) timer = setTimeout(commit, WRITE_DEBOUNCE_MS);
}

export function writeJson(key: string, value: unknown): void {
  try {
    writeRaw(key, JSON.stringify(value));
  } catch {
    // A value with a cycle in it. Dropping the write is strictly better than
    // throwing out of a reactive effect and taking the render down with it.
  }
}

/// Force everything queued out to disk now. Wired to `pagehide` below, and
/// available to tests that need to assert on what landed.
export function flushWrites(): void {
  if (timer !== null) clearTimeout(timer);
  commit();
}

// A debounced write that the window closes on top of is a lost write. `pagehide`
// fires on reload, navigation and close, and unlike `beforeunload` it is not
// suppressed by the bfcache.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushWrites);
}

/// The `KeyValueStore` `store/migrate.ts` runs against. Exposed here so the
/// migration's one impure dependency comes through the same guarded accessor as
/// everything else, rather than a second bare `localStorage` reference.
/// Returns `null` when there is no storage to migrate.
export function layoutKeyValueStore(): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
} | null {
  const store = storage();
  if (!store) return null;
  return {
    getItem: (key) => {
      try {
        return store.getItem(key);
      } catch {
        return null;
      }
    },
    setItem: (key, value) => {
      try {
        store.setItem(key, value);
      } catch {
        // Migration writes are best-effort for the same reason ordinary writes
        // are: the in-memory state is correct either way.
      }
    },
  };
}

/// Clear every key the layout store owns, leaving settings, AI keys and
/// anything else in `localStorage` untouched. The escape hatch for a layout
/// state so broken the shell will not render.
export function resetLayoutStorage(): void {
  pending.clear();
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  const store = storage();
  if (!store) return;
  reported.clear();
  for (const key of LAYOUT_STORAGE_KEYS) {
    try {
      store.removeItem(key);
      // A shadow left by an interrupted write would otherwise resurrect the
      // exact state the user is resetting away from.
      store.removeItem(key + PENDING_SUFFIX);
    } catch {
      // Nothing useful to do; the caller is about to reload anyway.
    }
  }
}
