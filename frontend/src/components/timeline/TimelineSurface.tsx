import { For, Show, createMemo, createResource, createSignal, onCleanup } from "solid-js";
import { Bot, RefreshCw, Search, User, Radio } from "lucide-solid";
import { journalApi, type Actor, type JournalEvent } from "@/api/journal";
import { onJournalAppended } from "@/store/journal";
import {
  ACTOR_LABELS,
  groupByDay,
  isInferred,
  matchesFilters,
  mergeEvents,
  timeLabel,
  type ActorFilter,
} from "./timelineModel";

/// The event log, rendered.
///
/// The first reader the log has ever had, and the reason it exists as a surface
/// rather than as a nicety: a schema nothing renders is a schema nobody has
/// checked. Every decision the Rust side makes — that `summary` is mandatory,
/// that `kind` is an open string, that agent credit is marked `inferred` — is
/// either vindicated or exposed here.
///
/// Which is why this renders **`summary` and nothing else** as the body of a
/// row. There is deliberately no per-kind renderer and no `switch` on `kind`:
/// the moment one exists, an event kind this build has never seen renders as a
/// blank row, and the log stops being forward-compatible. `kind` earns an icon
/// and a colour, both with a fallback; the words always come from `summary`.
///
/// Scope: this is a timeline, not Mission Control. It shows one repository —
/// the one the tab lives in — because a cross-repo view is Stage 3 and needs a
/// grouping model this does not have.
interface TimelineSurfaceProps {
  repoPath: string;
}

const ACTOR_FILTERS: { value: ActorFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "agent", label: "Agents" },
  { value: "user", label: "You" },
  { value: "system", label: "Observed" },
];

/// Colour per kind *family*, keyed by the first dotted segment.
///
/// The family and not the full kind, so `git.commit`, `git.branch.switched` and
/// a `git.` kind invented next year all land in the same visual bucket without
/// this table being updated. Anything unrecognised falls back to muted, which
/// is a legible row and not a missing one.
const FAMILY_COLORS: Record<string, string> = {
  git: "text-primary",
  agent: "text-info",
  terminal: "text-success",
};

function family(kind: string): string {
  return kind.split(".")[0] ?? "";
}

function ActorIcon(props: { actor: Actor }) {
  return (
    <Show
      when={props.actor !== "system"}
      fallback={<Radio class="w-3 h-3" aria-hidden="true" />}
    >
      <Show
        when={props.actor === "agent"}
        fallback={<User class="w-3 h-3" aria-hidden="true" />}
      >
        <Bot class="w-3 h-3" aria-hidden="true" />
      </Show>
    </Show>
  );
}

export function TimelineSurface(props: TimelineSurfaceProps) {
  const [actor, setActor] = createSignal<ActorFilter>("all");
  const [query, setQuery] = createSignal("");
  /// Events that arrived on the broadcast since the last fetch. Kept separate
  /// from the resource so a live event never has to re-run the query — see
  /// `events` below.
  const [live, setLive] = createSignal<JournalEvent[]>([]);

  const [fetched, { refetch }] = createResource(
    () => props.repoPath,
    async (repo): Promise<JournalEvent[]> => {
      if (!repo) return [];
      // No `since`: the whole retained window is what a timeline is for, and
      // Rust falls back to disk when its ring cannot answer.
      return await journalApi.query({ repo, limit: 500 });
    },
  );

  /// A refetch replaces the base list, so anything buffered from the broadcast
  /// is already in it — keeping it would show those events twice until the next
  /// mount. (`mergeEvents` would dedupe by id anyway; clearing keeps the buffer
  /// from growing for the life of the tab.)
  const reload = () => {
    setLive([]);
    void refetch();
  };

  onCleanup(
    onJournalAppended((incoming) => {
      const mine = incoming.filter((e) => e.repo === props.repoPath);
      if (mine.length === 0) return;
      setLive((current) => mergeEvents(current, mine));
    }),
  );

  /// Live events are appended rather than triggering a refetch: an agent turn
  /// finishing must not make the list the user is reading blank and rebuild
  /// itself (MASTER §7.5.2/§7.5.4 — never blank a rendered region to show it is
  /// updating).
  const events = createMemo(() => mergeEvents(fetched() ?? [], live()));

  const filters = createMemo(() => ({ actor: actor(), query: query() }));
  const sections = createMemo(() => groupByDay(events(), Date.now(), filters()));
  const total = createMemo(() => events().filter((e) => matchesFilters(e, filters())).length);

  return (
    <div class="flex flex-col h-full min-h-0 bg-background text-foreground">
      <header class="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
        <div class="flex items-center gap-0.5 rounded-md bg-muted/40 p-0.5" role="group" aria-label="Filter by who">
          <For each={ACTOR_FILTERS}>
            {(option) => (
              <button
                type="button"
                aria-pressed={actor() === option.value}
                onClick={() => setActor(option.value)}
                class="px-2 py-1 text-body rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                classList={{
                  "bg-background text-foreground shadow-sm": actor() === option.value,
                  "text-muted-foreground hover:text-foreground": actor() !== option.value,
                }}
              >
                {option.label}
              </button>
            )}
          </For>
        </div>

        <div class="relative flex-1 min-w-0">
          <Search
            class="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            placeholder="Filter events"
            aria-label="Filter events"
            class="w-full pl-7 pr-2 py-1 text-body bg-muted/40 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>

        <button
          type="button"
          onClick={reload}
          aria-label="Refresh the timeline"
          class="p-1 rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {/* `motion-loop` or this freezes on its last keyframe under reduced
              motion, taking the pending state's only visual channel with it. */}
          <RefreshCw class="w-3.5 h-3.5" classList={{ "animate-spin motion-loop": fetched.loading }} />
        </button>
      </header>

      <div class="flex-1 min-h-0 overflow-y-auto">
        {/* `fetched.loading` is true for refetches too, so this reads
            `fetched() === undefined` — the only state that is genuinely "nothing
            to show yet". A refetch keeps the previous list on screen. */}
        <Show
          when={fetched() !== undefined}
          fallback={<p class="p-4 text-body text-muted-foreground">Reading the event log…</p>}
        >
          <Show
            when={total() > 0}
            fallback={
              <p class="p-4 text-body text-muted-foreground">
                {events().length === 0
                  ? "Nothing recorded here yet. Commits, agent turns and long-running commands will appear as they happen."
                  : "No events match these filters."}
              </p>
            }
          >
            <For each={sections()}>
              {(section) => (
                <section>
                  <h2 class="sticky top-0 z-20 px-3 py-1 text-label font-medium uppercase tracking-wide text-muted-foreground bg-background/95 backdrop-blur">
                    {section.label}
                  </h2>
                  <ul>
                    <For each={section.events}>
                      {(event) => (
                        <li class="flex gap-2 px-3 py-1.5 hover:bg-muted/30">
                          <time
                            class="shrink-0 w-11 text-label tabular-nums text-muted-foreground pt-px"
                            dateTime={new Date(event.at).toISOString()}
                          >
                            {timeLabel(event.at)}
                          </time>
                          <div class="min-w-0 flex-1">
                            {/* The summary, and only the summary. See the
                                component comment for why there is no per-kind
                                renderer here. */}
                            <p class="text-body text-foreground break-words">{event.summary}</p>
                            <p class="flex items-center gap-1 text-label text-muted-foreground">
                              <span
                                class={FAMILY_COLORS[family(event.kind)] ?? "text-muted-foreground"}
                              >
                                {event.kind}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span class="inline-flex items-center gap-1">
                                <ActorIcon actor={event.actor} />
                                {event.actorName ?? ACTOR_LABELS[event.actor]}
                              </span>
                              <Show when={isInferred(event)}>
                                {/* Rust guessed this from an overlapping agent
                                    turn. Saying so is not a detail: a reader who
                                    cannot tell a guess from an observation will
                                    eventually act on one as the other. */}
                                <span
                                  class="px-1 rounded bg-muted text-micro"
                                  title="Credited to the agent that was running at the time — inferred, not observed"
                                >
                                  inferred
                                </span>
                              </Show>
                            </p>
                          </div>
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
    </div>
  );
}
