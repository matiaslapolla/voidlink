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
import { highestSignal, type ActivitySignal } from "@/components/layout/activitySignal";
import type { StackedView } from "@/commands/environment";

/// Which signals each tab is currently carrying. A tab with none is absent
/// from the record rather than present with an empty array, so `Object.keys`
/// is the live set.
type SignalSet = Partial<Record<ActivitySignal, true>>;

const [signals, setSignals] = createStore<Record<string, SignalSet>>({});

/// Tabs the user can actually see right now: the front tab of every group that
/// is on screen. Written by `MainSurface`, read here so a signal that fires in
/// a pane you are already looking at never becomes a badge you have to dismiss.
let visible: ReadonlySet<string> = new Set();

/// Whether this OS window has focus.
///
/// "On screen" is not the same as "being looked at". A bell in the front tab of
/// a window the user has alt-tabbed away from used to be *dropped* — the tab was
/// in `visible`, so `noteBell` returned early and nothing was ever badged. Which
/// is the one case §7.5.3 rule 1 exists for: you cannot be told about something
/// you were not there to see.
///
/// Defaults to focused, and to focused outside a browser (vitest), so a missing
/// listener errs toward the old behaviour rather than badging everything.
///
/// A signal rather than a plain `let` because the notifier's "what is the user
/// looking at" feed has to be republished when focus changes, and an effect
/// cannot depend on a variable. Every read below goes through the accessor, so
/// there is still exactly one authority.
const [windowFocused, setFocused] = createSignal(true);

/// Whether this OS window has focus. Reactive.
export const isWindowFocused = windowFocused;

/// Publish OS window focus. Called once per window root; the DOM events are the
/// authority, so this takes a value rather than reading `document.hasFocus()` on
/// every check.
export function setWindowFocused(focused: boolean): void {
  setFocused(focused);
  if (!focused) return;
  // Coming back to the window is the same act of "seeing" as bringing a tab to
  // the front, so it clears the same signals on whatever is already in front.
  setVisibleTabs(visible);
}

/// Install the OS-focus listeners. Returns a disposer. Call once per window.
export function trackWindowFocus(): () => void {
  const onFocus = () => setWindowFocused(true);
  const onBlur = () => setWindowFocused(false);
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);
  setWindowFocused(document.hasFocus());
  return () => {
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onBlur);
  };
}

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
  // A tab in a window the user has switched away from is on screen but is not
  // being *seen*, so it clears nothing.
  if (!windowFocused()) return;
  setSignals(produce((s) => {
    for (const id of Object.keys(s)) {
      if (!visible.has(id)) continue;
      delete s[id].notify;
      delete s[id].finished;
      if (Object.keys(s[id]).length === 0) delete s[id];
    }
  }));
}

/// Is the user actually looking at this tab right now? On screen **and** in the
/// focused OS window. Every "was this news?" decision below goes through it.
export function isTabVisible(tabId: string): boolean {
  return windowFocused() && visible.has(tabId);
}

/// Acknowledge a failure. The only way `failed` clears.
export function acknowledgeTab(tabId: string): void {
  clearSignal(tabId, "failed");
}

// ── The terminal events ─────────────────────────────────────────────────────
// Named entry points rather than a generic `raiseSignal` sprinkled through the
// terminal code, so the "was this news?" rule lives in one place per event.

/// A program asked for attention: BEL, OSC 9, or OSC 777. Ambient, never steals
/// focus.
///
/// Cyan `notify`, not the old blue `bell`, and — crucially — above `working` in
/// the precedence chain. A notification from inside a live TUI used to be
/// unrenderable: the TUI kept the shell `busy`, `running` outranked `bell`, and
/// the mark the user actually wanted never appeared.
export function noteBell(tabId: string): void {
  if (isTabVisible(tabId)) return;
  raiseSignal(tabId, "notify");
}

/// A foreground process in this shell is actively working — busy *and* producing
/// output. Pulses while it is. See `store/terminalWatch.ts` for why `busy` alone
/// is not enough.
export function noteWorking(tabId: string, working: boolean): void {
  if (working) raiseSignal(tabId, "working");
  else clearSignal(tabId, "working");
}

/// An agent CLI in this shell has gone quiet and is waiting on the user — a
/// permission prompt, a question, a plan to approve. Derived in
/// `store/terminalWatch.ts`; see `store/agentCli.ts` for the heuristic.
///
/// Stored rather than computed at the render site, unlike `idle`, and for the
/// opposite reason: this is the signal §7.5.3 rule 1 exists for. An agent asking
/// for permission in a worktree the user is not looking at *must* reach the
/// group header, the rail and the status bar, and only a stored signal escalates.
export function noteWaiting(tabId: string, waiting: boolean): void {
  if (waiting) raiseSignal(tabId, "waiting");
  else clearSignal(tabId, "waiting");
}

/// VoidLink is fetching something for this tab (a diff, a stack). Distinct from
/// `noteWorking`: that is the user's shell, this is our own chrome.
export function noteRunning(tabId: string, running: boolean): void {
  if (running) raiseSignal(tabId, "running");
  else clearSignal(tabId, "running");
}

/// A foreground command ended. `ok === false` is a failure and outranks
/// everything else; `ok === true` is only news if the user was looking somewhere
/// else when it happened — in which case it is a `notify`, the same mark a
/// program's own completion notification raises, because to the user they are
/// the same event.
export function noteFinished(tabId: string, ok: boolean): void {
  clearSignal(tabId, "working");
  clearSignal(tabId, "running");
  // The agent exited, so whatever it was asking is moot — and `waiting`
  // outranks everything below `failed`, so leaving it up would mask the very
  // result this call is reporting.
  clearSignal(tabId, "waiting");
  if (!ok) {
    raiseSignal(tabId, "failed");
    return;
  }
  if (isTabVisible(tabId)) return;
  raiseSignal(tabId, "notify");
}

/// Reset everything. Tests, and the "reset layout" escape hatch.
export function resetActivity(): void {
  setSignals(produce((s) => {
    for (const id of Object.keys(s)) delete s[id];
  }));
  visible = new Set();
  setFocused(true);
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
  /// Collapsed **tab groups**: group id → the pane group its chip renders in,
  /// and the tabs it is hiding. A collapsed group renders none of its members,
  /// so it is a new hiding place and the same rule applies — a signal in one
  /// must surface on the chip. Absent means "no collapsed groups".
  collapsedTabGroups?: ReadonlyMap<
    string,
    { paneGroupId: string; tabIds: readonly string[] }
  >;
  /// Zen hides every tab strip, so there is no group header to escalate *to* —
  /// everything goes one level further, to the status bar.
  zen: boolean;
  /// Tab id → the worktree that owns it, **across every worktree**, not just
  /// the rendered one. Optional so a caller that genuinely has one worktree
  /// (the editor window) does not have to build an identity map.
  ///
  /// This is the axis §7.5.3 was missing. `groupTabs` only ever describes the
  /// active worktree, because that is the only one with a pane tree on screen —
  /// so a signal raised in a tab belonging to a *different* worktree matched no
  /// group, fell out of every branch below, and reached nothing. Not "reached
  /// the wrong surface": reached nothing. Rule 1 was being violated one level
  /// above where it was implemented, and the reason it went unnoticed is that
  /// until agents ran in several worktrees at once, no signal was ever raised
  /// anywhere but the worktree the user was looking at.
  tabWorktree?: ReadonlyMap<string, string>;
  /// The worktree on screen. Its tabs escalate through the group/status rules
  /// above; every other worktree's escalate to the rail and the status bar.
  activeWorktreeId?: string | null;
  /// Whether the workspace rail — where a per-worktree mark renders — is on
  /// screen. Defaults to the inverse of `zen`, which is the only thing that
  /// hides it today; passed explicitly so a future focus mode that also hides
  /// it does not silently strand the mark.
  railVisible?: boolean;
  /// The stacked view on screen, or `undefined` in detached mode — where the
  /// three surfaces are separate windows, each with its own escalation, and
  /// there is no switcher to escalate *to*.
  ///
  /// Stacked mode is a fourth hiding place, and the largest one: the view that
  /// is not in front hides its panes, its strips, its rail **and** its status
  /// bar, so every stop the rules above can reach is covered at once.
  currentView?: StackedView;
  /// Tab id → the view that renders it. Absent entries default to `workbench`,
  /// which is where every tab that can raise a signal lives today — terminals,
  /// agent runs, compares and stacks. A map rather than an assumption so that
  /// the day a satellite view raises one, routing it is a matter of filling
  /// this in rather than rewriting the rule.
  tabView?: ReadonlyMap<string, StackedView>;
}

export interface Escalation {
  /// Group id → the mark for that group's reserved header slot.
  groups: Map<string, ActivitySignal>;
  /// Tab group id → the mark for its collapsed chip. Only collapsed groups
  /// appear: an expanded group's members each wear their own mark, and a chip
  /// repeating it would be a second control saying the same thing.
  tabGroups: Map<string, ActivitySignal>;
  /// The mark the status bar must carry, and the tabs it is about (so the
  /// segment's `aria-label` and tooltip can name them rather than saying
  /// "something happened somewhere").
  statusBar: { signal: ActivitySignal; tabIds: string[] } | null;
  /// Worktree id → the aggregate mark for its rail row. Only worktrees that
  /// are **not** the active one appear: the active worktree's signals are
  /// already resolved by the three rules above, and a rail dot repeating them
  /// would be a fourth surface saying what three already say.
  worktrees: Map<string, ActivitySignal>;
  /// Stacked view → the aggregate mark for its segment in the view switcher.
  /// Only views that are **not** in front appear: the one on screen has its
  /// signals resolved by every rule above, and a segment repeating them would
  /// be one more surface saying what four already say.
  views: Map<StackedView, ActivitySignal>;
  /// The mark for a status-bar segment naming the worktrees involved, or
  /// `null`.
  ///
  /// Emitted only when the rail is not on screen. When the rail is up it is
  /// the right home for this — it is always visible, it is where worktrees
  /// live, and MASTER §7.6 is explicit that a chip duplicating a visible
  /// surface is a dead affordance. Under zen the rail is gone, and then the
  /// status bar is the only surface left, which makes this mandatory rather
  /// than decorative.
  worktreeStatusBar: { signal: ActivitySignal; worktreeIds: string[] } | null;
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
///
/// A collapsed tab group adds a third, *finer* stop between the tab and the
/// group header: its members are not rendered at all, so their marks surface on
/// the chip. It does not replace the two rules above — a collapsed group in a
/// maximized-away pane still reaches the status bar, because the chip is not on
/// screen either.
export function escalate(input: EscalationInput): Escalation {
  const groups = new Map<string, ActivitySignal>();
  const views = new Map<StackedView, ActivitySignal>();
  const tabGroups = new Map<string, ActivitySignal>();
  const offScreen: ActivitySignal[] = [];
  const offScreenTabs: string[] = [];

  // ── The view axis, first ──────────────────────────────────────────────
  // Before everything else, because a view that is not in front hides all four
  // surfaces the rules below escalate to at once. Those rules still run — the
  // covered view keeps a coherent set of marks for the moment it comes back —
  // but none of what they decide is on screen while it is covered, so the
  // switcher segment is the only stop that can be seen.
  if (input.currentView) {
    const viewLive = new Map<StackedView, ActivitySignal[]>();
    for (const [tabId, live] of input.tabSignals) {
      if (!live.length) continue;
      const view = input.tabView?.get(tabId) ?? "workbench";
      if (view === input.currentView) continue;
      const bucket = viewLive.get(view);
      if (bucket) bucket.push(...live);
      else viewLive.set(view, [...live]);
    }
    for (const [view, live] of viewLive) {
      const mark = highestSignal(live);
      if (mark) views.set(view, mark);
    }
  }

  // ── The worktree axis ─────────────────────────────────────────────────
  // Before the pane rules, because a tab in another worktree has no pane group
  // at all and would otherwise fall through every branch below and reach
  // nothing. Grouping by worktree here also means the pane pass never has to
  // ask whether a tab it is looking at belongs to the worktree on screen: by
  // construction, `groupTabs` only contains tabs that do.
  const worktreeLive = new Map<string, ActivitySignal[]>();
  if (input.tabWorktree) {
    for (const [tabId, live] of input.tabSignals) {
      if (!live.length) continue;
      const wtId = input.tabWorktree.get(tabId);
      // A tab with no worktree is one that closed between the snapshot and
      // this call. Dropping it is right: a mark for a pane that no longer
      // exists escalates forever with nowhere to send the user.
      if (!wtId || wtId === input.activeWorktreeId) continue;
      const bucket = worktreeLive.get(wtId);
      if (bucket) bucket.push(...live);
      else worktreeLive.set(wtId, [...live]);
    }
  }

  const worktrees = new Map<string, ActivitySignal>();
  for (const [wtId, live] of worktreeLive) {
    const mark = highestSignal(live);
    if (mark) worktrees.set(wtId, mark);
  }

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

  // Collapsed tab groups, after the pane pass so `groups` is already decided.
  // A chip only earns a mark when it is actually on screen; when it is not, the
  // pane pass above has already routed its members to the status bar.
  for (const [tabGroupId, { paneGroupId, tabIds }] of input.collapsedTabGroups ?? []) {
    if (input.zen || !input.visibleGroupIds.has(paneGroupId)) continue;
    const live: ActivitySignal[] = [];
    for (const tabId of tabIds) {
      const s = input.tabSignals.get(tabId);
      if (s?.length) live.push(...s);
    }
    const mark = highestSignal(live);
    if (mark) tabGroups.set(tabGroupId, mark);
  }

  const statusMark = highestSignal(offScreen);

  // The rail is the home for a worktree mark whenever it is on screen; the
  // status segment exists for when it is not.
  const railVisible = input.railVisible ?? !input.zen;
  const worktreeMark = railVisible ? undefined : highestSignal([...worktrees.values()]);

  return {
    groups,
    tabGroups,
    statusBar: statusMark ? { signal: statusMark, tabIds: offScreenTabs } : null,
    views,
    worktrees,
    worktreeStatusBar: worktreeMark
      ? { signal: worktreeMark, worktreeIds: [...worktrees.keys()] }
      : null,
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

/// Per-worktree marks, published by `MainSurface` and read by `WorkspaceRail`
/// (a row's dot) and `StatusBar` (the segment for when the rail is gone).
///
/// Same reasoning as `hiddenActivity`: the rail and the pane tree are siblings
/// under `AppShell`, and threading pane geometry up through `App.tsx` to send
/// it back down is worse than one module-level signal in the store that already
/// owns activity.
const [worktreeMarks, setWorktreeMarks] = createSignal<ReadonlyMap<string, ActivitySignal>>(
  new Map(),
  {
    // Maps compare by identity, so without this every recompute of the
    // escalation memo would notify the rail even when nothing changed. The
    // comparison is over ids and marks because that is all the rail renders.
    equals: (a, b) =>
      a.size === b.size && [...a].every(([id, mark]) => b.get(id) === mark),
  },
);

export const worktreeActivity = worktreeMarks;

export function publishWorktreeActivity(
  value: ReadonlyMap<string, ActivitySignal>,
): void {
  setWorktreeMarks(value);
}

/// The mark for one worktree's rail row, or `undefined` when it is quiet.
export function worktreeMark(worktreeId: string): ActivitySignal | undefined {
  return worktreeMarks().get(worktreeId);
}

/// Per-view marks, published by `MainSurface` and read by `ViewSwitcher`.
///
/// Same reasoning as `worktreeActivity`: the switcher lives in the title bar
/// and the pane geometry `escalate` needs lives three levels down, with no
/// shared ancestor that knows both.
///
/// Only ever non-empty in stacked mode. In detached mode the satellites are
/// windows, each escalating to its own status bar, and there is no switcher.
const [viewMarks, setViewMarks] = createSignal<ReadonlyMap<StackedView, ActivitySignal>>(
  new Map(),
  {
    equals: (a, b) =>
      a.size === b.size && [...a].every(([id, mark]) => b.get(id) === mark),
  },
);

export const viewActivity = viewMarks;

export function publishViewActivity(
  value: ReadonlyMap<StackedView, ActivitySignal>,
): void {
  setViewMarks(value);
}

/// The mark for one segment of the view switcher, or `undefined` when that
/// view has nothing to report.
export function viewMark(view: StackedView): ActivitySignal | undefined {
  return viewMarks().get(view);
}

/// The status-bar half: set only while the rail is hidden. See
/// `Escalation.worktreeStatusBar`.
const [hiddenWorktrees, setHiddenWorktrees] = createSignal<Escalation["worktreeStatusBar"]>(
  null,
  {
    equals: (a, b) =>
      a?.signal === b?.signal && a?.worktreeIds.length === b?.worktreeIds.length,
  },
);

export const hiddenWorktreeActivity = hiddenWorktrees;

export function publishHiddenWorktreeActivity(
  value: Escalation["worktreeStatusBar"],
): void {
  setHiddenWorktrees(value);
}
