/// ⌘⇧E — go to an open tab by name.
///
/// The sibling of `Ctrl+Tab`: that one is recency with no typing, this one is
/// name with no memory of order. Both are the same list of tabs; only the way
/// in differs, which is why neither reimplements the other's overlay.
///
/// Same chrome, same fuzzy matcher and the same `bg-primary/15` highlight as
/// the palette, the file finder and the worktree switcher.
import { Show, createMemo, createSignal } from "solid-js";
import { LayoutGrid } from "lucide-solid";
import { bestFuzzyMatch, type MatchRange } from "@/commands/fuzzy";
import { FuzzyText, QuickPick, QuickPickEmpty, QuickPickRow } from "@/commands/QuickPick";
import { TabKindIcon } from "@/commands/TabCycleOverlay";
import { closeTabSwitcher, isTabSwitcherOpen } from "@/commands/registry";
import type { OpenTabTarget } from "@/commands/targets";

interface Row {
  target: OpenTabTarget;
  score: number;
  ranges: MatchRange[];
}

export function TabSwitcher(props: { tabs: () => OpenTabTarget[] }) {
  return (
    <Show when={isTabSwitcherOpen()}>
      <SwitcherContent tabs={props.tabs} />
    </Show>
  );
}

function SwitcherContent(props: { tabs: () => OpenTabTarget[] }) {
  const [query, setQuery] = createSignal("");

  const rows = createMemo<Row[]>(() => {
    const q = query().trim();
    const out: Row[] = [];
    for (const target of props.tabs()) {
      const match = bestFuzzyMatch([target.label, target.detail ?? ""], q);
      if (!match) continue;
      out.push({
        target,
        // Only a label hit is tinted; highlighting the detail column would mark
        // characters in text the row does not lead with.
        ranges: match.field === 0 ? match.match.ranges : [],
        score: match.match.score,
      });
    }
    // With no query the list keeps strip order, so the switcher reads like the
    // tab bar rather than like a second, differently-sorted view of it.
    return q ? out.sort((a, b) => b.score - a.score) : out;
  });

  function pick(row: Row) {
    closeTabSwitcher();
    row.target.open();
  }

  return (
    <QuickPick
      items={rows()}
      itemKey={(row) => row.target.id}
      query={query()}
      onQuery={setQuery}
      onPick={pick}
      onClose={closeTabSwitcher}
      label="Go to open tab"
      placeholder="Go to an open tab…"
      empty={
        <QuickPickEmpty
          icon={<LayoutGrid class="w-5 h-5" />}
          message="Nothing open matches that."
          hint="⌘K searches recently closed files too."
        />
      }
      renderItem={(row, highlighted) => (
        <QuickPickRow highlighted={highlighted()}>
          <TabKindIcon kind={row.target.kind} />
          <FuzzyText text={row.target.label} ranges={row.ranges} class="truncate" />
          <Show when={row.target.detail}>
            {(d) => (
              <span class="ml-2 text-label text-muted-foreground/70 truncate font-mono">
                {d()}
              </span>
            )}
          </Show>
        </QuickPickRow>
      )}
    />
  );
}
