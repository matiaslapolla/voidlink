/// Settings → AI → Agents: the roster, and the form a Claude agent is built in.
///
/// Its own file because it is no longer a row. A colour picker and ten `claude`
/// flags is a pane, and it was the largest thing left inline in a
/// `SettingsDialog.tsx` that was already two thousand lines. The row primitives
/// it shares with the rest of the dialog live in `rows.tsx` — importing them
/// from `SettingsDialog.tsx` would be a cycle, since the dialog renders this.
import { For, Match, Show, Switch, createSignal } from "solid-js";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Loader2, X } from "lucide-solid";
import { probeClaudeAgent, type ProbeState } from "@/commands/agentProbe";
import {
  CLAUDE_EFFORTS,
  CLAUDE_MODEL_PRESETS,
  CLAUDE_PERMISSION_MODES,
  DEFAULT_CLAUDE_SPEC,
  composeClaudeCommand,
  describeClaudeSpec,
  type ClaudeAgentSpec,
  type ClaudeEffort,
  type ClaudePermissionMode,
} from "@/store/claudeAgent";
import { TAB_GROUP_COLORS, type TabGroupColor } from "@/store/layout/tabGroups";
import { useSettings, type AgentRosterEntry } from "@/store/settings";
import {
  LABEL_COL,
  LABEL_INDENT,
  Section,
  SegmentedRow,
  TextRow,
  ToggleRow,
} from "./rows";

const AGENT_INPUT_CLASS =
  "min-w-0 rounded border border-border bg-muted/40 px-2 py-1 text-label font-mono outline-2 outline-transparent transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring";

/// The workspace's named agents — the Claude ones.
///
/// A roster entry is still one of two things in the store. Only one of them is
/// on screen: **a Claude agent**, built here from a model, a system prompt, a
/// permission mode and tool lists, composed into a command shown read-only at
/// the bottom of the form and launched in a real terminal.
///
/// **The BYO-CLI command agent is hidden, not removed.** It is the original
/// contract — a shell command a grounded prompt is piped to on stdin, pointing
/// at `ollama`, at `codex`, at anything not-Claude — and everything behind it
/// still works: `parseAgentRoster` still revives one, `resolveAgentCommand`
/// still resolves it, an agent thread bound to one still runs, and the shared
/// fallback command below still configures the thread. What is gone is the
/// *surface*: no row renders for one, and there is no way to make a new one.
///
/// Hiding rather than deleting is the whole point. Every roster written before
/// this pane existed is a command agent, and the shipped default still is one —
/// deleting the concept would silently unconfigure them. A user who had one
/// keeps it; they just cannot see it here for now.
///
/// Two consequences worth naming, because both look like bugs otherwise:
///
///   • The roster can render **empty** — a fresh install has exactly one agent
///     and it is a command agent. That is why there is an empty state rather
///     than a bare "Add" button under nothing.
///   • The last-row remove guard counts *every* entry, including the hidden
///     ones, so removing the last visible row is usually allowed. That is
///     correct — the roster is not being emptied — but it means the disabled
///     state is now rare rather than reliable at one row.
///
/// Edits are written straight through on every keystroke, like every other row
/// in this dialog — there is no Save button to be out of sync with, and a
/// half-typed command is only ever spawned when the user asks the agent to run.
///
/// `repoPath` is the folder the Test button probes in — the active repository,
/// passed down rather than read from the app store, because this pane is a leaf
/// and the store is a context two levels above it. Absent means no repository is
/// open, which the button renders as disabled with a reason.
export function AgentRosterSection(props: { repoPath?: string | null }) {
  const { settings, addAgent, removeAgent } = useSettings();
  /// Only composed agents have a row. See this section's header for why the
  /// others still exist in the store.
  const visible = () => settings.ai.agents.filter((entry) => entry.claude);
  const soleEntry = () => settings.ai.agents.length <= 1;
  const [expanded, setExpanded] = createSignal<string | null>(null);

  return (
    <Section title="Agents">
      <p class="text-label text-muted-foreground leading-relaxed">
        An agent is a <code class="font-mono">claude</code> session built from
        the fields below and opened as a real terminal in this worktree — named,
        so four of them in four panes are four distinguishable agents rather
        than four identical shells.
      </p>
      <Show
        when={visible().length > 0}
        fallback={
          <p class="text-label text-muted-foreground/70 leading-relaxed">
            No agents yet. Add one and it appears in the workbench's <b>+</b>{" "}
            menu, ready to open in a pane.
          </p>
        }
      >
        <For each={visible()}>
          {(entry: AgentRosterEntry) => (
            <AgentRow
              entry={entry}
              repoPath={props.repoPath ?? null}
              expanded={expanded() === entry.id}
              onToggle={() => setExpanded(expanded() === entry.id ? null : entry.id)}
              canRemove={!soleEntry()}
              onRemove={() => removeAgent(entry.id)}
            />
          )}
        </For>
      </Show>
      <div class="flex items-center gap-1.5 pt-1 border-t border-border/50">
        <button
          onClick={() => setExpanded(addAgent("Claude agent", "", { ...DEFAULT_CLAUDE_SPEC }))}
          class="px-2 py-1 rounded border border-border text-label text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors focus-visible:ring-2 focus-visible:ring-ring"
        >
          Add agent
        </button>
      </div>
    </Section>
  );
}

/// One roster row: always a header, and its form only while expanded.
///
/// Collapsed by default and one open at a time, because the Claude form is ten
/// controls and a roster of four would otherwise be forty — a wall in which the
/// thing a user came to change is unfindable. The header carries what
/// distinguishes the agents from each other (colour, name, a one-line summary);
/// the form carries what distinguishes one *run* from another.
function AgentRow(props: {
  entry: AgentRosterEntry;
  repoPath: string | null;
  expanded: boolean;
  canRemove: boolean;
  onRemove: () => void;
  onToggle: () => void;
}) {
  const { updateAgent } = useSettings();
  const name = () => props.entry.name || "this agent";
  /// Only composed entries reach here — `AgentRosterSection` filters — so the
  /// `?? ""` is for the type rather than for a state that can occur.
  const summary = () =>
    props.entry.claude ? describeClaudeSpec(props.entry.claude) : "";

  return (
    <div class="rounded border border-border/60">
      <div class="flex items-center gap-1.5 p-1.5">
        {/* The colour is the row's identity at a glance and it is also what the
            launched terminal wears, so it is set here rather than assigned and
            hidden. A five-swatch picker rather than a wheel: the palette is
            five tokens every theme defines (`TAB_GROUP_COLORS`), and a free
            colour would be unreadable in half of them. */}
        <AgentColorPicker
          value={props.entry.color}
          name={name()}
          onChange={(color) => updateAgent(props.entry.id, { color })}
        />
        <input
          type="text"
          value={props.entry.name}
          placeholder="Reviewer"
          aria-label="Agent name"
          onInput={(e) => updateAgent(props.entry.id, { name: e.currentTarget.value })}
          class={`w-32 shrink-0 ${AGENT_INPUT_CLASS}`}
        />
        <button
          onClick={props.onToggle}
          aria-expanded={props.expanded}
          class="flex-1 min-w-0 flex items-center gap-1.5 text-left px-1 py-1 rounded text-label text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Show when={props.expanded} fallback={<ChevronRight class="w-3.5 h-3.5 shrink-0" />}>
            <ChevronDown class="w-3.5 h-3.5 shrink-0" />
          </Show>
          <span class="truncate">{summary()}</span>
        </button>
        <button
          onClick={() => {
            if (props.canRemove) props.onRemove();
          }}
          aria-disabled={!props.canRemove}
          title={
            props.canRemove
              ? `Remove ${name()} from the roster`
              : "A roster needs at least one agent"
          }
          aria-label={`Remove ${name()} from the roster`}
          class={`p-1 rounded text-muted-foreground transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
            props.canRemove
              ? "hover:text-destructive hover:bg-destructive/10"
              : "opacity-40 cursor-not-allowed"
          }`}
        >
          <X class="w-3.5 h-3.5" />
        </button>
      </div>

      <Show when={props.expanded}>
        <div class="border-t border-border/60 p-3 space-y-3">
          {/* `when` is a boolean rather than the spec itself, on purpose. A
              keyed `<Show>` over the object would tear down and rebuild the
              whole form every time a field changed identity — which, in a form
              that writes on every keystroke, is a form that destroys the input
              you are typing into.

              No fallback: `AgentRosterSection` only renders composed entries,
              so a row with no spec is unreachable rather than unhandled. */}
          <Show when={!!props.entry.claude}>
            <ClaudeAgentForm
              id={props.entry.id}
              name={props.entry.name}
              repoPath={props.repoPath}
              spec={props.entry.claude!}
            />
          </Show>
        </div>
      </Show>
    </div>
  );
}

function AgentColorPicker(props: {
  value: TabGroupColor;
  name: string;
  onChange: (color: TabGroupColor) => void;
}) {
  const [open, setOpen] = createSignal(false);
  return (
    <div class="relative shrink-0">
      <button
        onClick={() => setOpen(!open())}
        aria-label={`Colour for ${props.name}`}
        aria-expanded={open()}
        title={`Colour for ${props.name}`}
        class="w-5 h-5 rounded-full border border-border/60 focus-visible:ring-2 focus-visible:ring-ring"
        style={{ "background-color": `var(--${props.value})` }}
      />
      <Show when={open()}>
        <div class="absolute left-0 top-6 z-30 flex gap-1 rounded border border-border material-chrome p-1 shadow-lg">
          <For each={TAB_GROUP_COLORS}>
            {(color) => (
              <button
                onClick={() => {
                  props.onChange(color);
                  setOpen(false);
                }}
                aria-label={color}
                class="w-5 h-5 rounded-full border border-border/60 focus-visible:ring-2 focus-visible:ring-ring"
                style={{ "background-color": `var(--${color})` }}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

/// Every `claude` flag this pane models, plus the command it composes to.
///
/// The composed command is shown, read-only, at the bottom. That is the one
/// piece of this form that is not a control and it is the most important thing
/// in it: a form that hides what it will run is a form the user cannot check,
/// and the whole reason for building the command rather than typing it was that
/// the quoting is hard to see. Showing the result closes that loop.
function ClaudeAgentForm(props: {
  id: string;
  name: string;
  repoPath: string | null;
  spec: ClaudeAgentSpec;
}) {
  const { updateAgentClaude } = useSettings();
  const patch = (p: Partial<ClaudeAgentSpec>) => updateAgentClaude(props.id, p);

  return (
    <>
      <SegmentedRow
        label="System prompt"
        value={props.spec.systemPromptMode}
        options={[
          { id: "append", label: "Add to Claude's" },
          { id: "replace", label: "Replace Claude's" },
        ]}
        onChange={(v) => patch({ systemPromptMode: v })}
      />
      <div class="flex items-start gap-3">
        <span class={`${LABEL_COL} text-muted-foreground pt-1`}>Instructions</span>
        <textarea
          value={props.spec.systemPrompt}
          placeholder="You review diffs. Be blunt about risk and say nothing about style."
          aria-label="System prompt"
          rows={4}
          onInput={(e) => patch({ systemPrompt: e.currentTarget.value })}
          class="flex-1 rounded border border-border bg-muted/40 px-2 py-1 text-label font-mono resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        />
      </div>
      {/* Stated rather than left to be discovered: "Replace" is not a stronger
          version of "Add", it discards everything the CLI knows about its own
          tools and this repository, and a user finds that out one confusing
          session later. §7.6 — the control says what it does. */}
      <p class={`text-label text-muted-foreground leading-relaxed ${LABEL_INDENT}`}>
        <Show
          when={props.spec.systemPromptMode === "replace"}
          fallback="Layered on top of Claude's own system prompt, which keeps everything it knows about its tools and this repository."
        >
          Replaces Claude's own system prompt entirely — it will no longer be
          told about its tools or this repository. Use “Add to Claude's” unless
          you specifically want a bare model.
        </Show>
      </p>

      <TextRow
        label="Model"
        value={props.spec.model}
        placeholder="blank — Claude's default"
        onInput={(v) => patch({ model: v })}
      />
      <div class={`flex flex-wrap gap-1 ${LABEL_INDENT}`}>
        <For each={CLAUDE_MODEL_PRESETS}>
          {(m) => (
            <button
              onClick={() => patch({ model: m })}
              class="px-2 py-0.5 text-micro rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
            >
              {m}
            </button>
          )}
        </For>
        <button
          onClick={() => patch({ model: "" })}
          class="px-2 py-0.5 text-micro rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
        >
          default
        </button>
      </div>

      <EnumRow
        label="Permissions"
        value={props.spec.permissionMode}
        blankLabel="Claude's default"
        options={CLAUDE_PERMISSION_MODES}
        onChange={(v) => patch({ permissionMode: v as ClaudePermissionMode | "" })}
      />
      <EnumRow
        label="Effort"
        value={props.spec.effort}
        blankLabel="Claude's default"
        options={CLAUDE_EFFORTS}
        onChange={(v) => patch({ effort: v as ClaudeEffort | "" })}
      />

      <TextRow
        label="Allowed tools"
        value={props.spec.allowedTools}
        placeholder='e.g. Read, Grep, "Bash(git *)"'
        onInput={(v) => patch({ allowedTools: v })}
      />
      <TextRow
        label="Denied tools"
        value={props.spec.disallowedTools}
        placeholder="e.g. Bash, WebFetch"
        onInput={(v) => patch({ disallowedTools: v })}
      />
      <div class="flex items-start gap-3">
        <span class={`${LABEL_COL} text-muted-foreground pt-1`}>Extra folders</span>
        <textarea
          value={props.spec.addDirs}
          placeholder={"One path per line — another worktree this agent may read"}
          aria-label="Extra directories this agent may access"
          rows={2}
          onInput={(e) => patch({ addDirs: e.currentTarget.value })}
          class="flex-1 rounded border border-border bg-muted/40 px-2 py-1 text-label font-mono resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        />
      </div>
      <ToggleRow
        label="Continue"
        hint="resume this folder's last session"
        value={props.spec.continueSession}
        onChange={(v) => patch({ continueSession: v })}
      />
      <TextRow
        label="Extra arguments"
        value={props.spec.extraArgs}
        placeholder="passed through verbatim, after everything above"
        onInput={(v) => patch({ extraArgs: v })}
      />

      <CommandRow id={props.id} name={props.name} spec={props.spec} />

      <TestRow spec={props.spec} repoPath={props.repoPath} />
    </>
  );
}

/// The command this agent runs — composed from the form, and editable.
///
/// It was read-only, on the reasoning that a derived value you can type into is
/// a value that fights whatever derives it. That reasoning was right about the
/// mechanism and wrong about the situation: the form composes flags for the CLI
/// they were read off, the user's machine runs whichever `claude` wins the login
/// shell's PATH, and those are not always the same program. An agent whose
/// `--name` the installed binary rejects was, before this, unfixable from
/// inside the app.
///
/// So editing switches the agent to the edited string and says so. Two rules
/// make that safe rather than merely possible:
///
///   • **Editing never destroys the form.** The fields keep their values and
///     keep working; they simply stop being what runs. Clearing the box hands
///     the composed command back exactly as it was.
///   • **The disconnect is stated, not discovered.** While an override is in
///     force the fields above are inert, and a form whose controls silently do
///     nothing is the worst thing a settings pane can be — so the note says it
///     and the Reset button is right there.
function CommandRow(props: { id: string; name: string; spec: ClaudeAgentSpec }) {
  const { updateAgentClaude } = useSettings();
  const composed = () => composeClaudeCommand({ ...props.spec, commandOverride: "" }, props.name);
  const overridden = () => props.spec.commandOverride.trim().length > 0;
  /// The composed command while untouched, the user's text once touched. Not a
  /// local signal seeded from the composed value: that would stop tracking the
  /// form the moment it mounted, and a user who edits Model and then looks at
  /// this line would see the old command with no indication of why.
  const value = () => (overridden() ? props.spec.commandOverride : composed());

  return (
    <div class="flex items-start gap-3">
      <span class={`${LABEL_COL} text-muted-foreground pt-1`}>Runs</span>
      <div class="flex-1 min-w-0 space-y-1">
        <textarea
          value={value()}
          aria-label="Command this agent runs"
          spellcheck={false}
          rows={2}
          onInput={(e) => updateAgentClaude(props.id, { commandOverride: e.currentTarget.value })}
          class="w-full rounded border border-border bg-muted/40 px-2 py-1 text-label font-mono resize-y text-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        />
        <Show
          when={overridden()}
          fallback={
            <p class="text-micro text-muted-foreground/70">
              Built from the fields above — edit it to take over, e.g. to drop a
              flag your installed <code class="font-mono">claude</code> doesn't
              have.
            </p>
          }
        >
          <div class="flex items-start gap-2">
            <p class="flex-1 text-micro text-muted-foreground">
              Edited — this exact command runs, and the fields above no longer
              affect it.
            </p>
            <button
              onClick={() => updateAgentClaude(props.id, { commandOverride: "" })}
              class="shrink-0 px-1.5 py-0.5 text-micro rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
            >
              Reset to the form
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
}

/// Spawn this agent once, and say what came back.
///
/// The form's read-only command line closes the *quoting* loop — the user can
/// see what will run. This closes the other one: whether what will run works.
/// Those are different questions with different failure modes, and until now
/// only the first had an answer anywhere in the app. Everything else here — is
/// `claude` on the PATH a windowed app inherits, is this machine signed in,
/// does the installed version still have `--effort` — was discovered by opening
/// a pane and reading a usage message.
///
/// Deliberately *not* a status that persists or re-runs. A green tick from four
/// minutes and two edits ago is a claim about a command that no longer exists,
/// so the result is cleared the moment the spec changes underneath it. See the
/// `spec` guard below.
function TestRow(props: { spec: ClaudeAgentSpec; repoPath: string | null }) {
  const [state, setState] = createSignal<ProbeState>({ kind: "idle" });
  /// The spec the last result was about. A result is only shown while the form
  /// still says what it said when the probe ran — otherwise the pane vouches
  /// for a configuration nobody tested.
  const [testedSpec, setTestedSpec] = createSignal("");
  const current = () => JSON.stringify(props.spec);
  const stale = () => state().kind !== "running" && testedSpec() !== current();
  const passed = () => {
    const s = state();
    return s.kind === "ok" ? s : undefined;
  };
  const failed = () => {
    const s = state();
    return s.kind === "failed" ? s : undefined;
  };

  /// The probe runs in a real directory because the CLI does: `--add-dir`,
  /// `CLAUDE.md` discovery and settings resolution are all cwd-relative, and a
  /// probe run somewhere else would be testing a different agent.
  const run = async () => {
    const repoPath = props.repoPath;
    if (!repoPath || state().kind === "running") return;
    setState({ kind: "running" });
    setTestedSpec(current());
    setState(await probeClaudeAgent(repoPath, props.spec));
  };

  return (
    <div class="flex items-start gap-3">
      <span class={`${LABEL_COL} text-muted-foreground pt-1`}>Test</span>
      <div class="flex-1 min-w-0 space-y-1">
        <div class="flex items-center gap-2">
          <button
            onClick={() => void run()}
            disabled={state().kind === "running" || !props.repoPath}
            title={
              props.repoPath
                ? "Run this agent once with -p and report what comes back"
                : "Open a repository first — the probe runs in its folder"
            }
            class="px-2 py-1 rounded border border-border text-label text-muted-foreground hover:text-foreground hover:bg-accent/40 disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Show when={state().kind === "running"} fallback="Test agent">
              <span class="flex items-center gap-1.5">
                <Loader2 class="w-3.5 h-3.5 animate-spin" /> Testing…
              </span>
            </Show>
          </button>
          <span class="text-micro text-muted-foreground/70 truncate">
            One `claude -p` turn, no tools, nothing written.
          </span>
        </div>
        {/* Not `<Show when={!stale()}>` around the whole block: a result that
            has gone stale is still the most recent thing that happened, and
            blanking it as the user types the next character reads as the pane
            forgetting. It is dimmed and labelled instead. */}
        <Switch>
          <Match when={passed()}>
            {(ok) => (
              <p
                class={`flex items-start gap-1.5 text-micro ${stale() ? "text-muted-foreground/60" : "text-primary/90"}`}
                role="status"
              >
                <Check class="w-3 h-3 mt-0.5 shrink-0" />
                <span>
                  <Show when={!stale()} fallback="Passed before your last edit — test again. ">
                    Works — replied in {formatMs(ok().ms)}.{" "}
                  </Show>
                  <span class="font-mono text-muted-foreground/70">{ok().reply}</span>
                </span>
              </p>
            )}
          </Match>
          <Match when={failed()}>
            {(bad) => (
              <p
                class={`flex items-start gap-1.5 text-micro ${stale() ? "text-muted-foreground/60" : "text-destructive"}`}
                role="status"
              >
                <AlertTriangle class="w-3 h-3 mt-0.5 shrink-0" />
                <span>{bad().reason}</span>
              </p>
            )}
          </Match>
        </Switch>
      </div>
    </div>
  );
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/// A closed enum with a blank option meaning "don't pass the flag".
///
/// A `<select>` rather than a `SegmentedRow` because six permission modes in a
/// row of equal-width buttons is six unreadable truncations, and because blank
/// is a real member here rather than an absence — "Claude's default" is a
/// *choice*, distinct from picking `manual`, and a segmented control has no
/// natural place to put it.
function EnumRow(props: {
  label: string;
  value: string;
  blankLabel: string;
  options: readonly string[];
  onChange: (v: string) => void;
}) {
  return (
    <div class="flex items-center gap-3">
      <span class={`${LABEL_COL} text-muted-foreground`}>{props.label}</span>
      <select
        value={props.value}
        aria-label={props.label}
        onChange={(e) => props.onChange(e.currentTarget.value)}
        class="flex-1 rounded border border-border bg-muted/40 px-2 py-1 text-label focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <option value="">{props.blankLabel}</option>
        <For each={props.options}>{(o) => <option value={o}>{o}</option>}</For>
      </select>
    </div>
  );
}


