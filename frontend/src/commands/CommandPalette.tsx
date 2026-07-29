/// ⌘K — actions, open tabs and recent files in one list.
///
/// Three things make it feel different from the list-of-everything it was:
///
///   1. **Recently-used first.** Actions the user ran this session float to the
///      top of the resting list. The order is snapshotted when the palette
///      opens and held for as long as it is on screen — reordering rows under
///      a user who is halfway through a muscle-memory press is worse than not
///      ranking at all.
///   2. **A `>`-free default mode.** With no prefix the list mixes actions with
///      what is already open and what was recently closed, so ⌘K is "go to the
///      thing" as well as "run the thing". A leading `>` narrows to actions,
///      the convention every editor shares.
///   3. **Match ranges, not just scores.** `fuzzy.ts` returns which characters
///      matched and `FuzzyText` tints them, using the same treatment as the
///      file finder and both switchers.
///
/// Chrome, keyboard navigation and the highlight all come from `QuickPick.tsx`.
/// Nothing here animates: ⌘K is keyboard-initiated (MASTER §7.1).
import { Show, createMemo, createSignal } from "solid-js";
import { FileClock, SearchX } from "lucide-solid";
import {
  type Action,
  closePalette,
  getVisibleActions,
  isPaletteOpen,
  recentActionOrder,
  runAction,
} from "@/commands/registry";
import { bestFuzzyMatch, type MatchRange } from "@/commands/fuzzy";
import { FuzzyText, QuickPick, QuickPickEmpty, QuickPickRow } from "@/commands/QuickPick";
import { TabKindIcon } from "@/commands/TabCycleOverlay";
import { shortcutLabel } from "@/commands/shortcuts";
import type { OpenTabTarget, RecentFileTarget } from "@/commands/targets";

export interface CommandPaletteProps {
  /// Open tabs to mix into the default mode. Omitted in windows that have none.
  openTabs?: () => OpenTabTarget[];
  recentFiles?: () => RecentFileTarget[];
}

type Row =
  | { sort: "action"; key: string; action: Action; score: number; ranges: MatchRange[] }
  | { sort: "tab"; key: string; tab: OpenTabTarget; score: number; ranges: MatchRange[] }
  | { sort: "file"; key: string; file: RecentFileTarget; score: number; ranges: MatchRange[] };

export function CommandPalette(props: CommandPaletteProps) {
  return (
    <Show when={isPaletteOpen()}>
      <PaletteContent openTabs={props.openTabs} recentFiles={props.recentFiles} />
    </Show>
  );
}

function PaletteContent(props: CommandPaletteProps) {
  const [query, setQuery] = createSignal("");

  /// Captured once, on mount. See the module comment — this is the "stable
  /// within a session" requirement, and it is why this is a plain array rather
  /// than a call to `recentActionOrder()` inside the memo.
  const recency = new Map(recentActionOrder().map((id, i) => [id, i]));

  /// `>` narrows to actions. Everything after it is the real query.
  const actionsOnly = () => query().trimStart().startsWith(">");
  const term = () => {
    const raw = query().trimStart();
    return (actionsOnly() ? raw.slice(1) : raw).trim();
  };

  /// Actions first in the resting list, recency-ordered, then everything else in
  /// registration order. With a query, score decides and recency only breaks
  /// ties — otherwise a stale favourite would outrank an exact match.
  const rows = createMemo<Row[]>(() => {
    const q = term();
    const out: Row[] = [];

    for (const action of getVisibleActions()) {
      const match = bestFuzzyMatch([action.label, action.group ?? ""], q);
      if (!match) continue;
      out.push({
        sort: "action",
        key: `a:${action.id}`,
        action,
        // Only a label match is worth highlighting; a hit on the group column
        // would tint text the user did not type against.
        ranges: match.field === 0 ? match.match.ranges : [],
        score: match.match.score,
      });
    }

    if (!actionsOnly()) {
      for (const tab of props.openTabs?.() ?? []) {
        const match = bestFuzzyMatch([tab.label, tab.detail ?? ""], q);
        if (!match) continue;
        out.push({
          sort: "tab",
          key: `t:${tab.id}`,
          tab,
          ranges: match.field === 0 ? match.match.ranges : [],
          score: match.match.score,
        });
      }
      for (const file of props.recentFiles?.() ?? []) {
        const match = bestFuzzyMatch([file.label, file.path], q, { pathAware: true });
        if (!match) continue;
        out.push({
          sort: "file",
          key: `f:${file.path}`,
          file,
          ranges: match.field === 0 ? match.match.ranges : [],
          score: match.match.score,
        });
      }
    }

    const rank = (row: Row) =>
      row.sort === "action" ? (recency.get(row.action.id) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;

    if (!q) {
      // Resting order: recently-used actions, then open tabs (the thing you are
      // most likely to want to get back to), then the rest.
      const bucket = (row: Row) =>
        row.sort === "action" && recency.has(row.action.id) ? 0 : row.sort === "tab" ? 1 : 2;
      return out.sort((a, b) => bucket(a) - bucket(b) || rank(a) - rank(b));
    }
    return out.sort((a, b) => b.score - a.score || rank(a) - rank(b));
  });

  function pick(row: Row) {
    if (row.sort === "action") {
      if (row.action.enabled && !row.action.enabled()) return;
      closePalette();
      void runAction(row.action);
      return;
    }
    closePalette();
    if (row.sort === "tab") row.tab.open();
    else row.file.open();
  }

  return (
    <QuickPick
      items={rows()}
      itemKey={(row) => row.key}
      query={query()}
      onQuery={setQuery}
      onPick={pick}
      onClose={closePalette}
      label="Command palette"
      width="w-[560px]"
      placeholder="Search commands, open tabs and recent files… (> for commands only)"
      empty={
        <QuickPickEmpty
          icon={<SearchX class="w-5 h-5" />}
          message="Nothing matches that."
          hint={actionsOnly() ? undefined : "Drop the > to search open tabs and recent files too."}
        />
      }
      renderItem={(row, highlighted) => <PaletteRow row={row} highlighted={highlighted()} />}
    />
  );
}

function PaletteRow(props: { row: Row; highlighted: boolean }) {
  const disabled = () =>
    props.row.sort === "action" && !!props.row.action.enabled && !props.row.action.enabled();

  return (
    <QuickPickRow
      highlighted={props.highlighted}
      disabled={disabled()}
      disabledReason="Not available in this context — open a repository first"
    >
      <Show when={props.row.sort === "action" ? props.row : undefined}>
        {(row) => (
          <>
            <span class="text-[10px] tracking-wide text-muted-foreground/70 w-16 shrink-0 truncate">
              {row().action.group ?? ""}
            </span>
            <span class="flex-1 truncate">
              <FuzzyText text={row().action.label} ranges={row().ranges} />
              <Show when={row().action.description}>
                {(d) => <span class="ml-2 text-[11px] text-muted-foreground/80">· {d()}</span>}
              </Show>
            </span>
            <Accelerator actionId={row().action.id} />
          </>
        )}
      </Show>

      <Show when={props.row.sort === "tab" ? props.row : undefined}>
        {(row) => (
          <>
            <span class="text-[10px] tracking-wide text-muted-foreground/70 w-16 shrink-0 truncate">
              open
            </span>
            <TabKindIcon kind={row().tab.kind} />
            <span class="flex-1 truncate">
              <FuzzyText text={row().tab.label} ranges={row().ranges} />
              <Show when={row().tab.detail}>
                {(d) => <span class="ml-2 text-[11px] text-muted-foreground/80">· {d()}</span>}
              </Show>
            </span>
          </>
        )}
      </Show>

      <Show when={props.row.sort === "file" ? props.row : undefined}>
        {(row) => (
          <>
            <span class="text-[10px] tracking-wide text-muted-foreground/70 w-16 shrink-0 truncate">
              recent
            </span>
            <FileClock class="w-3.5 h-3.5 shrink-0 opacity-60" />
            <span class="flex-1 truncate">
              <FuzzyText text={row().file.label} ranges={row().ranges} />
              <span class="ml-2 text-[11px] text-muted-foreground/80 font-mono">
                {row().file.path}
              </span>
            </span>
          </>
        )}
      </Show>
    </QuickPickRow>
  );
}

/// Derived from the keymap, never stored on the action — the label and the
/// chord that actually fires cannot disagree.
function Accelerator(props: { actionId: string }) {
  const label = () => shortcutLabel(props.actionId);
  return (
    <Show when={label()}>
      {(s) => (
        <span class="ml-auto shrink-0 text-right text-[10px] text-muted-foreground font-mono tracking-wide">
          {s()}
        </span>
      )}
    </Show>
  );
}
