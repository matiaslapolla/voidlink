/// The held-modifier state behind `Ctrl+Tab`.
///
/// The interaction is unlike every other shortcut in the app: the chord does
/// not act, it *opens a preview* that keeps accepting presses until the
/// modifier comes up, and only then commits. That needs three pieces of state
/// — is it open, what are the candidates, which one is selected — and one rule:
/// nothing is activated until the release.
///
/// The candidates are pushed in by the caller rather than pulled from the store
/// here, so this module stays free of the layout store and of the DOM. The
/// keyup that ends the cycle is watched in `keybindings.ts`, which is the only
/// module allowed to touch the keyboard.
import { createSignal } from "solid-js";

/// One row of the overlay. `kind` picks the icon; it is a `TabKind` string, but
/// typing it as one would drag the layout store into this module for nothing.
export interface CycleCandidate {
  id: string;
  label: string;
  kind: string;
}

const [candidates, setCandidates] = createSignal<CycleCandidate[]>([]);
const [index, setIndex] = createSignal(0);
const [open, setOpen] = createSignal(false);

/// True while the modifier is still down and the overlay is showing.
export const isCycleOpen = open;
export const cycleCandidates = candidates;
export const cycleIndex = index;

export function cycleSelection(): CycleCandidate | null {
  return candidates()[index()] ?? null;
}

/// One press of the chord.
///
/// The first press opens the overlay on the candidate `delta` steps from the
/// current tab — index 0 is the tab you are on, so one press is the previously
/// used one. Later presses move within the list that was captured at open:
/// re-reading the MRU mid-cycle would reorder the list under the user's finger.
export function stepCycle(list: CycleCandidate[], delta: number): void {
  if (list.length < 2) return;
  if (!open()) {
    setCandidates(list);
    setOpen(true);
    setIndex(wrap(delta, list.length));
    return;
  }
  setIndex((i) => wrap(i + delta, candidates().length));
}

/// Close and report what was selected. Returns `null` when no cycle was
/// running, so the release watcher can call it unconditionally.
export function commitCycle(): CycleCandidate | null {
  if (!open()) return null;
  const selected = cycleSelection();
  reset();
  return selected;
}

/// Close and select nothing — Escape, or the window losing focus with the
/// modifier still notionally down.
export function abortCycle(): void {
  if (!open()) return;
  reset();
}

function reset() {
  setOpen(false);
  setCandidates([]);
  setIndex(0);
}

function wrap(value: number, count: number): number {
  if (count <= 0) return 0;
  return ((value % count) + count) % count;
}
