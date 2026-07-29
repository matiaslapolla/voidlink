/// Tab activity, and the escalation that keeps it visible.
///
/// MASTER.md §7.5.3 rule 1: *activity is never invisible*. A user must never
/// have to open a pane to discover that something happened in it. That single
/// sentence is what this module exists for — the signals themselves are the
/// easy part.
///
/// Three surfaces show the same set of facts at three levels of zoom:
///
///   1. **The tab.** Its own mark, in the slot `TabStrip` reserves at rest.
///   2. **The group header.** The aggregate mark of every tab in a group the
///      user is *not* focused on (the slot Wave 2 reserved on the strip).
///   3. **The status bar.** The aggregate mark of every tab in a group that is
///      not on screen at all — maximized away, or hidden by zen. The status bar
///      is the one surface both focus modes keep, which is exactly why it is
///      the last stop.
///
/// Escalation is a pure function (`escalate`) over a snapshot of that state, so
/// the load-bearing rule is testable without mounting a shell. Everything above
/// it — who raises a signal, who clears it — is a small mutable registry.
///
/// **Not persisted, deliberately.** A bell that rang in a shell that no longer
/// exists is not news the next morning; all of this dies with the session, like
/// `focusMode`.
import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { highestSignal, type ActivitySignal } from "@/components/layout/StatusLed";

/// Which signals each tab is currently carrying. A tab with none is absent
/// from the record rather than present with an empty array, so `Object.keys`
/// is the live set.
type SignalSet = Partial<Record<ActivitySignal, true>>;

const [signals, setSignals] = createStore<Record<string, SignalSet>>({});

/// Tabs the user can actually see right now: the front tab of every group that
/// is on screen. Written by `MainSurface`, read here so a signal that fires in
/// a pane you are already looking at never becomes a badge you have to dismiss.
let visible: ReadonlySet<string> = new Set();

/// The whole activity map, for consumers that need to react to any change.
export function tabSignals(): Record<string, SignalSet> {
  return signals;
}

/// Everything one tab is signalling, in no particular order. `highestSignal`
/// is what turns it into the one mark that renders (§7.5.3 rule 2).
export function signalsOf(tabId: string): ActivitySignal[] {
  return Object.keys(signals[tabId] ?? {}) as ActivitySignal[];
}

/// The single mark for one tab, precedence applied. `undefined` when the tab is
/// quiet, so callers can hand it straight to `<LedSlot>`.
export function tabMark(tabId: string, extra?: ActivitySignal): ActivitySignal | undefined {
  return highestSignal([...signalsOf(tabId), extra]);
}

export function raiseSignal(tabId: string, signal: ActivitySignal): void {
  setSignals(produce((s) => {
    (s[tabId] ??= {})[signal] = true;
  }));
}

export function clearSignal(tabId: string, signal: ActivitySignal): void {
  setSignals(produce((s) => {
    const set = s[tabId];
    if (!set) return;
    delete set[signal];
    if (Object.keys(set).length === 0) delete s[tabId];
  }));
}

/// A tab closed. Its signals go with it — a badge for a pane that no longer
/// exists would escalate forever with nowhere to send the user.
export function clearTabActivity(tabId: string): void {
  setSignals(produce((s) => {
    delete s[tabId];
  }));
}

/// Publish which tabs are on screen. Two jobs: it suppresses `finished` for
/// work the user watched happen, and it clears the "while you were away"
/// signals on the tabs that just came into view.
///
/// `failed` is deliberately *not* cleared — §7.5.3 says a failure clears on
/// explicit acknowledgement and never on focus alone. Glancing at a pane is
/// not the same as having read the error in it.
export function setVisibleTabs(tabIds: Iterable<string>): void {
  visible = new Set(tabIds);
  setSignals(produce((s) => {
    for (const id of Object.keys(s)) {
      if (!visible.has(id)) continue;
      delete s[id].bell;
      delete s[id].finished;
      if (Object.keys(s[id]).length === 0) delete s[id];
    }
  }));
}

export function isTabVisible(tabId: string): boolean {
  return visible.has(tabId);
}

/// Acknowledge a failure. The only way `failed` clears.
export function acknowledgeTab(tabId: string): void {
  clearSignal(tabId, "failed");
}

// ── The three terminal events ───────────────────────────────────────────────
// MASTER §7.5.3 and the workbench prompt both insist these are *three*
// signals, not one, so they get three named entry points rather than a generic
// `raiseSignal` sprinkled through the terminal code.

/// The shell rang the bell (BEL / `\a`). Ambient, never steals focus.
export function noteBell(tabId: string): void {
  if (isTabVisible(tabId)) return;
  raiseSignal(tabId, "bell");
}

/// A foreground command is running in this shell. Pulses while it runs.
export function noteRunning(tabId: string, running: boolean): void {
  if (running) raiseSignal(tabId, "running");
  else clearSignal(tabId, "running");
}

/// A foreground command ended. `ok === false` is a failure and outranks
/// everything else; `ok === true` is only news if the user was looking
/// somewhere else when it happened.
export function noteFinished(tabId: string, ok: boolean): void {
  clearSignal(tabId, "running");
  if (!ok) {
    raiseSignal(tabId, "failed");
    return;
  }
  if (isTabVisible(tabId)) return;
  raiseSignal(tabId, "finished");
}

/// Reset everything. Tests, and the "reset layout" escape hatch.
export function resetActivity(): void {
  setSignals(produce((s) => {
    for (const id of Object.keys(s)) delete s[id];
  }));
  visible = new Set();
}

// ── Escalation ──────────────────────────────────────────────────────────────

export interface EscalationInput {
  /// Every tab carrying at least one signal, and what it is carrying.
  tabSignals: ReadonlyMap<string, readonly ActivitySignal[]>;
  /// Group id → the tab ids it holds.
  groupTabs: ReadonlyMap<string, readonly string[]>;
  /// The groups currently rendered. A maximized sibling leaves the rest out of
  /// this set even though they still exist in the pane tree.
  visibleGroupIds: ReadonlySet<string>;
  /// The group whose strip the user is working in, or `null`.
  focusedGroupId: string | null;
  /// Zen hides every tab strip, so there is no group header to escalate *to* —
  /// everything goes one level further, to the status bar.
  zen: boolean;
}

export interface Escalation {
  /// Group id → the mark for that group's reserved header slot.
  groups: Map<string, ActivitySignal>;
  /// The mark the status bar must carry, and the tabs it is about (so the
  /// segment's `aria-label` and tooltip can name them rather than saying
  /// "something happened somewhere").
  statusBar: { signal: ActivitySignal; tabIds: string[] } | null;
}

/// Pure. Given who is signalling and what is on screen, decide what the group
/// headers and the status bar have to show.
///
/// The two rules, in the order §7.5.3 states them:
///   • A signal in a group that is on screen but not focused → that group's
///     header. The focused group gets no header mark: its tabs are right there,
///     each wearing its own.
///   • A signal in a group that is off screen — maximized away, or all of them
///     under zen — → the status bar, because no header of its own is rendered.
export function escalate(input: EscalationInput): Escalation {
  const groups = new Map<string, ActivitySignal>();
  const offScreen: ActivitySignal[] = [];
  const offScreenTabs: string[] = [];

  for (const [groupId, tabIds] of input.groupTabs) {
    const live: ActivitySignal[] = [];
    for (const tabId of tabIds) {
      const s = input.tabSignals.get(tabId);
      if (s?.length) live.push(...s);
    }
    if (live.length === 0) continue;

    // Zen renders no strips, so *every* group is effectively off screen for
    // the purposes of showing a mark, whatever `visibleGroupIds` says about
    // the pane bodies.
    const hidden = input.zen || !input.visibleGroupIds.has(groupId);
    if (hidden) {
      offScreen.push(...live);
      for (const tabId of tabIds) if (input.tabSignals.get(tabId)?.length) offScreenTabs.push(tabId);
      continue;
    }
    if (groupId === input.focusedGroupId) continue;
    const mark = highestSignal(live);
    if (mark) groups.set(groupId, mark);
  }

  const statusMark = highestSignal(offScreen);
  return {
    groups,
    statusBar: statusMark ? { signal: statusMark, tabIds: offScreenTabs } : null,
  };
}

// ── The last stop ───────────────────────────────────────────────────────────

/// What the status bar has to carry, published by `MainSurface` (the only
/// component that knows the pane geometry `escalate` needs) and consumed by
/// `StatusBar` (the only surface both focus modes keep).
///
/// A module-level signal rather than a prop because the two are not in a
/// parent/child relationship — they are two slots of `AppShell` — and because
/// threading it through the shell would put pane geometry in `App.tsx`.
const [hidden, setHidden] = createSignal<Escalation["statusBar"]>(null, {
  equals: (a, b) => a?.signal === b?.signal && a?.tabIds.length === b?.tabIds.length,
});

export const hiddenActivity = hidden;

export function publishHiddenActivity(value: Escalation["statusBar"]): void {
  setHidden(value);
}
