import { For, Show, createSignal } from "solid-js";
import { LineupSection } from "./LineupSection";
import { CheckinSection } from "./CheckinSection";
import { HillsSection } from "./HillsSection";
import { RunsSection } from "./RunsSection";
import { TriggersSection } from "./TriggersSection";
import type { LineupRow } from "./lineupModel";
import type { RunLeg } from "@/store/fanout";

/// Mission Control — the cross-cutting view, in five sections.
///
/// ## Why one tab and not five
///
/// The Lineup, the check-in and the hill charts are one page in Basecamp too,
/// and the reason holds here: they are answers to one question — *where does
/// everything stand* — separated only by time horizon. The Lineup is now,
/// the check-in is the last day or week, the hills are the cycle. Runs joined
/// them because a fan-out in flight is the same question with the difference
/// that you started it deliberately, and Triggers because a rule is the same
/// question asked in advance. Five singleton tab kinds would mean five entries
/// in the palette, five rows in every snapshot, and a user deciding which of
/// five things to open before knowing which one answers their question.
///
/// It is also the honest boundary for what is *implemented*: each section is
/// small, and the shell below is a segmented control. If one section grows into
/// a surface of its own, promoting it is a smaller change than merging five
/// tab kinds would have been.
///
/// ## Scope
///
/// This is the first surface in the app that is **not** scoped to the active
/// worktree. The Lineup deliberately spans every workspace — that is the gap it
/// exists to close. The check-in defaults to the same breadth. The hills are
/// per workspace, because a scope belongs to a project.
interface MissionSurfaceProps {
  /// The workspace the hills section edits — the active one.
  workspaceId: string;
  /// The active checkout, for filing hill events under a repository.
  repoPath?: string;
  /// Open a checkout from the Lineup. Optional; without it the Lineup is a
  /// read-only board rather than a navigation surface.
  onOpen?: (row: LineupRow) => void;
  /// Open a fan-out leg's worktree for reading — a compare tab, in practice.
  onInspectLeg?: (leg: RunLeg) => void;
}

type Section = "lineup" | "checkin" | "runs" | "triggers" | "hills";

const SECTIONS: { value: Section; label: string }[] = [
  { value: "lineup", label: "Lineup" },
  { value: "checkin", label: "Check-in" },
  { value: "runs", label: "Runs" },
  { value: "triggers", label: "Triggers" },
  { value: "hills", label: "Hills" },
];

export function MissionSurface(props: MissionSurfaceProps) {
  const [section, setSection] = createSignal<Section>("lineup");

  return (
    <div class="flex flex-col h-full min-h-0 bg-background text-foreground">
      <header class="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
        <div
          class="flex items-center gap-0.5 rounded-md bg-muted/40 p-0.5"
          role="group"
          aria-label="Mission Control section"
        >
          <For each={SECTIONS}>
            {(option) => (
              <button
                type="button"
                aria-pressed={section() === option.value}
                onClick={() => setSection(option.value)}
                class="px-2 py-1 text-body rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                classList={{
                  "bg-background text-foreground shadow-sm": section() === option.value,
                  "text-muted-foreground hover:text-foreground": section() !== option.value,
                }}
              >
                {option.label}
              </button>
            )}
          </For>
        </div>
      </header>

      {/* Each section mounts only while selected. They poll and subscribe, and
          three live subscriptions where the user can read one is exactly the
          kind of cost that never shows up until somebody profiles it. */}
      <Show when={section() === "lineup"}>
        <LineupSection onOpen={props.onOpen} />
      </Show>
      <Show when={section() === "checkin"}>
        <CheckinSection />
      </Show>
      <Show when={section() === "runs"}>
        <RunsSection repoPath={props.repoPath} onInspect={props.onInspectLeg} />
      </Show>
      <Show when={section() === "triggers"}>
        <TriggersSection repoPath={props.repoPath} />
      </Show>
      <Show when={section() === "hills"}>
        <HillsSection workspaceId={props.workspaceId} repoPath={props.repoPath} />
      </Show>
    </div>
  );
}
