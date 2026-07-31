/// Triggers: "when X happens, run agent Y."
///
/// Buzz's workflow binding, over the event log. Small to build, and the easiest
/// thing in this whole track to build *badly* — so the constraints below are
/// the feature, not hardening bolted on afterwards.
///
/// ## The four things that keep this safe
///
/// 1. **Re-entrancy cutoff.** A fired turn writes events; those events can match
///    rules; those rules fire turns. Two guards, because one is not enough:
///    a rule never fires on an event carrying its own id (`triggeredBy`), and no
///    rule fires on an event past `MAX_DEPTH` of lineage. On top of both, rules
///    default to **excluding agent-caused events entirely**, because the git
///    events Rust derives cannot carry lineage — the watcher sees a ref move,
///    not a provenance — and a cutoff that only works for events we happen to
///    tag is not a cutoff.
///
/// 2. **A rate limit per rule.** Twenty files saved in one second is one
///    intention, not twenty. `minIntervalMs` is per rule and enforced here
///    rather than left to the user's judgement.
///
/// 3. **A global kill switch**, checked on every evaluation, persisted, and
///    reachable without the palette. Something that starts processes on your
///    behalf needs an off switch you can find while it is misbehaving.
///
/// 4. **Dry run over history.** `dryRun` replays a rule against the log and
///    reports what *would* have fired. The log makes this free, and it is the
///    only honest way to write a rule — the alternative is enabling it and
///    finding out.
///
/// ## Why the runner is injected
///
/// This module never imports the agent runner. It exports `setTriggerRunner`,
/// and the app wires it up. That keeps a cycle out of the module graph
/// (`commands/agent.ts` already records to the journal that this listens to)
/// and, more usefully, means the whole firing path is testable without a
/// process ever being spawned.

import { createStore, produce } from "solid-js/store";
import type { Actor, JournalEvent } from "@/api/journal";
import { STORAGE_KEYS, readJson, readRaw, writeJson, writeRaw } from "@/store/layout/persistence";
import { onJournalAppended, record } from "@/store/journal";

/// How many generations of trigger-caused work may chain before the chain is
/// refused. Two: a rule may react to a rule's work, and that is the end of it.
/// Anything deeper is a loop somebody did not intend, whatever they meant.
export const MAX_DEPTH = 2;

/// The floor on `minIntervalMs`. A rule with no interval at all is a rule that
/// fires once per event in a burst.
export const MIN_INTERVAL_FLOOR_MS = 5_000;

export interface TriggerRule {
  id: string;
  /// The repository this rule watches. Rules are per repo and never global —
  /// "run the test agent on every commit" means something different in a
  /// scratch repo than in the one that deploys.
  repo: string;
  name: string;
  /// Event kinds, matched as **prefixes**, exactly as `JournalQuery.kinds` is.
  kinds: string[];
  /// Which actors may trigger this rule. Empty means the default, which is
  /// `["user", "system"]` — see `effectiveActors` and the module comment.
  actors: Actor[];
  /// The roster entry to run.
  agentId: string;
  /// The prompt, with `{{summary}}`, `{{kind}}`, `{{subject}}` and `{{repo}}`
  /// expanded from the event that fired it.
  prompt: string;
  enabled: boolean;
  minIntervalMs: number;
  lastFiredAt: number | null;
}

type RulesByRepo = Record<string, TriggerRule[]>;

/// Agent-caused events are excluded by default, and this is the reason.
///
/// A trigger that fires on `agent.*` is one rule away from a loop that spends
/// money while the user sleeps, and the lineage tag that would make it safe
/// cannot be attached to the git events Rust derives. Opting in is possible —
/// `actors` is a real field — but it is a decision the user makes explicitly.
const DEFAULT_ACTORS: Actor[] = ["user", "system"];

export function effectiveActors(rule: TriggerRule): Actor[] {
  return rule.actors.length > 0 ? rule.actors : DEFAULT_ACTORS;
}

function reviveRule(raw: unknown, repo: string): TriggerRule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const prompt = typeof r.prompt === "string" ? r.prompt.trim() : "";
  const kinds = Array.isArray(r.kinds) ? r.kinds.filter((k): k is string => typeof k === "string") : [];
  // A rule with no prompt has nothing to run, and one with no kinds matches
  // every event — which is the single most dangerous shape this can take, so
  // it is dropped rather than repaired into something plausible.
  if (!prompt || kinds.length === 0) return null;
  const interval = typeof r.minIntervalMs === "number" ? r.minIntervalMs : 0;
  return {
    id: typeof r.id === "string" && r.id ? r.id : crypto.randomUUID(),
    repo,
    name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : "Untitled rule",
    kinds,
    actors: Array.isArray(r.actors)
      ? r.actors.filter((a): a is Actor => a === "user" || a === "agent" || a === "system")
      : [],
    agentId: typeof r.agentId === "string" ? r.agentId : "",
    prompt,
    // A rule read off disk starts disabled unless it was explicitly enabled.
    enabled: r.enabled === true,
    minIntervalMs: Math.max(MIN_INTERVAL_FLOOR_MS, interval),
    lastFiredAt: typeof r.lastFiredAt === "number" ? r.lastFiredAt : null,
  };
}

export function reviveTriggers(raw: unknown): RulesByRepo {
  if (!raw || typeof raw !== "object") return {};
  const out: RulesByRepo = {};
  for (const [repo, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const rules = list
      .map((entry) => reviveRule(entry, repo))
      .filter((r): r is TriggerRule => r !== null);
    if (rules.length) out[repo] = rules;
  }
  return out;
}

const [rules, setRules] = createStore<RulesByRepo>(
  reviveTriggers(readJson<unknown>(STORAGE_KEYS.triggers, {})),
);

/// The kill switch. Off by default — nothing in this app starts a process on
/// the user's behalf until they say so once.
let armed = readRaw(STORAGE_KEYS.triggersArmed) === "true";

export function triggersArmed(): boolean {
  return armed;
}

export function setTriggersArmed(next: boolean): void {
  if (armed === next) return;
  armed = next;
  writeRaw(STORAGE_KEYS.triggersArmed, String(next));
  record({
    kind: next ? "trigger.armed" : "trigger.disarmed",
    actor: "user",
    summary: next ? "Turned triggers on" : "Turned triggers off",
    data: {},
  });
}

function persist(): void {
  writeJson(STORAGE_KEYS.triggers, rules);
}

export function triggerRules(repo: string): TriggerRule[] {
  return rules[repo] ?? [];
}

// ── Matching ─────────────────────────────────────────────────────────────────

/// Why a rule did or did not fire. Always populated, because this is what the
/// dry run shows and what makes a rule debuggable without enabling it.
export type MatchVerdict =
  | { fires: true }
  | {
      fires: false;
      reason:
        | "disabled"
        | "wrong-repo"
        | "wrong-kind"
        | "wrong-actor"
        | "own-lineage"
        | "too-deep"
        | "rate-limited";
    };

/// The lineage a trigger-caused event carries, if any.
export interface Lineage {
  ruleId: string | null;
  depth: number;
}

/// Read lineage off an event's free-form `data` bag, defensively.
export function lineageOf(event: JournalEvent): Lineage {
  const data = event.data;
  if (!data || typeof data !== "object") return { ruleId: null, depth: 0 };
  const d = data as Record<string, unknown>;
  return {
    ruleId: typeof d.triggeredBy === "string" ? d.triggeredBy : null,
    depth: typeof d.triggerDepth === "number" && Number.isFinite(d.triggerDepth) ? d.triggerDepth : 0,
  };
}

/// Would this rule fire on this event, right now?
///
/// Pure, and the whole of the safety argument lives here rather than in the
/// listener — which is why the listener is four lines and this has tests.
export function evaluate(rule: TriggerRule, event: JournalEvent, now: number): MatchVerdict {
  if (!rule.enabled) return { fires: false, reason: "disabled" };
  if (event.repo !== rule.repo) return { fires: false, reason: "wrong-repo" };
  if (!rule.kinds.some((k) => event.kind.startsWith(k))) {
    return { fires: false, reason: "wrong-kind" };
  }
  if (!effectiveActors(rule).includes(event.actor)) {
    return { fires: false, reason: "wrong-actor" };
  }

  const lineage = lineageOf(event);
  // A rule reacting to its own output is a loop, at any depth.
  if (lineage.ruleId === rule.id) return { fires: false, reason: "own-lineage" };
  if (lineage.depth >= MAX_DEPTH) return { fires: false, reason: "too-deep" };

  if (rule.lastFiredAt !== null && now - rule.lastFiredAt < rule.minIntervalMs) {
    return { fires: false, reason: "rate-limited" };
  }
  return { fires: true };
}

export interface DryRunHit {
  event: JournalEvent;
  prompt: string;
}

/// What this rule *would* have done over a window of history.
///
/// Evaluates as if the rule were enabled — the point is to try a rule before
/// turning it on — but honours the rate limit, advancing a simulated
/// `lastFiredAt` as it goes, so the answer is the number of turns it would
/// really have started and not the number of matching events.
export function dryRun(rule: TriggerRule, events: readonly JournalEvent[]): DryRunHit[] {
  const hits: DryRunHit[] = [];
  const simulated: TriggerRule = { ...rule, enabled: true, lastFiredAt: null };
  for (const event of events) {
    const verdict = evaluate(simulated, event, event.at);
    if (!verdict.fires) continue;
    simulated.lastFiredAt = event.at;
    hits.push({ event, prompt: expandPrompt(rule.prompt, event) });
  }
  return hits;
}

/// Expand `{{summary}}`, `{{kind}}`, `{{subject}}` and `{{repo}}`.
///
/// Unknown placeholders are left verbatim rather than blanked: a typo that
/// silently produced an empty string would send the agent a prompt with a hole
/// in it and no way to notice.
export function expandPrompt(template: string, event: JournalEvent): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => {
    switch (key) {
      case "summary":
        return event.summary;
      case "kind":
        return event.kind;
      case "subject":
        return event.subject ?? "";
      case "repo":
        return event.repo ?? "";
      default:
        return whole;
    }
  });
}

// ── Firing ───────────────────────────────────────────────────────────────────

export interface TriggerFiring {
  rule: TriggerRule;
  event: JournalEvent;
  prompt: string;
  /// The lineage the resulting turn must stamp onto everything it records, so
  /// the re-entrancy cutoff can see it next time round.
  lineage: Lineage;
}

export type TriggerRunner = (firing: TriggerFiring) => void;

let runner: TriggerRunner | null = null;

/// Wire up what actually runs an agent. See the module comment for why this is
/// injected rather than imported.
export function setTriggerRunner(next: TriggerRunner | null): void {
  runner = next;
}

/// Evaluate one batch of events against every rule. Exported for its own test.
///
/// At most **one firing per rule per batch**: the rate limit already prevents a
/// burst from firing twice, and evaluating the rest of the batch after a rule
/// has fired would only ever produce rate-limited verdicts.
export function evaluateBatch(events: readonly JournalEvent[], now: number): TriggerFiring[] {
  if (!armed) return [];
  const firings: TriggerFiring[] = [];
  const fired = new Set<string>();
  for (const event of events) {
    if (!event.repo) continue;
    for (const rule of triggerRules(event.repo)) {
      if (fired.has(rule.id)) continue;
      if (!evaluate(rule, event, now).fires) continue;
      fired.add(rule.id);
      firings.push({
        rule,
        event,
        prompt: expandPrompt(rule.prompt, event),
        lineage: { ruleId: rule.id, depth: lineageOf(event).depth + 1 },
      });
    }
  }
  return firings;
}

/// Start listening. Returns a disposer.
///
/// Called once from the workbench and from nowhere else: three windows each
/// arming the same rules would run each firing three times, which is the same
/// argument that put the log in Rust.
export function armTriggers(): () => void {
  return onJournalAppended((events) => {
    const now = Date.now();
    for (const firing of evaluateBatch(events, now)) {
      setRules(
        firing.rule.repo,
        (r) => r.id === firing.rule.id,
        "lastFiredAt",
        now,
      );
      persist();
      record({
        kind: "trigger.fired",
        actor: "system",
        repo: firing.rule.repo,
        subject: firing.rule.name,
        summary: `“${firing.rule.name}” fired on ${firing.event.kind}`,
        data: {
          ruleId: firing.rule.id,
          because: firing.event.id,
          triggeredBy: firing.lineage.ruleId,
          triggerDepth: firing.lineage.depth,
        },
      });
      runner?.(firing);
    }
  });
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export interface NewRule {
  repo: string;
  name: string;
  kinds: string[];
  actors?: Actor[];
  agentId: string;
  prompt: string;
  minIntervalMs?: number;
}

/// Add a rule. Returns its id, or `null` when it could not be built.
///
/// A rule always starts **disabled**. Something that spawns processes does not
/// get to begin doing so as a side effect of being created.
export function addTriggerRule(init: NewRule): string | null {
  const prompt = init.prompt.trim();
  const kinds = init.kinds.map((k) => k.trim()).filter(Boolean);
  if (!prompt || kinds.length === 0 || !init.repo) return null;
  const rule: TriggerRule = {
    id: crypto.randomUUID(),
    repo: init.repo,
    name: init.name.trim() || "Untitled rule",
    kinds,
    actors: init.actors ?? [],
    agentId: init.agentId,
    prompt,
    enabled: false,
    minIntervalMs: Math.max(MIN_INTERVAL_FLOOR_MS, init.minIntervalMs ?? MIN_INTERVAL_FLOOR_MS),
    lastFiredAt: null,
  };
  setRules(produce((s) => {
    (s[init.repo] ??= []).push(rule);
  }));
  persist();
  return rule.id;
}

export function setTriggerRuleEnabled(repo: string, ruleId: string, enabled: boolean): void {
  const rule = triggerRules(repo).find((r) => r.id === ruleId);
  if (!rule || rule.enabled === enabled) return;
  setRules(repo, (r) => r.id === ruleId, "enabled", enabled);
  persist();
  record({
    kind: enabled ? "trigger.rule.enabled" : "trigger.rule.disabled",
    actor: "user",
    repo,
    subject: rule.name,
    summary: `${enabled ? "Enabled" : "Disabled"} the trigger “${rule.name}”`,
    data: { ruleId },
  });
}

export function removeTriggerRule(repo: string, ruleId: string): void {
  if (!triggerRules(repo).some((r) => r.id === ruleId)) return;
  setRules(produce((s) => {
    const list = s[repo];
    if (!list) return;
    s[repo] = list.filter((r) => r.id !== ruleId);
  }));
  persist();
}

/// Test seam.
export function resetTriggers(): void {
  runner = null;
  armed = false;
  setRules(produce((s) => {
    for (const key of Object.keys(s)) delete s[key];
  }));
  persist();
}
