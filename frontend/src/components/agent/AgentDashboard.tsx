/// The Agent Dashboard: one board answering "which agent needs me right now?"
/// across every worktree in the active workspace.
///
/// **Renders. Decides nothing.** The columns, the thirty-minute threshold and
/// the "is this even an agent" filter are all in `agentBoard.ts`, which is pure
/// and tested; the session list is `store/agentSessions.ts`. This file turns
/// that into pixels and a click.
///
/// ## Why the columns stack instead of sitting side by side
///
/// A four-column board wants ~600px. The sidebar is 180–520 and usually 256, so
/// a literal left-to-right kanban here would render four columns of two
/// truncated words each — the layout would be a kanban and the information
/// would not. Stacked column groups with sticky headers is the same board at
/// this width: the grouping, the order and the counts all survive, and each
/// card gets the full column to say which worktree it is in, which is the field
/// that actually distinguishes the rows.
///
/// The section chrome is `LineupSection`'s, deliberately — sticky uppercase
/// group header, full-width button rows, a right-hand rail of dim metadata.
/// This is a second grouped board in the same app and it should not look like a
/// different product.
import { For, Show, createMemo } from "solid-js";
import { Bot } from "lucide-solid";
import { useAppStore } from "@/store/LayoutContext";
import { useSettings } from "@/store/settings";
import { useAgentSessions } from "@/store/agentSessions";
import { StatusLed, ledLabel } from "@/components/layout/StatusLed";
import {
  AGENT_COLUMNS,
  AGENT_COLUMN_LABELS,
  AGENT_IDLE_MS,
  boardIsEmpty,
  buildAgentBoard,
  type AgentBoard,
  type AgentColumn,
  type AgentSession,
} from "./agentBoard";

/// What each column means, on its header's tooltip. The board is only legible
/// if "Done" and "Idle" are distinguishable without reading the source.
const COLUMN_HELP: Record<AgentColumn, string> = {
  needsYou: "Stopped on a permission prompt or a question. Nothing moves until you answer.",
  working: "Running right now — producing output.",
  done: "Finished or failed, and not yet reviewed. Never ages out of this column.",
  idle: `Quiet for ${Math.round(AGENT_IDLE_MS / 60_000)} minutes without reporting a result.`,
};

/// The mark a column's header wears. `needsYou` gets the amber question mark —
/// the same glyph the waiting state draws, not a bare number badge, because a
/// count with no vocabulary is one more thing to learn.
const COLUMN_SIGNAL = {
  needsYou: "waiting",
  working: "working",
  done: "finished",
  idle: "idle",
} as const;

/// The board, wired to the workbench's own session poll. What `App.tsx` and
/// `AgentsSidebar` render.
export function AgentDashboard(props: { class?: string }) {
  const { settings } = useSettings();
  const sessions = useAgentSessions();
  return (
    <AgentBoardView
      class={props.class}
      sessions={sessions}
      showIdle={() => settings.experimental.showIdleAgents}
    />
  );
}

/// The board, minus any assumption about where its sessions come from.
///
/// Same split as `GitSurface` under `GitApp`, and for the same reason: the
/// detached agents panel is a separate webview whose store has no terminals in
/// it, so it cannot run `useAgentSessions` — it renders the workbench's
/// `AgentBoardSnapshot` off the wire instead. One component either way, so the
/// two cannot drift.
///
/// `buildAgentBoard` runs *here*, against this window's clock, rather than
/// arriving pre-derived: the idle threshold is relative to now, and a board
/// derived when the snapshot was sent would freeze at whatever "now" was then.
/// That is why the snapshot carries sessions and not columns.
export function AgentBoardView(props: {
  class?: string;
  sessions: () => AgentSession[];
  showIdle: () => boolean;
}) {
  const board = createMemo(() =>
    buildAgentBoard({
      sessions: props.sessions(),
      now: Date.now(),
      showIdle: props.showIdle(),
    }),
  );

  return (
    <div class={`flex flex-col min-h-0 ${props.class ?? ""}`}>
      <Show
        when={!boardIsEmpty(board())}
        fallback={
          <div class="px-3 py-6 text-center text-ui text-muted-foreground">
            <Bot class="w-4 h-4 mx-auto mb-1.5 opacity-60" />
            No agents running in this workspace.
          </div>
        }
      >
        <div class="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
          <For each={AGENT_COLUMNS}>
            {(column) => <BoardColumn column={column} board={board()} />}
          </For>
        </div>
      </Show>
    </div>
  );
}

function BoardColumn(props: { column: AgentColumn; board: AgentBoard }) {
  const cards = () => props.board[props.column];
  return (
    // An empty column is *absent*, not an empty box. Four permanently-visible
    // headings on a 256px sidebar is three headings of noise when only one has
    // anything under it — and the Idle column is absent entirely when the
    // nested flag is off, which is the same rule seen from the settings side.
    <Show when={cards().length > 0}>
      <section>
        <h3 class="sticky top-0 z-20 flex items-center gap-1.5 px-3 py-1 text-label font-medium uppercase tracking-wide text-muted-foreground bg-sidebar/95 backdrop-blur">
          <StatusLed signal={COLUMN_SIGNAL[props.column]} silent />
          <span class="flex-1 truncate" title={COLUMN_HELP[props.column]}>
            {AGENT_COLUMN_LABELS[props.column]}
          </span>
          <span class="shrink-0 tabular-nums text-micro">{cards().length}</span>
        </h3>
        <ul>
          <For each={cards()}>{(session) => <AgentCard session={session} />}</For>
        </ul>
      </section>
    </Show>
  );
}

/// One agent. Clicking it goes there — read and navigate, nothing else. There
/// is deliberately no answer, stop or restart affordance: a permission prompt
/// answered from a card is answered without the context that made it a
/// question, and the terminal is two pixels away.
function AgentCard(props: { session: AgentSession }) {
  const { state, actions } = useAppStore();

  const go = () => {
    // Both calls, in this order. `selectTerminal` writes the per-worktree
    // active item without switching worktrees, so on its own it would focus a
    // tab in a worktree the user cannot see.
    if (props.session.worktreeId !== state.activeWorktreeId) {
      actions.selectWorktree(props.session.worktreeId);
    }
    actions.selectTerminal(props.session.worktreeId, props.session.tabId);
  };

  const name = () => props.session.agent ?? props.session.label;

  return (
    <li>
      <button
        type="button"
        onClick={go}
        title={`${name()} in ${props.session.worktreeLabel} — ${props.session.label}`}
        aria-label={`${name()} in ${props.session.worktreeLabel}${
          props.session.signal ? `, ${ledLabel(props.session.signal)}` : ""
        }`}
        class="w-full flex items-center gap-2 px-3 py-1.5 text-left text-body hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <Show when={props.session.signal}>
          {(signal) => <StatusLed signal={signal()} density="comfortable" silent />}
        </Show>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-foreground">{name()}</span>
          <span class="block truncate text-micro text-muted-foreground">
            {props.session.worktreeLabel}
          </span>
        </span>
      </button>
    </li>
  );
}
