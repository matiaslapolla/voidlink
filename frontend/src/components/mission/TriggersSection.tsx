import { For, Show, createMemo, createResource, createSignal } from "solid-js";
import { AlertTriangle, FlaskConical, Plus, Power, Trash2 } from "lucide-solid";
import { journalApi } from "@/api/journal";
import {
  MIN_INTERVAL_FLOOR_MS,
  addTriggerRule,
  dryRun,
  removeTriggerRule,
  setTriggerRuleEnabled,
  setTriggersArmed,
  triggerRules,
  triggersArmed,
  type TriggerRule,
} from "@/store/triggers";
import { agentRoster } from "@/store/settings";

/// "When X happens, run agent Y."
///
/// The surface for the most dangerous thing in this track, so it is built
/// around the two affordances that make it safe to use rather than around the
/// two that make it quick to set up:
///
///   - **The kill switch is the first thing on the screen**, not buried in
///     settings. Something that starts processes on your behalf needs an off
///     switch you can find while it is misbehaving.
///   - **Dry run is offered before enable, on every rule.** It replays the rule
///     against the log and says what *would* have fired. Writing a rule and
///     finding out by enabling it is the workflow this exists to prevent.
///
/// A new rule always lands disabled. Enabling is a separate, deliberate act.
interface TriggersSectionProps {
  repoPath?: string;
}

/// How far back a dry run looks. A week is enough history for a rule about
/// commits or terminal commands to have fired several times, and short enough
/// that the query stays inside Rust's in-memory ring.
const DRY_RUN_MS = 7 * 86_400_000;

const KIND_PRESETS: { label: string; kinds: string[] }[] = [
  { label: "Any commit", kinds: ["git.commit"] },
  { label: "Any git change", kinds: ["git."] },
  { label: "A command finishing", kinds: ["terminal.command."] },
  { label: "A review comment", kinds: ["review.note.added"] },
];

export function TriggersSection(props: TriggersSectionProps) {
  const [name, setName] = createSignal("");
  const [kinds, setKinds] = createSignal<string[]>(KIND_PRESETS[0].kinds);
  const [agentId, setAgentId] = createSignal("");
  const [prompt, setPrompt] = createSignal("");

  const roster = createMemo(() => agentRoster());
  const rules = createMemo(() => (props.repoPath ? triggerRules(props.repoPath) : []));

  /// The window every dry run reads. Fetched once for the section rather than
  /// per rule — a rule list of six would otherwise make six identical queries.
  const [history] = createResource(
    () => props.repoPath,
    async (repo) => journalApi.query({ repo, since: Date.now() - DRY_RUN_MS, limit: 5000 }),
  );

  function submit(e: Event) {
    e.preventDefault();
    const repo = props.repoPath;
    if (!repo) return;
    const id = addTriggerRule({
      repo,
      name: name(),
      kinds: kinds(),
      agentId: agentId() || roster()[0]?.id || "",
      prompt: prompt(),
    });
    if (!id) return;
    setName("");
    setPrompt("");
  }

  return (
    <div class="flex flex-col flex-1 min-h-0">
      <Show
        when={props.repoPath}
        fallback={
          <p class="p-4 text-body text-muted-foreground">
            Triggers watch one repository. Point this workspace at one to write a rule.
          </p>
        }
      >
        {/* First on the screen, deliberately. */}
        <div class="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
          <button
            type="button"
            role="switch"
            aria-checked={triggersArmed()}
            onClick={() => setTriggersArmed(!triggersArmed())}
            class="inline-flex items-center gap-1 px-2 py-1 text-body rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            classList={{
              "bg-success/15 text-success": triggersArmed(),
              "bg-muted/40 text-muted-foreground hover:text-foreground": !triggersArmed(),
            }}
          >
            <Power class="w-3 h-3" aria-hidden="true" />
            {triggersArmed() ? "Triggers are on" : "Triggers are off"}
          </button>
          <p class="text-label text-muted-foreground">
            {triggersArmed()
              ? "Enabled rules will start agent turns on their own."
              : "Nothing will run, whatever the rules below say."}
          </p>
        </div>

        <div class="flex-1 min-h-0 overflow-y-auto">
          <ul>
            <For
              each={rules()}
              fallback={
                <li class="px-3 py-2 text-body text-muted-foreground">
                  No rules yet. A rule binds an event kind to an agent — “when a commit lands,
                  ask the reviewer to look at it”. Try it against the last week before turning
                  it on.
                </li>
              }
            >
              {(rule) => (
                <RuleRow
                  rule={rule}
                  repo={props.repoPath!}
                  history={history() ?? []}
                  agentName={roster().find((a) => a.id === rule.agentId)?.name ?? rule.agentId}
                />
              )}
            </For>
          </ul>

          <form class="px-3 py-2 space-y-2 border-t border-border" onSubmit={submit}>
            <div class="flex items-center gap-2">
              <input
                type="text"
                value={name()}
                onInput={(e) => setName(e.currentTarget.value)}
                placeholder="Rule name"
                aria-label="Rule name"
                class="flex-1 min-w-0 px-2 py-1 text-body bg-muted/40 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <select
                value={kinds().join(",")}
                onChange={(e) => setKinds(e.currentTarget.value.split(","))}
                aria-label="When this happens"
                class="px-2 py-1 text-body bg-muted/40 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <For each={KIND_PRESETS}>
                  {(preset) => <option value={preset.kinds.join(",")}>{preset.label}</option>}
                </For>
              </select>
              <select
                value={agentId()}
                onChange={(e) => setAgentId(e.currentTarget.value)}
                aria-label="Run this agent"
                class="px-2 py-1 text-body bg-muted/40 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <For each={roster()}>
                  {(agent) => <option value={agent.id}>{agent.name}</option>}
                </For>
              </select>
            </div>
            <textarea
              value={prompt()}
              onInput={(e) => setPrompt(e.currentTarget.value)}
              rows="2"
              placeholder="What to ask. {{summary}}, {{kind}}, {{subject}} and {{repo}} are filled in from the event."
              aria-label="Prompt"
              class="w-full px-2 py-1 text-body bg-muted/40 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <div class="flex items-center gap-2">
              <p class="flex-1 text-label text-muted-foreground">
                New rules start off, and never fire more than once every{" "}
                {Math.round(MIN_INTERVAL_FLOOR_MS / 1000)}s.
              </p>
              <button
                type="submit"
                disabled={!prompt().trim()}
                class="inline-flex items-center gap-1 px-2 py-1 text-body rounded text-muted-foreground hover:text-foreground disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Plus class="w-3 h-3" aria-hidden="true" />
                Add rule
              </button>
            </div>
          </form>
        </div>
      </Show>
    </div>
  );
}

function RuleRow(props: {
  rule: TriggerRule;
  repo: string;
  history: Parameters<typeof dryRun>[1];
  agentName: string;
}) {
  const [tried, setTried] = createSignal<number | null>(null);

  return (
    <li class="px-3 py-2 border-b border-border">
      <div class="flex items-center gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={props.rule.enabled}
          aria-label={`${props.rule.enabled ? "Disable" : "Enable"} ${props.rule.name}`}
          onClick={() => setTriggerRuleEnabled(props.repo, props.rule.id, !props.rule.enabled)}
          class="shrink-0 px-1.5 py-0.5 text-micro rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          classList={{
            "bg-success/15 text-success": props.rule.enabled,
            "bg-muted/40 text-muted-foreground": !props.rule.enabled,
          }}
        >
          {props.rule.enabled ? "on" : "off"}
        </button>
        <span class="flex-1 min-w-0 truncate text-body text-foreground">{props.rule.name}</span>
        <span class="shrink-0 text-label text-muted-foreground truncate">
          {props.rule.kinds.join(", ")} → {props.agentName}
        </span>
        <button
          type="button"
          onClick={() => setTried(dryRun(props.rule, props.history).length)}
          aria-label={`Try ${props.rule.name} against the last week`}
          title="Replay this rule over the last week without running anything"
          class="shrink-0 p-1 rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <FlaskConical class="w-3 h-3" />
        </button>
        <button
          type="button"
          onClick={() => removeTriggerRule(props.repo, props.rule.id)}
          aria-label={`Delete ${props.rule.name}`}
          class="shrink-0 p-1 rounded text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Trash2 class="w-3 h-3" />
        </button>
      </div>

      <Show when={tried() !== null}>
        <p class="mt-1 text-label" classList={{ "text-warning": (tried() ?? 0) > 5 }}>
          Would have run {tried()} time{tried() === 1 ? "" : "s"} in the last week.
          {/* A rule that would have fired constantly is the failure mode a dry
              run exists to catch, so it is called out rather than left as a
              number the reader has to judge. */}
          <Show when={(tried() ?? 0) > 5}>
            {" "}
            <AlertTriangle class="inline w-3 h-3" aria-hidden="true" /> That is a lot — consider
            a narrower kind.
          </Show>
        </p>
      </Show>
    </li>
  );
}
