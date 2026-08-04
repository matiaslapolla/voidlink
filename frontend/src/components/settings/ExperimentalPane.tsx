/// Settings → Experimental: features on trial, all off by default.
///
/// The pane exists so an unfinished surface has somewhere honest to live. The
/// alternative — shipping it into the main navigation and hoping — is how a
/// settings screen ends up with a "Legacy" section nobody can delete.
///
/// Two rules the pane's shape encodes:
///
///   • **Off means absent.** Every flag here gates whether a surface is built
///     at all, not whether it is visible. The copy under each toggle says what
///     appears when you turn it on, because a flag whose effect you cannot
///     predict is a flag nobody turns on.
///   • **A nested flag is inert, not hidden, while its parent is off.** The
///     "Show idle agents" row stays on screen and disabled with the reason
///     stated (§7.6: a disabled control that does not say why is a dead end).
///     Hiding it would make the JSON view show a key with no control anywhere.
///
/// Its own chrome rather than `SettingsDialog`'s `Section`/`ToggleRow`, which
/// are private to that file — the same arrangement `NotificationsPane` has.
import { Show, type JSX } from "solid-js";
import { FlaskConical } from "lucide-solid";
import { useSettings } from "@/store/settings";
import { AGENT_IDLE_MS } from "@/components/agent/agentBoard";

const IDLE_MINUTES = Math.round(AGENT_IDLE_MS / 60_000);

export function ExperimentalPane() {
  const { settings, updateExperimental } = useSettings();
  const dashboard = () => settings.experimental.agentDashboard;

  return (
    <div class="space-y-4">
      <p class="flex items-start gap-2 text-body text-muted-foreground">
        <FlaskConical class="w-3.5 h-3.5 shrink-0 mt-0.5 opacity-70" />
        <span>
          Unfinished features, off by default. Each one is genuinely absent while its
          toggle is off — nothing renders and nothing polls — so turning one off costs
          you nothing but the feature.
        </span>
      </p>

      <FlagRow
        label="Agent Dashboard"
        hint="Adds an Agent Dashboard entry to the left sidebar: a board of every agent session across the active workspace's worktrees, grouped by whether it needs you, is working, is done, or has gone quiet."
        value={dashboard()}
        onChange={(agentDashboard) => updateExperimental({ agentDashboard })}
      />

      <div class="pl-6 border-l border-border/50">
        <FlagRow
          label="Show idle agents"
          hint={`Include the Idle column: agents quiet for ${IDLE_MINUTES} minutes without reporting a result. Finished and waiting sessions never move there.`}
          value={settings.experimental.showIdleAgents}
          onChange={(showIdleAgents) => updateExperimental({ showIdleAgents })}
          disabledReason={
            dashboard() ? undefined : "Turn on the Agent Dashboard first — there is no board to add a column to."
          }
        />
      </div>
    </div>
  );
}

function FlagRow(props: {
  label: string;
  hint: string;
  value: boolean;
  onChange: (v: boolean) => void;
  /// Present when the flag cannot be changed, and says why. The row still
  /// renders and the value still shows — the control is inert, not gone.
  disabledReason?: string;
}): JSX.Element {
  const disabled = () => props.disabledReason !== undefined;
  return (
    <div class="flex items-start gap-3">
      <div class="flex-1 min-w-0">
        <div class="text-body text-foreground">{props.label}</div>
        <div class="text-micro text-muted-foreground/80 leading-snug max-w-[52ch]">
          {props.hint}
        </div>
        <Show when={props.disabledReason}>
          {(reason) => (
            <div class="mt-0.5 text-micro text-warning/90 leading-snug">{reason()}</div>
          )}
        </Show>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={props.value}
        aria-label={props.label}
        disabled={disabled()}
        title={props.disabledReason}
        onClick={() => props.onChange(!props.value)}
        class="shrink-0 px-3 py-1 rounded-full border text-label transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        classList={{
          "bg-primary/15 border-primary/40 text-primary": props.value,
          "bg-transparent border-border text-muted-foreground": !props.value,
          "hover:text-foreground hover:bg-accent/40": !props.value && !disabled(),
        }}
      >
        {props.value ? "On" : "Off"}
      </button>
    </div>
  );
}
