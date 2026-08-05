/// Settings → AI → Agents: the roster, and the form a Claude agent is built in.
///
/// Its own file because it is no longer a row. Two entry points, two shapes of
/// entry, a colour picker and ten `claude` flags is a pane, and it was the
/// largest thing left inline in a `SettingsDialog.tsx` that was already two
/// thousand lines. The row primitives it shares with the rest of the dialog
/// live in `rows.tsx` — importing them from `SettingsDialog.tsx` would be a
/// cycle, since the dialog renders this.
import { For, Show, createSignal } from "solid-js";
import { ChevronDown, ChevronRight, X } from "lucide-solid";
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

/// The workspace's named agents.
///
/// A row is one of two things and the form it shows is the whole difference:
///
///   • **A Claude agent** is built here — a model, a system prompt, a
///     permission mode, tool lists. The command is *derived*, shown read-only
///     at the bottom of the form, and launched in a real terminal. That is the
///     shape almost every entry in this roster actually wants, and typing it as
///     a shell string meant getting eighty characters of quoting right in a
///     single-line input where one apostrophe silently rebinds every flag after
///     it.
///   • **A command agent** is the original BYO-CLI contract, unchanged: a shell
///     command a grounded prompt is piped to on stdin. It is what points at
///     `ollama`, at `codex`, at anything not-Claude, and it is what every
///     roster written before this pane existed already is.
///
/// Edits are written straight through on every keystroke, like every other row
/// in this dialog — there is no Save button to be out of sync with, and a
/// half-typed command is only ever spawned when the user asks the agent to run.
///
/// The last row's remove button stays *present* and disabled rather than
/// disappearing (§7.6): a control that vanishes teaches nothing, and the reason
/// a roster can't be emptied is exactly what the user needs told.
export function AgentRosterSection() {
  const { settings, addAgent, removeAgent } = useSettings();
  const soleEntry = () => settings.ai.agents.length <= 1;
  const [expanded, setExpanded] = createSignal<string | null>(null);

  return (
    <Section title="Agents">
      <p class="text-label text-muted-foreground leading-relaxed">
        Each agent is a name and a way to run it. A <em>Claude agent</em> is
        built from the fields below and opens as a real terminal session in this
        worktree — named, so four of them in four panes are four
        distinguishable agents. A <em>command agent</em> is any other CLI you
        have installed, taking a grounded prompt on stdin.
      </p>
      <For each={settings.ai.agents}>
        {(entry: AgentRosterEntry) => (
          <AgentRow
            entry={entry}
            expanded={expanded() === entry.id}
            onToggle={() => setExpanded(expanded() === entry.id ? null : entry.id)}
            canRemove={!soleEntry()}
            onRemove={() => removeAgent(entry.id)}
          />
        )}
      </For>
      <div class="flex items-center gap-1.5 pt-1 border-t border-border/50">
        <button
          onClick={() => setExpanded(addAgent("Claude agent", "", { ...DEFAULT_CLAUDE_SPEC }))}
          class="px-2 py-1 rounded border border-border text-label text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors focus-visible:ring-2 focus-visible:ring-ring"
        >
          Add Claude agent
        </button>
        <button
          onClick={() => setExpanded(addAgent("New agent", ""))}
          class="px-2 py-1 rounded border border-border text-label text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors focus-visible:ring-2 focus-visible:ring-ring"
        >
          Add command agent
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
  expanded: boolean;
  canRemove: boolean;
  onRemove: () => void;
  onToggle: () => void;
}) {
  const { updateAgent, setAgentClaudeSpec } = useSettings();
  const name = () => props.entry.name || "this agent";
  const summary = () =>
    props.entry.claude
      ? describeClaudeSpec(props.entry.claude)
      : props.entry.commandTemplate.trim() || "no command — uses the fallback below";

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
              you are typing into. */}
          <Show
            when={!!props.entry.claude}
            fallback={
              <>
                <TextRow
                  label="Command"
                  value={props.entry.commandTemplate}
                  placeholder="optional — falls back to the shared command below"
                  onInput={(v) => updateAgent(props.entry.id, { commandTemplate: v })}
                />
                <p class={`text-label text-muted-foreground leading-relaxed ${LABEL_INDENT}`}>
                  A grounded prompt goes in on stdin and the answer comes out on
                  stdout. Leave it blank to use the fallback command.
                </p>
                <div class={LABEL_INDENT}>
                  <button
                    onClick={() =>
                      setAgentClaudeSpec(props.entry.id, { ...DEFAULT_CLAUDE_SPEC })
                    }
                    class="px-2 py-1 rounded border border-border text-label text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Build this as a Claude agent instead
                  </button>
                </div>
              </>
            }
          >
            <ClaudeAgentForm
              id={props.entry.id}
              name={props.entry.name}
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
function ClaudeAgentForm(props: { id: string; name: string; spec: ClaudeAgentSpec }) {
  const { updateAgentClaude, setAgentClaudeSpec } = useSettings();
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

      <div class="flex items-start gap-3">
        <span class={`${LABEL_COL} text-muted-foreground pt-1`}>Runs</span>
        <code class="flex-1 min-w-0 rounded border border-border bg-muted/40 px-2 py-1 text-label font-mono break-all text-foreground/80">
          {composeClaudeCommand(props.spec, props.name)}
        </code>
      </div>
      <div class={LABEL_INDENT}>
        <button
          onClick={() => setAgentClaudeSpec(props.id, null)}
          // The consequence is on the button, not in a tooltip: this is the
          // one control in the pane that throws away work the user typed.
          class="px-2 py-1 rounded border border-border text-label text-muted-foreground hover:text-destructive hover:border-destructive/40 transition-colors focus-visible:ring-2 focus-visible:ring-ring"
        >
          Use a raw command instead — discards this form
        </button>
      </div>
    </>
  );
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


