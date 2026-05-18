import { createSignal } from "solid-js";

/// Per-repo "recently used branch" list. Reads/writes localStorage so
/// it survives reloads. Capped at 50 entries — past that, branches you
/// haven't touched stop earning their slot.
const KEY = "voidlink-branch-mru";
const LIMIT = 50;

type Mru = Record<string, string[]>;

function load(): Mru {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Mru;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

const [mru, setMru] = createSignal<Mru>(load());

function persist() {
  localStorage.setItem(KEY, JSON.stringify(mru()));
}

export function branchMruFor(repoPath: string): string[] {
  return mru()[repoPath] ?? [];
}

export function branchMruSignal() {
  return mru;
}

/// Bump `branch` to the front of the MRU for `repoPath`. Idempotent
/// against the current head — calling on the same branch twice doesn't
/// re-bump (avoids "checked out X, refreshed, X still at top" noise
/// when refreshes accidentally call this).
export function recordBranchUse(repoPath: string, branch: string) {
  setMru((cur) => {
    const list = cur[repoPath] ?? [];
    if (list[0] === branch) return cur;
    const next = [branch, ...list.filter((b) => b !== branch)].slice(0, LIMIT);
    return { ...cur, [repoPath]: next };
  });
  persist();
}

/// Sort `branches` MRU-first (HEAD stays at top regardless), then by
/// MRU order, then alphabetical fallback for the tail.
export function sortBranchesByMru<T extends { name: string; isHead: boolean }>(
  branches: T[],
  repoPath: string,
): T[] {
  const order = new Map<string, number>();
  const list = branchMruFor(repoPath);
  list.forEach((b, i) => order.set(b, i));
  return [...branches].sort((a, b) => {
    if (a.isHead !== b.isHead) return a.isHead ? -1 : 1;
    const ai = order.has(a.name) ? order.get(a.name)! : Number.POSITIVE_INFINITY;
    const bi = order.has(b.name) ? order.get(b.name)! : Number.POSITIVE_INFINITY;
    if (ai !== bi) return ai - bi;
    return a.name.localeCompare(b.name);
  });
}
