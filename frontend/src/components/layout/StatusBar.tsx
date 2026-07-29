/// The bottom bar: "what is the state of my repo, and of the panes I can't
/// see, right now".
///
/// It is a **registry**, not a row. Features contribute `StatusSegment`s with a
/// resting priority and the bar decides what fits; the ordering and overflow
/// rules live in `statusSegments.ts` as pure functions so they can be tested
/// without a layout engine.
///
/// The reason it stopped being a hardcoded row is §7.5.3's escalation rule.
/// The status bar is where a signal from a pane the user cannot see — a group
/// maximized away, or every group under zen — finally surfaces. That makes it
/// the one surface that must never drop its most important child on a narrow
/// window, which a `flex` row of `<Show>`s has no way to guarantee. The
/// background-activity segment therefore carries a live signal and sorts to the
/// front of the priority order for as long as it does.
///
/// It also keeps the two affordances that have to survive a chromeless window:
/// the zen and maximize chips, which name their own chord so the way out is
/// readable with no mouse and no menu.
import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js";
import { Portal } from "solid-js/web";
import {
  Eye,
  EyeOff,
  GitBranch,
  GitCommit,
  Layers,
  Loader2,
  Maximize2,
  MessageSquareWarning,
  Minimize2,
  MoreHorizontal,
  Sparkles,
  FileWarning,
} from "lucide-solid";
import { gitApi } from "@/api/git";
import { stackApi } from "@/api/stack";
import { isMac } from "@/api/platform";
import { useAppStore } from "@/store/LayoutContext";
import { aiCommitState } from "@/commands/aiCommit";
import { formatChord } from "@/commands/keys";
import { primaryChordFor } from "@/commands/keymap";
import { isZen, maximizedGroupId, toggleMaximizedGroup, toggleZen } from "@/store/focusMode";
import { blameEnabled, toggleBlame } from "@/components/editor/blameOverlay";
import { hiddenActivity } from "@/store/activity";
import { StatusLed } from "@/components/layout/StatusLed";
import {
  STATUS_PRIORITY,
  orderSegments,
  planOverflow,
  type StatusSegment,
} from "@/components/layout/statusSegments";
import {
  createFreshnessClock,
  freshnessClass,
  freshnessOf,
  freshnessTitle,
} from "@/components/layout/freshness";

/// The bar's own row classes. Exported because the editor window renders its
/// own, scoped status bar and has to match this one exactly — two bars of
/// different heights across two windows of the same app is the kind of seam
/// users notice without being able to name.
export const STATUS_BAR_ROW =
  "flex items-center h-6 px-2 gap-3 text-[11px] text-muted-foreground border-t border-border bg-sidebar shrink-0 select-none overflow-hidden";

/// One chip. Every status-bar control is this shape: `text-[10px]`, an optional
/// LED, an optional click action, and an accessible name whether or not the
/// visible content is text (§10.10).
export function StatusChip(props: {
  children: JSX.Element;
  onClick?: () => void;
  title?: string;
  label: string;
  tone?: "muted" | "primary" | "warning" | "destructive" | "success";
  class?: string;
}) {
  const tone = () => {
    switch (props.tone) {
      case "primary":
        return "text-primary bg-primary/10 hover:bg-primary/15";
      case "warning":
        return "text-warning hover:bg-accent/40";
      case "destructive":
        return "text-destructive hover:bg-accent/40";
      case "success":
        return "text-success hover:bg-accent/40";
      default:
        return "text-muted-foreground hover:text-foreground hover:bg-accent/40";
    }
  };
  const base =
    // `px`/`py` and the ring reservation are constant across every state —
    // §7.6's no-layout-shift rule. Only colour moves.
    "flex items-center gap-1 px-1.5 py-0.5 rounded shrink-0 whitespace-nowrap outline-2 outline-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <Show
      when={props.onClick}
      fallback={
        <span class={`${base} ${tone()} ${props.class ?? ""}`} title={props.title} aria-label={props.label}>
          {props.children}
        </span>
      }
    >
      <button
        onClick={props.onClick}
        title={props.title}
        aria-label={props.label}
        class={`${base} ${tone()} transition-colors ${props.class ?? ""}`}
      >
        {props.children}
      </button>
    </Show>
  );
}

/// The accelerator for an action, derived from the keymap so the label on
/// screen and the chord that fires can never disagree.
function chordLabel(actionId: string): string {
  const chord = primaryChordFor(actionId);
  return chord ? formatChord(chord, isMac()) : "";
}

export function StatusBar() {
  const { state, activeRepoPath } = useAppStore();
  const repoPath = () => activeRepoPath() ?? null;
  const now = createFreshnessClock();

  /// Tracks an external "refresh" event so the bar follows the same
  /// refetch cadence as the git sidebar.
  const [tick, setTick] = createSignal(0);
  onMount(() => {
    const onRefresh = () => setTick((t) => t + 1);
    window.addEventListener("voidlink:refresh-git", onRefresh);
    onCleanup(() => window.removeEventListener("voidlink:refresh-git", onRefresh));
  });

  const [info] = createResource(
    () => ({ path: repoPath(), tick: tick() }),
    async ({ path }) => (path ? await gitApi.repoInfo(path) : null),
  );

  /// When the repo info last landed. §7.5.4 needs an age, and a resource only
  /// exposes "loading" — nothing about how old the value underneath is.
  const [infoReadAt, setInfoReadAt] = createSignal<number | null>(null);
  createEffect(() => {
    if (!info.loading && info() !== undefined) setInfoReadAt(Date.now());
  });

  const infoFreshness = () =>
    freshnessOf({ loading: info.loading, readAt: infoReadAt(), now: now() });
  const freshTitle = () => freshnessTitle(infoFreshness(), infoReadAt(), now());

  /// Stack discovery is best-effort — many repos won't be on a stack.
  /// Errors silently degrade to no stack chip.
  const [stack] = createResource(
    () => ({ path: repoPath(), tick: tick(), branch: info()?.currentBranch ?? null }),
    async ({ path }) => {
      if (!path) return null;
      try {
        return await stackApi.current(path);
      } catch {
        return null;
      }
    },
  );

  const stackPosition = () => {
    const s = stack();
    const head = info()?.currentBranch;
    if (!s || !head) return null;
    const idx = s.branches.findIndex((b) => b.name === head);
    if (idx === -1) return null;
    return { position: idx + 1, total: s.branches.length, trunk: s.trunk };
  };

  const aiDraft = () => {
    const s = aiCommitState();
    if (s.kind === "drafting" && s.repoPath === repoPath()) {
      return { state: "drafting" as const };
    }
    if (s.kind === "error" && s.repoPath === repoPath()) {
      return { state: "error" as const, reason: s.reason };
    }
    return null;
  };

  // ── The segments ─────────────────────────────────────────────────────────

  const segments = createMemo<StatusSegment[]>(() => {
    const out: StatusSegment[] = [];
    const repoInfo = info();

    // The last stop for §7.5.3. First in the list and, because it carries a
    // live signal, first in the priority order too — it is the one segment
    // that must never be the thing that collapses.
    const hidden = hiddenActivity();
    if (hidden) {
      const count = hidden.tabIds.length;
      out.push({
        id: "background-activity",
        priority: STATUS_PRIORITY.backgroundActivity,
        align: "start",
        signal: hidden.signal,
        label: `${count} hidden ${count === 1 ? "pane" : "panes"} — ${hidden.signal}`,
        title: isZen()
          ? `Zen mode is hiding ${count} pane${count === 1 ? "" : "s"} with activity`
          : `${count} pane${count === 1 ? "" : "s"} you can't see reported: ${hidden.signal}`,
        render: () => (
          <>
            <StatusLed signal={hidden.signal} silent />
            <span class="tracking-wide">
              {count} hidden {count === 1 ? "pane" : "panes"}
            </span>
          </>
        ),
      });
    }

    if (repoInfo) {
      out.push({
        id: "branch",
        priority: STATUS_PRIORITY.branch,
        align: "start",
        label: `Branch ${repoInfo.currentBranch ?? "unknown"}`,
        title: repoInfo.upstream ?? "no upstream",
        render: () => (
          <>
            <GitBranch class="w-3 h-3" />
            <span class="font-mono">
              {repoInfo.isDetached
                ? `(detached ${repoInfo.headOid?.slice(0, 7) ?? "?"})`
                : repoInfo.currentBranch ?? "unknown"}
            </span>
          </>
        ),
      });

      if (repoInfo.ahead > 0 || repoInfo.behind > 0) {
        out.push({
          id: "ahead-behind",
          priority: STATUS_PRIORITY.aheadBehind,
          align: "start",
          label: `${repoInfo.ahead} ahead, ${repoInfo.behind} behind`,
          title: freshTitle() || (repoInfo.upstream ?? "no upstream"),
          render: () => (
            // §7.5.4: the freshness class goes on the *value*, so the number
            // itself ghosts or pulses. A count from four minutes ago rendered
            // like one from four milliseconds ago is the failure the whole
            // contract exists to prevent.
            <span class={`flex items-center gap-0.5 font-mono tabular-nums ${freshnessClass(infoFreshness())}`}>
              <Show when={repoInfo.ahead > 0}>
                <span class="text-success">↑{repoInfo.ahead}</span>
              </Show>
              <Show when={repoInfo.behind > 0}>
                <span class="text-destructive">↓{repoInfo.behind}</span>
              </Show>
            </span>
          ),
        });
      }

      if (!repoInfo.isClean) {
        out.push({
          id: "dirty",
          priority: STATUS_PRIORITY.dirty,
          align: "start",
          label: "Working tree has uncommitted changes",
          title: freshTitle() || "Working tree has uncommitted changes",
          render: () => (
            <>
              <GitCommit class="w-3 h-3" />
              <span class={freshnessClass(infoFreshness())}>dirty</span>
            </>
          ),
        });
      }
    }

    const pos = stackPosition();
    if (pos) {
      out.push({
        id: "stack",
        priority: STATUS_PRIORITY.stack,
        align: "start",
        label: `Stack position ${pos.position} of ${pos.total}`,
        title: `Stack rooted at ${pos.trunk}`,
        render: () => (
          <>
            <Layers class="w-3 h-3" />
            <span class="font-mono tabular-nums">
              stack {pos.position}/{pos.total}
            </span>
          </>
        ),
      });
    }

    const draft = aiDraft();
    if (draft) {
      out.push({
        id: "ai-draft",
        priority: STATUS_PRIORITY.aiDraft,
        align: "start",
        // A draft in flight is a §7.5.2 "> 3s, backgroundable" operation that
        // was handed to the status bar, so it counts as live activity and
        // sorts with the escalation traffic rather than with the counters.
        signal: draft.state === "error" ? "failed" : "running",
        label: draft.state === "error" ? "AI commit draft failed" : "Drafting commit message",
        title: draft.state === "error" ? draft.reason : "Drafting commit message…",
        render: () =>
          draft.state === "error" ? (
            <>
              <FileWarning class="w-3 h-3" />
              AI draft failed
            </>
          ) : (
            <>
              <Loader2 class="w-3 h-3 animate-spin" />
              <Sparkles class="w-3 h-3" />
              Drafting commit…
            </>
          ),
      });
    }

    // The way out of a focus mode.
    // A user who hits the chord by accident has just lost the rail, both
    // sidebars and every tab strip; the status bar is the one surface that
    // stays, so it carries the mode's name *and* its chord. Naming the chord
    // is what makes the exit reachable with no mouse — clicking the chip is
    // the fallback, not the affordance. Its priority is second only to
    // escalated activity for exactly that reason.
    const maxGroup = maximizedGroupId();
    if (maxGroup) {
      out.push({
        id: "maximized",
        priority: STATUS_PRIORITY.focusMode,
        align: "end",
        label: "Pane maximized — restore the split",
        title: `Pane maximized — press ${chordLabel("ui.maximize-pane")} to restore the split`,
        onClick: () => toggleMaximizedGroup(maxGroup),
        render: () => (
          <>
            <Minimize2 class="w-3 h-3" />
            <span class="text-[10px] tracking-wide">Maximized · {chordLabel("ui.maximize-pane")}</span>
          </>
        ),
      });
    }
    if (isZen()) {
      out.push({
        id: "zen",
        priority: STATUS_PRIORITY.focusMode,
        align: "end",
        label: "Zen mode — bring the shell back",
        title: `Zen mode — press ${chordLabel("ui.zen")} to bring the shell back`,
        onClick: toggleZen,
        render: () => (
          <>
            <Maximize2 class="w-3 h-3" />
            <span class="text-[10px] tracking-wide">Zen · {chordLabel("ui.zen")}</span>
          </>
        ),
      });
    }

    out.push({
      id: "blame",
      priority: STATUS_PRIORITY.blame,
      align: "end",
      label: "Toggle inline blame",
      title: blameEnabled() ? "Inline blame: on (click to disable)" : "Inline blame: off (click to enable)",
      onClick: toggleBlame,
      render: () => (
        <>
          <Show when={blameEnabled()} fallback={<EyeOff class="w-3 h-3" />}>
            <Eye class="w-3 h-3" />
          </Show>
          <span class="text-[10px] tracking-wide">Blame</span>
        </>
      ),
    });

    out.push({
      id: "workspaces",
      priority: STATUS_PRIORITY.workspaces,
      align: "end",
      label: `${state.workspaces.length} workspaces open`,
      render: () => (
        <span class="opacity-60 font-mono">
          {state.workspaces.length} workspace{state.workspaces.length === 1 ? "" : "s"}
        </span>
      ),
    });

    return out;
  });

  const ordered = createMemo(() => orderSegments(segments()));

  // ── Overflow ─────────────────────────────────────────────────────────────
  // Widths are measured from the rendered chips and cached by id, because a
  // segment that has collapsed into the popover measures zero and would
  // immediately look like it fits again. The cache is what stops the bar
  // oscillating at the threshold.

  let rowRef: HTMLDivElement | undefined;
  const widths = new Map<string, number>();
  const [available, setAvailable] = createSignal(Number.POSITIVE_INFINITY);
  const [measureTick, setMeasureTick] = createSignal(0);

  /// The `⋯` button's own cost, only charged when something collapses.
  const OVERFLOW_WIDTH = 28;
  /// The spacer between the two sides never goes below this, so the bar can't
  /// pack itself edge to edge.
  const SPACER_MIN = 12;

  function measureChip(id: string, el: HTMLElement) {
    const w = el.getBoundingClientRect().width;
    // Chips are laid out with `gap-3` (12px); charge each one its own gap so
    // the plan matches what flexbox will actually do.
    const next = Math.ceil(w) + 12;
    if (w > 0 && widths.get(id) !== next) {
      widths.set(id, next);
      setMeasureTick((t) => t + 1);
    }
  }

  onMount(() => {
    if (!rowRef) return;
    const ro = new ResizeObserver(() => {
      if (rowRef) setAvailable(rowRef.clientWidth - SPACER_MIN);
    });
    ro.observe(rowRef);
    setAvailable(rowRef.clientWidth - SPACER_MIN);
    onCleanup(() => ro.disconnect());
  });

  const plan = createMemo(() => {
    void measureTick();
    return planOverflow(
      ordered().map((s) => ({ id: s.id, width: widths.get(s.id) ?? 0 })),
      available(),
      OVERFLOW_WIDTH,
    );
  });

  const visibleIds = () => new Set(plan().visible);
  const collapsed = () => {
    const byId = new Map(segments().map((s) => [s.id, s]));
    return plan()
      .collapsed.map((id) => byId.get(id))
      .filter((s): s is StatusSegment => !!s);
  };
  const side = (align: "start" | "end") =>
    ordered().filter((s) => s.align === align && visibleIds().has(s.id));

  /// §10.10 — a badge that only exists visually is not proactive for a screen
  /// reader user. This is the ambient channel's announcement: it names what
  /// happened in the pane the user cannot see, once, when it changes.
  const announcement = () => {
    const hidden = hiddenActivity();
    if (!hidden) return "";
    const count = hidden.tabIds.length;
    return `${hidden.signal} in ${count} background ${count === 1 ? "pane" : "panes"}`;
  };

  return (
    <div
      ref={(el) => (rowRef = el)}
      class={STATUS_BAR_ROW}
      role="status"
      aria-label="Repository status"
    >
      <Show when={repoPath()} fallback={<span class="opacity-60 shrink-0">No repository</span>}>
        <For each={side("start")}>
          {(seg) => <RenderedSegment segment={seg} onMeasure={measureChip} />}
        </For>
      </Show>

      <span class="flex-1 min-w-3" />

      <Show when={collapsed().length > 0}>
        <OverflowMenu segments={collapsed()} />
      </Show>

      <For each={side("end")}>
        {(seg) => <RenderedSegment segment={seg} onMeasure={measureChip} />}
      </For>

      {/* Off-screen, polite, and outside the bar's own `role="status"` so a
          reader announces the change rather than re-reading the whole row. */}
      <span class="sr-only" aria-live="polite" aria-atomic="true">
        {announcement()}
      </span>
    </div>
  );
}

function RenderedSegment(props: {
  segment: StatusSegment;
  onMeasure: (id: string, el: HTMLElement) => void;
}) {
  let ref: HTMLSpanElement | undefined;
  onMount(() => {
    if (!ref) return;
    props.onMeasure(props.segment.id, ref);
    const ro = new ResizeObserver(() => ref && props.onMeasure(props.segment.id, ref));
    ro.observe(ref);
    onCleanup(() => ro.disconnect());
  });
  return (
    <span ref={(el) => (ref = el)} class="shrink-0 inline-flex">
      <StatusChip
        onClick={props.segment.onClick}
        title={props.segment.title}
        label={props.segment.label}
        tone={props.segment.signal ? "primary" : "muted"}
      >
        {props.segment.render()}
      </StatusChip>
    </span>
  );
}

/// Everything that did not fit, in priority order. A popover rather than
/// truncation: §7.1's <5×-per-session budget covers the enter, and truncating
/// a segment's text to fit would make it unreadable, which is the one thing
/// the overflow rule forbids.
function OverflowMenu(props: { segments: StatusSegment[] }) {
  let btnRef: HTMLButtonElement | undefined;
  let panelRef: HTMLDivElement | undefined;
  const [open, setOpen] = createSignal(false);
  const [pos, setPos] = createSignal({ left: 0, bottom: 0 });

  function reposition() {
    if (!btnRef) return;
    const r = btnRef.getBoundingClientRect();
    const width = 240;
    const pad = 6;
    let left = r.right - width;
    if (left < pad) left = pad;
    setPos({ left, bottom: window.innerHeight - r.top + 4 });
  }

  onMount(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!open()) return;
      const target = e.target as Node;
      if (btnRef?.contains(target) || panelRef?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (open() && e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    });
  });

  createEffect(() => {
    if (open()) queueMicrotask(reposition);
  });

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        aria-label={`${props.segments.length} more status items`}
        aria-haspopup="menu"
        aria-expanded={open()}
        title={props.segments.map((s) => s.label).join(" · ")}
        class="shrink-0 px-1 py-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <MoreHorizontal class="w-3.5 h-3.5" />
      </button>
      <Show when={open()}>
        <Portal>
          <div
            ref={panelRef}
            role="menu"
            class="fixed w-[240px] rounded-md border border-border bg-popover text-popover-foreground shadow-lg z-[9999] py-1 text-[11px]"
            style={{ left: `${pos().left}px`, bottom: `${pos().bottom}px` }}
          >
            <For each={props.segments}>
              {(seg) => (
                <button
                  role="menuitem"
                  onClick={() => {
                    seg.onClick?.();
                    setOpen(false);
                  }}
                  title={seg.title}
                  class="w-full flex items-center gap-2 px-3 py-1 text-left text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <Show when={seg.signal} fallback={<MessageSquareWarning class="w-3 h-3 opacity-0" />}>
                    {(s) => <StatusLed signal={s()} silent />}
                  </Show>
                  <span class="flex-1 truncate">{seg.label}</span>
                </button>
              )}
            </For>
          </div>
        </Portal>
      </Show>
    </>
  );
}
