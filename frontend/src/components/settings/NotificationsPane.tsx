/// Settings → Notifications: **one screen, one matrix**.
///
/// The shape is the decision. The alternative — a toggle per cue, per event
/// kind — is what every app that ends up with an unusable notifications screen
/// did first, and it grows by one row every time a feature is added. A matrix of
/// *event families* × {nothing, sound, banner, both} stays the same size as the
/// app grows, because a new family either fits an existing prefix or is one new
/// row that the user can find.
///
/// The rows are prefixes, matched with `startsWith` and resolved longest-first
/// in Rust. That is why `agent.` and `agent.turn.failed` can both be present
/// without an ordering rule, and why a kind this build has never heard of still
/// lands somewhere sensible.
///
/// Everything here writes straight through to Rust, which owns the policy. This
/// pane holds no state of its own beyond the in-flight edit — two copies of the
/// config, one in a store and one in Rust, is how a screen ends up showing
/// something different from what the app does.
import { For, Show, createResource, createSignal } from "solid-js";
import { BellOff, Loader2, Play, Plus, Trash2 } from "lucide-solid";
import {
  NOTIFY_LEVELS,
  notifyApi,
  type NotifyConfig,
  type NotifyLevel,
  type NotifyRule,
} from "@/api/notify";
import { pushToast } from "@/commands/toast";

/// What each level means, in the words a user would use. Shown as the column
/// header's tooltip rather than as prose above the table — the table is the
/// explanation if the columns are named well enough.
const LEVEL_HELP: Record<NotifyLevel, string> = {
  silent: "Nothing from the OS. The in-app activity mark still appears.",
  sound: "A sound cue, no banner. For when you are at the machine.",
  banner: "An OS notification. Its sound is the platform's, so Do Not Disturb applies.",
  both: "A banner and a cue. Worth reserving for failures.",
};

const LEVEL_LABEL: Record<NotifyLevel, string> = {
  silent: "Off",
  sound: "Sound",
  banner: "Banner",
  both: "Both",
};

/// Prefixes worth offering in the "add a rule" list, with what they cover.
/// Not exhaustive and not enforced — the field takes any prefix, because the
/// whole point of an open `kind` is that a build can be told about a family it
/// does not ship with.
const SUGGESTED: { prefix: string; what: string }[] = [
  { prefix: "agent.", what: "Every agent turn" },
  { prefix: "run.", what: "Fan-out runs and their legs" },
  { prefix: "trigger.", what: "Rules firing" },
  { prefix: "git.", what: "Commits, branches, operations" },
  { prefix: "terminal.", what: "Commands finishing in a pane" },
  { prefix: "review.", what: "Diff comments" },
  { prefix: "hill.", what: "Hill chart moves" },
];

export function NotificationsPane() {
  const [config, { mutate, refetch }] = createResource(() => notifyApi.config());
  const [newPrefix, setNewPrefix] = createSignal("");

  /// Write through, optimistically. A settings control that waits for a round
  /// trip before moving reads as broken on a slow machine, and the failure mode
  /// here is recoverable: on error we refetch, so the screen goes back to
  /// telling the truth rather than sitting on a lie.
  const write = (next: NotifyConfig) => {
    mutate(next);
    void notifyApi.setConfig(next).catch((e) => {
      pushToast(`Could not save notification settings: ${e}`, "error");
      void refetch();
    });
  };

  const patch = (partial: Partial<NotifyConfig>) => {
    const current = config();
    if (current) write({ ...current, ...partial });
  };

  const setLevel = (prefix: string, level: NotifyLevel) => {
    const current = config();
    if (!current) return;
    write({
      ...current,
      rules: current.rules.map((r) => (r.prefix === prefix ? { ...r, level } : r)),
    });
  };

  const addRule = () => {
    const current = config();
    const prefix = newPrefix().trim();
    if (!current || !prefix) return;
    if (current.rules.some((r) => r.prefix === prefix)) {
      pushToast(`There is already a rule for “${prefix}”`, "warning");
      return;
    }
    write({ ...current, rules: [...current.rules, { prefix, level: "banner" }] });
    setNewPrefix("");
  };

  const removeRule = (prefix: string) => {
    const current = config();
    if (!current) return;
    write({ ...current, rules: current.rules.filter((r) => r.prefix !== prefix) });
  };

  const quiet = () => config()?.quietHours ?? null;

  return (
    <div class="space-y-5 max-w-2xl">
      <Show
        when={config()}
        fallback={
          <div class="flex items-center gap-2 text-muted-foreground">
            <Loader2 class="w-3.5 h-3.5 animate-spin" />
            Reading notification settings…
          </div>
        }
      >
        {(cfg) => (
          <>
            {/* The global switch, first and unmissable. §7.5.5's "a way out"
                applied to a channel rather than to a dialog: the control that
                stops the interruptions must not itself be something you have to
                go looking for. */}
            <label class="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={cfg().muted}
                onChange={(e) => patch({ muted: e.currentTarget.checked })}
                class="accent-primary"
              />
              <BellOff class="w-3.5 h-3.5 text-muted-foreground" />
              <span>Mute every notification and cue</span>
            </label>

            <fieldset disabled={cfg().muted} class={cfg().muted ? "opacity-50" : ""}>
              <div class="space-y-4">
                <section>
                  <h3 class="font-medium mb-1">What interrupts you</h3>
                  <p class="text-muted-foreground mb-2">
                    Rows are event-kind prefixes. The most specific matching row wins, so a
                    rule for <code class="font-mono">agent.turn.failed</code> overrides one
                    for <code class="font-mono">agent.</code> regardless of order.
                  </p>

                  <table class="w-full text-left">
                    <thead class="text-muted-foreground">
                      <tr>
                        <th class="font-normal pb-1">Event</th>
                        <For each={NOTIFY_LEVELS}>
                          {(level) => (
                            <th
                              class="font-normal pb-1 text-center w-16"
                              title={LEVEL_HELP[level]}
                            >
                              {LEVEL_LABEL[level]}
                            </th>
                          )}
                        </For>
                        <th class="w-6" />
                      </tr>
                    </thead>
                    <tbody>
                      <For each={cfg().rules}>
                        {(rule: NotifyRule) => (
                          <tr class="border-t border-border/60">
                            <td class="py-1 font-mono">{rule.prefix}</td>
                            <For each={NOTIFY_LEVELS}>
                              {(level) => (
                                <td class="text-center">
                                  <input
                                    type="radio"
                                    name={`level-${rule.prefix}`}
                                    checked={rule.level === level}
                                    onChange={() => setLevel(rule.prefix, level)}
                                    aria-label={`${rule.prefix}: ${LEVEL_LABEL[level]}`}
                                    class="accent-primary"
                                  />
                                </td>
                              )}
                            </For>
                            <td>
                              <button
                                onClick={() => removeRule(rule.prefix)}
                                aria-label={`Remove the rule for ${rule.prefix}`}
                                title="Remove this rule"
                                class="p-0.5 rounded text-muted-foreground hover:text-destructive hover:bg-accent/40"
                              >
                                <Trash2 class="w-3 h-3" />
                              </button>
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>

                  <div class="flex items-center gap-2 mt-2">
                    <input
                      value={newPrefix()}
                      onInput={(e) => setNewPrefix(e.currentTarget.value)}
                      onKeyDown={(e) => e.key === "Enter" && addRule()}
                      list="notify-prefixes"
                      placeholder="A kind prefix, e.g. review."
                      aria-label="New rule prefix"
                      class="flex-1 px-2 py-1 rounded bg-input border border-border font-mono focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    />
                    <datalist id="notify-prefixes">
                      <For each={SUGGESTED}>
                        {(s) => <option value={s.prefix}>{s.what}</option>}
                      </For>
                    </datalist>
                    <button
                      onClick={addRule}
                      class="flex items-center gap-1 px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
                    >
                      <Plus class="w-3 h-3" />
                      Add
                    </button>
                  </div>
                  <p class="text-muted-foreground mt-1">
                    Commits are deliberately absent from the defaults. A notification per
                    commit is how a person turns notifications off entirely — and then
                    misses the agent that failed overnight.
                  </p>
                </section>

                <section>
                  <h3 class="font-medium mb-1">Sound</h3>
                  <div class="flex items-center gap-3">
                    <label class="flex items-center gap-2">
                      <span class="text-muted-foreground">Pack</span>
                      <select
                        value={cfg().pack}
                        onChange={(e) => patch({ pack: e.currentTarget.value })}
                        class="px-2 py-1 rounded bg-input border border-border"
                      >
                        <option value="default">Default</option>
                        <option value="silent">Silent</option>
                      </select>
                    </label>
                    <label class="flex items-center gap-2 flex-1">
                      <span class="text-muted-foreground">Volume</span>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        value={cfg().volume}
                        onInput={(e) => patch({ volume: Number(e.currentTarget.value) })}
                        aria-label="Cue volume"
                        class="flex-1 accent-primary"
                      />
                      <span class="font-mono tabular-nums w-8 text-right">
                        {Math.round(cfg().volume * 100)}%
                      </span>
                    </label>
                    {/* Hearing it is the only way to judge a volume. The cue
                        plays through the same Rust path a real one would, so
                        this is a test of the thing and not of a preview. */}
                    <button
                      onClick={() => {
                        void notifyApi.testCue().catch((e) => {
                          // The likeliest cause by far is no audio device — a
                          // headless session, or an OS that has taken exclusive
                          // hold of it. Saying so beats a button that silently
                          // does nothing, which reads as a broken button.
                          pushToast(`Could not play a cue: ${e}`, "warning");
                        });
                      }}
                      title="Play a cue at this volume"
                      class="flex items-center gap-1 px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
                    >
                      <Play class="w-3 h-3" />
                      Test
                    </button>
                  </div>
                  <p class="text-muted-foreground mt-1">
                    A banner brings the platform's own sound, which respects Do Not Disturb
                    — so a cue is only played for rows set to <b>Sound</b>, never on top of
                    a banner.
                  </p>
                </section>

                <section>
                  <h3 class="font-medium mb-1">Quiet hours</h3>
                  <label class="flex items-center gap-2 cursor-pointer mb-1">
                    <input
                      type="checkbox"
                      checked={!!quiet()}
                      onChange={(e) =>
                        patch({ quietHours: e.currentTarget.checked ? [22, 8] : null })
                      }
                      class="accent-primary"
                    />
                    <span>Say nothing between</span>
                  </label>
                  <Show when={quiet()}>
                    {(q) => (
                      <div class="flex items-center gap-2 pl-6">
                        <HourPicker
                          value={q()[0]}
                          label="Quiet hours start"
                          onChange={(h) => patch({ quietHours: [h, q()[1]] })}
                        />
                        <span class="text-muted-foreground">and</span>
                        <HourPicker
                          value={q()[1]}
                          label="Quiet hours end"
                          onChange={(h) => patch({ quietHours: [q()[0], h] })}
                        />
                      </div>
                    )}
                  </Show>
                  <p class="text-muted-foreground mt-1">
                    Hours are UTC, not local — converting properly would mean a timezone
                    dependency for one integer, and that trade has not been made yet.
                  </p>
                </section>

                <section>
                  <h3 class="font-medium mb-1">Bursts</h3>
                  <label class="flex items-center gap-2">
                    <span class="text-muted-foreground">Collapse events arriving within</span>
                    <input
                      type="number"
                      min="0"
                      step="500"
                      value={cfg().coalesceMs}
                      onChange={(e) => patch({ coalesceMs: Number(e.currentTarget.value) })}
                      aria-label="Coalescing window in milliseconds"
                      class="w-20 px-2 py-1 rounded bg-input border border-border font-mono tabular-nums"
                    />
                    <span class="text-muted-foreground">ms</span>
                  </label>
                  <p class="text-muted-foreground mt-1">
                    Five legs of one fan-out failing at once is one notification saying so,
                    not five. Nothing is dropped — the banner says how many it stands for.
                  </p>
                </section>
              </div>
            </fieldset>
          </>
        )}
      </Show>
    </div>
  );
}

function HourPicker(props: { value: number; label: string; onChange: (h: number) => void }) {
  return (
    <select
      value={props.value}
      onChange={(e) => props.onChange(Number(e.currentTarget.value))}
      aria-label={props.label}
      class="px-2 py-1 rounded bg-input border border-border font-mono tabular-nums"
    >
      <For each={Array.from({ length: 24 }, (_, i) => i)}>
        {(h) => <option value={h}>{String(h).padStart(2, "0")}:00</option>}
      </For>
    </select>
  );
}
