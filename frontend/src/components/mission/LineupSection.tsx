import { For, Show, createMemo, createResource, createSignal, onCleanup } from "solid-js";
import { Bot, GitCommitHorizontal, MessagesSquare } from "lucide-solid";
import { journalApi, type ActiveAgent, type JournalEvent, type RepoIdentity } from "@/api/journal";
import { onJournalAppended } from "@/store/journal";
import { mergeEvents } from "@/components/timeline/timelineModel";
import { buildLineup, rowStatus, type LineupRow } from "./lineupModel";

/// The Lineup — every checkout, every workspace, on one screen.
///
/// The gap this closes: nothing in this app could answer "what is happening
/// across all my work". The worktree rail answers it for the workspace you are
/// already looking at, which is the one case you did not need help with.
///
/// Two refresh rhythms, deliberately different:
///
///   - **Events append live.** The `journal-appended` broadcast carries the
///     events themselves, so an arriving commit updates a row without a query
///     and without blanking anything (MASTER §7.5.2).
///   - **Running agents are polled.** They are *live state* in Rust, not
///     entries in the log — turns are recorded on their end, so there is no
///     "started" event to listen for. A poll is the honest way to read state
///     that has no event.
interface LineupSectionProps {
  /// Where a click should take the reader. Optional: the section renders
  /// perfectly well as a read-only board.
  onOpen?: (row: LineupRow) => void;
}

/// How often running agents are re-read. Slow enough to be free, fast enough
/// that a turn you started in another window shows up before you wonder why it
/// has not.
const POLL_MS = 4_000;

/// How far back the counts look. A day is the unit a lineup is read in — "3
/// commits today" is a fact about now, where "3 commits ever" is trivia.
const WINDOW_MS = 86_400_000;

interface Snapshot {
  repos: RepoIdentity[];
  events: JournalEvent[];
  active: ActiveAgent[];
}

export function LineupSection(props: LineupSectionProps) {
  const [live, setLive] = createSignal<JournalEvent[]>([]);

  const [snapshot, { refetch }] = createResource(async (): Promise<Snapshot> => {
    const [repos, events, active] = await Promise.all([
      journalApi.repos(),
      journalApi.query({ since: Date.now() - WINDOW_MS, limit: 2000 }),
      journalApi.activeAgents(),
    ]);
    return { repos, events, active };
  });

  const timer = setInterval(() => {
    setLive([]);
    void refetch();
  }, POLL_MS);
  onCleanup(() => clearInterval(timer));

  onCleanup(
    onJournalAppended((incoming) => {
      if (incoming.length === 0) return;
      setLive((current) => mergeEvents(current, incoming));
    }),
  );

  const groups = createMemo(() => {
    const s = snapshot();
    if (!s) return [];
    return buildLineup(s.repos, mergeEvents(s.events, live()), s.active);
  });

  const now = Date.now();

  return (
    <div class="flex-1 min-h-0 overflow-y-auto">
      <Show
        when={snapshot() !== undefined}
        fallback={<p class="p-4 text-body text-muted-foreground">Reading every workspace…</p>}
      >
        <Show
          when={groups().length > 0}
          fallback={
            <p class="p-4 text-body text-muted-foreground">
              No workspaces are registered yet. Open a repository and it will appear here.
            </p>
          }
        >
          <For each={groups()}>
            {(group) => (
              <section>
                <h3 class="sticky top-0 z-20 flex items-center gap-2 px-3 py-1 text-label font-medium uppercase tracking-wide text-muted-foreground bg-background/95 backdrop-blur">
                  {group.workspaceName}
                  {/* A busy workspace has to say so even when its rows are
                      scrolled out of view — that is the whole point of the
                      surface. */}
                  <Show when={group.busy}>
                    <span class="inline-flex items-center gap-1 text-info normal-case">
                      <Bot class="w-3 h-3" aria-hidden="true" />
                      working
                    </span>
                  </Show>
                </h3>
                <ul>
                  <For each={group.rows}>
                    {(row) => (
                      <li>
                        <button
                          type="button"
                          disabled={!props.onOpen}
                          onClick={() => props.onOpen?.(row)}
                          class="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-muted/30 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span class="min-w-0 flex-1">
                            <span class="flex items-center gap-1.5">
                              <span class="text-body text-foreground truncate" title={row.repo}>
                                {row.label}
                              </span>
                              <Show when={row.isMain}>
                                <span class="px-1 rounded bg-muted text-micro text-muted-foreground">
                                  main
                                </span>
                              </Show>
                            </span>
                            <span
                              class="block text-label truncate"
                              classList={{
                                "text-info": row.active.length > 0,
                                "text-muted-foreground": row.active.length === 0,
                              }}
                            >
                              {rowStatus(row, now)}
                            </span>
                          </span>

                          <span class="shrink-0 flex items-center gap-2 text-label text-muted-foreground tabular-nums">
                            <Show when={row.commits > 0}>
                              <span
                                class="inline-flex items-center gap-0.5"
                                title={`${row.commits} commit(s) today`}
                              >
                                <GitCommitHorizontal class="w-3 h-3" aria-hidden="true" />
                                {row.commits}
                              </span>
                            </Show>
                            <Show when={row.turns > 0}>
                              <span
                                class="inline-flex items-center gap-0.5"
                                title={`${row.turns} agent turn(s) today`}
                              >
                                <MessagesSquare class="w-3 h-3" aria-hidden="true" />
                                {row.turns}
                              </span>
                            </Show>
                          </span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            )}
          </For>
        </Show>
      </Show>
    </div>
  );
}
