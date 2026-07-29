/// The `Ctrl+Tab` candidate list.
///
/// **This surface does not animate, in or out.** It is held-modifier UI shown
/// and dismissed dozens of times a session; a fade on the way in means the list
/// is still arriving when the second `Tab` lands, and `Ctrl+Tab` starts to feel
/// broken. MASTER.md §7.1 puts keyboard-initiated surfaces at 0ms and §11 lists
/// animating one as an anti-pattern. It appears on the same frame as the first
/// press, the selection moves instantly, and it is gone on the release. There is
/// no `transition` in this file — not on the panel, not on the rows.
///
/// It is also not interactive: there is nothing to click, because the modifier
/// is down and the pointer is not where the user's attention is. The list is
/// `aria-live="polite"` instead, so the selection is announced as it moves.
import { For, Match, Show, Switch } from "solid-js";
import { Portal } from "solid-js/web";
import {
  Brain,
  GitBranchPlus,
  GitCommitHorizontal,
  Globe,
  Layers,
  TerminalSquare,
} from "lucide-solid";
import { cycleCandidates, cycleIndex, isCycleOpen } from "@/commands/tabCycle";

/// The same glyph each kind wears in the tab strip — recognising a tab by its
/// icon is most of what makes a list of six labels readable at a glance.
export function TabKindIcon(props: { kind: string; class?: string }) {
  const cls = () => props.class ?? "w-3.5 h-3.5 shrink-0 opacity-70";
  return (
    <Switch fallback={<TerminalSquare class={cls()} />}>
      <Match when={props.kind === "compare"}>
        <GitBranchPlus class={cls()} />
      </Match>
      <Match when={props.kind === "stack"}>
        <Layers class={cls()} />
      </Match>
      <Match when={props.kind === "history"}>
        <GitCommitHorizontal class={cls()} />
      </Match>
      <Match when={props.kind === "brain"}>
        <Brain class={cls()} />
      </Match>
      <Match when={props.kind === "browser"}>
        <Globe class={cls()} />
      </Match>
    </Switch>
  );
}

export function TabCycleOverlay() {
  return (
    <Show when={isCycleOpen()}>
      <Portal>
        <div class="fixed inset-0 z-[var(--z-cycle)] flex items-center justify-center pointer-events-none">
          <div
            class="w-[320px] max-w-[80vw] bg-popover border border-border rounded-lg shadow-xl overflow-hidden"
            role="listbox"
            aria-label="Recently used tabs"
            aria-live="polite"
          >
            <div class="px-3 py-1.5 border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
              Recent tabs
            </div>
            <div class="py-1 max-h-[50vh] overflow-y-auto scrollbar-thin">
              <For each={cycleCandidates()}>
                {(candidate, i) => (
                  <div
                    role="option"
                    aria-selected={cycleIndex() === i()}
                    /// Selected uses the app's tinted-primary idiom (§11.5) and
                    /// carries a 1px border in *both* states, so moving the
                    /// selection costs no layout (§7.6).
                    class="flex items-center gap-2.5 px-3 py-1.5 text-[13px] border"
                    classList={{
                      "bg-primary/15 border-primary/40 text-primary": cycleIndex() === i(),
                      "border-transparent text-muted-foreground": cycleIndex() !== i(),
                    }}
                  >
                    <TabKindIcon kind={candidate.kind} />
                    <span class="truncate flex-1">{candidate.label}</span>
                  </div>
                )}
              </For>
            </div>
            <div class="px-3 py-1.5 border-t border-border text-[10px] text-muted-foreground">
              Hold Ctrl · Tab to cycle · release to switch
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  );
}
