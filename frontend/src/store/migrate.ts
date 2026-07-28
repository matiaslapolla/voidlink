/// Versioned upgrade of voidlink's persisted layout state.
///
/// v0 → v1 moves every per-workspace tab collection to per-worktree keying.
/// The trick that makes this a *one-key* migration instead of a full re-key of
/// eight `Record<id, T[]>` blobs: each migrated workspace gets exactly one main
/// worktree whose id **is the old workspace id**. Every
/// `Record<oldWorkspaceId, T[]>` on disk therefore stays valid verbatim under
/// the new per-worktree keying, so `voidlink-compare-tabs`,
/// `voidlink-stack-tabs`, `voidlink-pinned-tabs` and `voidlink-snapshots` are
/// left untouched on purpose. Nothing the user had open can be lost, because
/// nothing the user had open is rewritten.
///
/// The transform is a pure function over a storage snapshot so it can be tested
/// without a DOM, and it is idempotent twice over: it short-circuits on the
/// version key, and it also leaves any workspace that already has worktrees
/// alone. Running it on already-migrated state is a no-op either way.

/// v1 → v2 accompanies the `store/layout.ts` → `store/layout/` decomposition.
/// It is deliberately *not* a re-shaping of the tab blobs: `voidlink-editor-tabs`
/// and friends keep their exact on-disk layout, because the tab registry
/// describes those keys rather than replacing them (see `layout/tabs.ts`).
/// Consolidating them into one new key would orphan every existing user's tabs
/// on the boot after the upgrade — for zero gain, since one key per kind *is*
/// the registry's storage shape.
///
/// What v2 does add is a repair pass: any registry key that is present but not
/// a JSON object is reset to an empty one, at rest and once, rather than being
/// re-parsed and re-discarded on every boot. That is the migration-time half of
/// the "a corrupt blob costs one key, never the boot" policy that
/// `layout/persistence.ts` enforces at read time.

export const LAYOUT_VERSION = 2;
export const LAYOUT_VERSION_KEY = "voidlink-layout-version";
export const WORKSPACES_KEY = "voidlink-workspaces";

/// The keys the layout store persists tab state under, spelled out here rather
/// than imported from `layout/persistence.ts`. This module is deliberately
/// standalone — a pure transform with no DOM and no store imports — and that
/// property is worth more than deduplicating five string literals.
export const TAB_STORAGE_KEYS = [
  "voidlink-compare-tabs",
  "voidlink-stack-tabs",
  "voidlink-pinned-tabs",
  "voidlink-browser-tabs",
  "voidlink-editor-tabs",
] as const;

/// The subset of localStorage the migration reads and writes, as a plain
/// object. `null` means "key absent".
export type StorageSnapshot = Record<string, string | null>;

/// Minimal surface we need from `localStorage`, so tests can pass a fake.
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface V0Workspace {
  id?: unknown;
  name?: unknown;
  repoRoot?: unknown;
  worktrees?: unknown;
  activeWorktreeId?: unknown;
  isRepo?: unknown;
}

/// Keys the migration reads. Everything else in localStorage is out of scope
/// and must be carried through untouched.
export const MIGRATION_INPUT_KEYS = [
  LAYOUT_VERSION_KEY,
  WORKSPACES_KEY,
  ...TAB_STORAGE_KEYS,
] as const;

function parseVersion(raw: string | null): number {
  if (raw === null) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

/// Upgrade one v0 workspace record. Returns `null` when the entry is too
/// broken to be worth keeping (no usable id), so the caller can drop it.
function upgradeWorkspace(raw: V0Workspace): Record<string, unknown> | null {
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  const repoRoot = typeof raw.repoRoot === "string" ? raw.repoRoot : null;
  const name = typeof raw.name === "string" ? raw.name : "Workspace";

  // Already migrated (or hand-written by a newer build): keep its worktrees.
  if (Array.isArray(raw.worktrees) && raw.worktrees.length > 0) {
    const activeWorktreeId =
      typeof raw.activeWorktreeId === "string" && raw.activeWorktreeId.length > 0
        ? raw.activeWorktreeId
        : ((raw.worktrees[0] as { id?: unknown }).id as string);
    return {
      id: raw.id,
      name,
      repoRoot,
      worktrees: raw.worktrees,
      activeWorktreeId,
      isRepo: !!raw.isRepo,
    };
  }

  // The load-bearing line: worktree id === old workspace id.
  return {
    id: raw.id,
    name,
    repoRoot,
    worktrees: [
      {
        id: raw.id,
        path: repoRoot ?? "",
        branch: null,
        isMain: true,
        isSynthetic: true,
      },
    ],
    activeWorktreeId: raw.id,
    isRepo: false,
  };
}

/// v0 → v1: give every workspace exactly one main worktree whose id is the old
/// workspace id, so the per-workspace tab blobs stay valid verbatim under the
/// new per-worktree keying.
function migrateV0ToV1(snapshot: StorageSnapshot): StorageSnapshot {
  const out: StorageSnapshot = { ...snapshot };
  const rawWorkspaces = snapshot[WORKSPACES_KEY] ?? null;
  if (rawWorkspaces === null) return out;
  try {
    const parsed: unknown = JSON.parse(rawWorkspaces);
    if (Array.isArray(parsed)) {
      const upgraded = parsed
        .map((w) => upgradeWorkspace((w ?? {}) as V0Workspace))
        .filter((w): w is Record<string, unknown> => w !== null);
      // Only rewrite when we actually produced something. An unparseable or
      // fully-empty list is left alone so the store's own fallback ("create a
      // fresh Main workspace") runs instead of us persisting `[]`.
      if (upgraded.length > 0) {
        out[WORKSPACES_KEY] = JSON.stringify(upgraded);
      }
    }
  } catch {
    // Corrupt JSON: leave the key untouched. `loadWorkspaces` already treats
    // a parse failure as "no saved workspaces" and starts fresh.
  }
  return out;
}

function isJsonObject(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw);
    return !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/// v1 → v2: quarantine corrupt registry blobs. A key that is present but is not
/// a JSON object — truncated by a crash mid-write, or hand-edited — is reset to
/// an empty object here rather than being parsed and thrown away on every boot
/// forever after. Well-formed keys are left byte-identical, which is why the
/// v0 fixtures in `migrate.test.ts` still round-trip unchanged.
function migrateV1ToV2(snapshot: StorageSnapshot): StorageSnapshot {
  const out: StorageSnapshot = { ...snapshot };
  for (const key of TAB_STORAGE_KEYS) {
    const raw = out[key];
    if (typeof raw !== "string") continue;
    if (!isJsonObject(raw)) out[key] = "{}";
  }
  return out;
}

/// The ordered upgrade path. A snapshot at version N runs every step whose
/// target is greater than N, in order, then gets stamped with the current
/// version. Each step is a pure `StorageSnapshot → StorageSnapshot` and is
/// idempotent on its own output.
const STEPS: { to: number; apply: (s: StorageSnapshot) => StorageSnapshot }[] = [
  { to: 1, apply: migrateV0ToV1 },
  { to: 2, apply: migrateV1ToV2 },
];

/// Pure transform from whatever version is on disk up to `LAYOUT_VERSION`.
/// Returns a new snapshot; the input is never mutated. Keys the migration
/// doesn't understand are copied through as-is.
export function migrateLayoutStorage(snapshot: StorageSnapshot): StorageSnapshot {
  const from = parseVersion(snapshot[LAYOUT_VERSION_KEY] ?? null);
  if (from >= LAYOUT_VERSION) return { ...snapshot };

  let out: StorageSnapshot = { ...snapshot };
  for (const step of STEPS) {
    if (from >= step.to) continue;
    out = step.apply(out);
  }

  out[LAYOUT_VERSION_KEY] = String(LAYOUT_VERSION);
  return out;
}

/// Impure shell: read the keys the migration cares about, run the transform,
/// write back only what changed. Returns true when anything was written.
export function runLayoutMigration(storage: KeyValueStore): boolean {
  const before: StorageSnapshot = {};
  for (const key of MIGRATION_INPUT_KEYS) before[key] = storage.getItem(key);

  const after = migrateLayoutStorage(before);

  let wrote = false;
  for (const [key, value] of Object.entries(after)) {
    if (value === null || value === before[key]) continue;
    storage.setItem(key, value);
    wrote = true;
  }
  return wrote;
}
