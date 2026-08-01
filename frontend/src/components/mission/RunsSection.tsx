import { For, Show, createMemo, createSignal } from "solid-js";
import { GitMerge, Loader2, Play, Trash2, X } from "lucide-solid";
import {
  adoptFanoutLeg,
  cancelFanoutLeg,
  compareLegs,
  discardFanoutLeg,
  fanoutRuns,
  isLegDone,
  removeFanoutRun,
  runProgress,
  startFanoutRun,
  type FanoutRun,
  type RunLeg,
} from "@/store/fanout";
import { agentRoster, resolveAgentCommand } from "@/store/settings";
import { RunMatrix } from "./RunMatrix";

/// Fan-out: one prompt, N agents, N worktrees, N diffs.
///
/// ## Why this lives in Mission Control
///
/// A run in flight is the same question the Lineup answers — *where does this
/// stand* — with the difference that you started it deliberately. Putting it
/// here rather than in its own tab means the surface that tells you three
/// agents are working is the surface that started them, and the alternative
/// (a fourth singleton tab kind) buys a separate pane and costs a second place
/// to look.
///
/// ## What this surface is careful about
///
/// **It never claims a leg is running when it is not.** A run now outlives the
/// window that started it — see `store/fanout.ts` and
/// `src-tauri/src/fanout/mod.rs` — but a leg the supervisor has no record of
/// at all (an old run, or an app restart) still comes back `interrupted`, and
/// says so in those words, rather than guessing it is still going.
///
/// **It does not pick a winner.** Legs are ordered largest-change-first, which
/// is a reading order and not a ranking; nothing here scores an answer. Adopting
/// is one explicit click on one leg, and it leaves the other worktrees intact.
interface RunsSectionProps {
  /// The repository runs are launched from and adopted into.
  repoPath?: string;
  /// Open a leg's worktree for reading — a compare tab, in practice.
  onInspect?: (leg: RunLeg) => void;
}

export function RunsSection(props: RunsSectionProps) {
  const [prompt, setPrompt] = createSignal("");
  const [chosen, setChosen] = createSignal<string[]>([]);
  const [launching, setLaunching] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const roster = createMemo(() => agentRoster());
  const runs = createMemo(() => (props.repoPath ? fanoutRuns(props.repoPath) : []));

  const toggle = (id: string) =>
    setChosen((current) =>
      current.includes(id) ? current.filter((c) => c !== id) : [...current, id],
    );

  const canLaunch = () =>
    !!props.repoPath && prompt().trim().length > 0 && chosen().length > 0 && !launching();

  async function launch(e: Event) {
    e.preventDefault();
    const repo = props.repoPath;
    if (!repo || !canLaunch()) return;
    const legs = chosen()
      .map((id) => roster().find((a) => a.id === id))
      .filter((a): a is NonNullable<typeof a> => !!a)
      .map((a) => ({
        agentId: a.id,
        agentName: a.name,
        commandTemplate: resolveAgentCommand(a),
      }));

    setLaunching(true);
    setError(null);
    try {
      // Deliberately not awaited into a spinner that blocks the form: the run
      // renders leg by leg as it goes, and the whole point is watching three
      // things happen at once.
      const id = await startFanoutRun({ repo, prompt: prompt(), legs });
      if (id) setPrompt("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLaunching(false);
    }
  }

  return (
    <div class="flex flex-col flex-1 min-h-0">
      <Show
        when={props.repoPath}
        fallback={
          <p class="p-4 text-body text-muted-foreground">
            Fan-out needs a repository. Point this workspace at one and it can send a prompt to
            several agents at once, each in its own worktree.
          </p>
        }
      >
        <form class="px-3 py-2 shrink-0 space-y-2" onSubmit={launch}>
          <textarea
            value={prompt()}
            onInput={(e) => setPrompt(e.currentTarget.value)}
            rows="2"
            placeholder="One prompt, several agents, one worktree each — then compare the diffs."
            aria-label="Fan-out prompt"
            class="w-full px-2 py-1 text-body bg-muted/40 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div class="flex items-center gap-2 flex-wrap">
            <div class="flex items-center gap-1 flex-wrap" role="group" aria-label="Agents to fan out to">
              <For each={roster()}>
                {(agent) => (
                  <button
                    type="button"
                    aria-pressed={chosen().includes(agent.id)}
                    onClick={() => toggle(agent.id)}
                    class="px-2 py-1 text-body rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    classList={{
                      "bg-primary/15 text-primary": chosen().includes(agent.id),
                      "bg-muted/40 text-muted-foreground hover:text-foreground": !chosen().includes(
                        agent.id,
                      ),
                    }}
                  >
                    {agent.name}
                  </button>
                )}
              </For>
            </div>
            <div class="flex-1" />
            <button
              type="submit"
              disabled={!canLaunch()}
              class="inline-flex items-center gap-1 px-2 py-1 text-body rounded bg-primary/15 text-primary disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Show when={launching()} fallback={<Play class="w-3 h-3" aria-hidden="true" />}>
                <Loader2 class="w-3 h-3 animate-spin motion-loop" aria-hidden="true" />
              </Show>
              Fan out
            </button>
          </div>
          <Show when={error()}>
            <p class="text-label text-destructive">{error()}</p>
          </Show>
        </form>

        <div class="flex-1 min-h-0 overflow-y-auto px-3 pb-4">
          <Show
            when={runs().length > 0}
            fallback={
              <p class="py-2 text-body text-muted-foreground">
                No runs yet. A fan-out is for a change you are unsure how to make: send the same
                prompt to two or three agents, let each work in its own worktree, then read the
                diffs side by side and merge one.
              </p>
            }
          >
            <For each={runs()}>
              {(run) => <RunCard run={run} onInspect={props.onInspect} />}
            </For>
          </Show>
        </div>
      </Show>
    </div>
  );
}

const STATUS_WORDS: Record<RunLeg["status"], string> = {
  pending: "queued",
  preparing: "making a worktree",
  running: "working",
  finished: "finished",
  failed: "failed",
  cancelled: "stopped",
  // In those words, deliberately: nobody chose it and nothing went wrong —
  // the supervisor has no record of this leg to ask about, whether because
  // this app instance never started it or because it has since restarted.
  interrupted: "interrupted — no longer tracked",
};

function RunCard(props: { run: FanoutRun; onInspect?: (leg: RunLeg) => void }) {
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const progress = createMemo(() => runProgress(props.run));
  const legs = createMemo(() => [...props.run.legs].sort(compareLegs));

  async function adopt(leg: RunLeg) {
    setBusy(leg.id);
    setError(null);
    const result = await adoptFanoutLeg(props.run.repo, props.run.id, leg.id);
    if (!result.ok) setError(result.error ?? "Could not adopt that leg.");
    setBusy(null);
  }

  async function discard(leg: RunLeg) {
    setBusy(leg.id);
    setError(null);
    const result = await discardFanoutLeg(props.run.repo, props.run.id, leg.id);
    if (!result.ok) setError(result.error ?? "Could not remove that worktree.");
    setBusy(null);
  }

  return (
    <section class="py-2 border-b border-border last:border-b-0">
      <div class="flex items-start gap-2">
        <h3 class="flex-1 min-w-0 text-body text-foreground break-words">{props.run.prompt}</h3>
        <span class="shrink-0 text-label text-muted-foreground tabular-nums">
          {progress().done}/{progress().total}
        </span>
        <button
          type="button"
          onClick={() => removeFanoutRun(props.run.repo, props.run.id)}
          aria-label="Forget this run"
          title="Forget this run — the worktrees and branches stay"
          class="shrink-0 p-1 rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X class="w-3 h-3" />
        </button>
      </div>

      <ul class="mt-1 space-y-1">
        <For each={legs()}>
          {(leg) => (
            <li class="flex items-center gap-2 text-label">
              <span
                class="shrink-0 w-24 truncate"
                classList={{
                  "text-info": leg.status === "running" || leg.status === "preparing",
                  "text-destructive": leg.status === "failed",
                  "text-foreground": leg.status === "finished",
                  "text-muted-foreground": ["cancelled", "interrupted", "pending"].includes(
                    leg.status,
                  ),
                }}
                title={leg.branch}
              >
                {leg.agentName}
              </span>

              <span class="flex-1 min-w-0 truncate text-muted-foreground">
                {STATUS_WORDS[leg.status]}
                <Show when={leg.error}>
                  {" — "}
                  <span class="text-destructive">{leg.error}</span>
                </Show>
              </span>

              <span class="shrink-0 tabular-nums text-muted-foreground">
                <Show when={leg.stat} fallback={isLegDone(leg.status) ? "not measured" : ""}>
                  {(stat) => (
                    <>
                      {stat().files}f <span class="text-success">+{stat().additions}</span>{" "}
                      <span class="text-destructive">−{stat().deletions}</span>
                    </>
                  )}
                </Show>
              </span>

              <span class="shrink-0 flex items-center gap-1">
                <Show when={!isLegDone(leg.status)}>
                  <button
                    type="button"
                    onClick={() => void cancelFanoutLeg(leg.id)}
                    aria-label={`Stop ${leg.agentName}`}
                    class="p-0.5 rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X class="w-3 h-3" />
                  </button>
                </Show>
                <Show when={props.onInspect && leg.stat}>
                  <button
                    type="button"
                    onClick={() => props.onInspect?.(leg)}
                    class="px-1 rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Read
                  </button>
                </Show>
                <Show when={leg.status === "finished" && !props.run.adoptedLegId}>
                  <button
                    type="button"
                    disabled={busy() !== null}
                    onClick={() => void adopt(leg)}
                    aria-label={`Adopt ${leg.agentName}'s work`}
                    title="Merge this branch into the current one. The other worktrees are left alone."
                    class="inline-flex items-center gap-0.5 px-1 rounded text-muted-foreground hover:text-foreground disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <GitMerge class="w-3 h-3" />
                    Adopt
                  </button>
                </Show>
                <Show when={props.run.adoptedLegId === leg.id}>
                  <span class="px-1 rounded bg-success/15 text-success text-micro">adopted</span>
                </Show>
                <Show when={isLegDone(leg.status)}>
                  <button
                    type="button"
                    disabled={busy() !== null}
                    onClick={() => void discard(leg)}
                    aria-label={`Remove ${leg.agentName}'s worktree`}
                    title="Remove this leg's worktree. Never automatic — see the module comment."
                    class="p-0.5 rounded text-muted-foreground hover:text-destructive disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Trash2 class="w-3 h-3" />
                  </button>
                </Show>
              </span>
            </li>
          )}
        </For>
      </ul>

      {/* What happened to everything the user did *not* adopt.
          `adoptFanoutLeg` deliberately leaves the other worktrees alone — see
          the module comment in `store/fanout.ts` — but leaving them alone and
          saying nothing is how somebody accumulates six abandoned worktrees and
          finds out from `git worktree list` a month later. The rule the rest of
          this app follows applies here too: a destructive default is wrong, and
          so is a silent non-destructive one. */}
      <Show when={props.run.adoptedLegId}>
        {(adoptedId) => {
          const leftovers = createMemo(() =>
            props.run.legs.filter((l) => l.id !== adoptedId() && isLegDone(l.status)),
          );
          return (
            <Show when={leftovers().length > 0}>
              <p class="mt-1 text-label text-muted-foreground">
                {leftovers().length} other worktree{leftovers().length === 1 ? "" : "s"} and
                branch{leftovers().length === 1 ? "" : "es"} are still on disk —{" "}
                <For each={leftovers()}>
                  {(l, i) => (
                    <>
                      <span class="font-mono">{l.branch}</span>
                      {i() < leftovers().length - 1 ? ", " : ""}
                    </>
                  )}
                </For>
                . Remove them one at a time with the bin above; nothing here deletes
                an agent's work for you.
              </p>
            </Show>
          );
        }}
      </Show>

      {/* The comparison, under the legs rather than above them: the list
          answers "what happened", and this answers "which one", which is only a
          question once something has happened. */}
      <Show when={props.run.legs.some((l) => l.stat)}>
        <RunMatrix run={props.run} onInspect={props.onInspect} />
      </Show>

      <Show when={error()}>
        <p class="mt-1 text-label text-destructive">{error()}</p>
      </Show>
    </section>
  );
}
