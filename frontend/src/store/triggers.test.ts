/// Triggers. Every safety property gets a test, because each one is a way this
/// feature spends the user's money in a loop while they are asleep.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JournalEvent } from "@/api/journal";

const record = vi.fn();
let broadcast: ((events: JournalEvent[]) => void) | null = null;
const unsubscribe = vi.fn();

vi.mock("@/store/journal", () => ({
  record: (e: unknown) => record(e),
  onJournalAppended: (h: (events: JournalEvent[]) => void) => {
    broadcast = h;
    return unsubscribe;
  },
}));

// `vi.hoisted` because the mock factory runs before module-level `const`s: the
// store reads the kill switch at import time, so `readRaw` has to be callable
// before this file's own initialisers have run.
const raw = vi.hoisted(() => ({}) as Record<string, string>);
vi.mock("@/store/layout/persistence", () => ({
  STORAGE_KEYS: { triggers: "voidlink-triggers", triggersArmed: "voidlink-triggers-armed" },
  readJson: <T,>(_k: string, fallback: T) => fallback,
  writeJson: () => {},
  readRaw: (k: string) => raw[k] ?? null,
  writeRaw: (k: string, v: string) => {
    raw[k] = v;
  },
}));

import {
  MAX_DEPTH,
  MIN_INTERVAL_FLOOR_MS,
  addTriggerRule,
  armTriggers,
  dryRun,
  evaluate,
  evaluateBatch,
  expandPrompt,
  lineageOf,
  removeTriggerRule,
  resetTriggers,
  reviveTriggers,
  setTriggerRuleEnabled,
  setTriggerRunner,
  setTriggersArmed,
  triggerRules,
  triggersArmed,
  type TriggerRule,
} from "./triggers";

const REPO = "/repos/api";

function rule(partial: Partial<TriggerRule> = {}): TriggerRule {
  return {
    id: "r1",
    repo: REPO,
    name: "Run tests",
    kinds: ["git.commit"],
    actors: [],
    agentId: "a1",
    prompt: "A commit landed: {{summary}}",
    enabled: true,
    minIntervalMs: MIN_INTERVAL_FLOOR_MS,
    lastFiredAt: null,
    ...partial,
  };
}

function event(partial: Partial<JournalEvent> = {}): JournalEvent {
  return {
    id: "e1",
    at: 1_000,
    kind: "git.commit",
    actor: "user",
    actorName: null,
    repo: REPO,
    workspace: "api",
    subject: "Extract the parser",
    summary: "Committed “Extract the parser”",
    data: {},
    ...partial,
  };
}

beforeEach(() => {
  resetTriggers();
  record.mockReset();
  unsubscribe.mockReset();
  broadcast = null;
});

afterEach(() => resetTriggers());

describe("evaluate — the safety argument", () => {
  it("fires on a matching event", () => {
    expect(evaluate(rule(), event(), 10_000)).toEqual({ fires: true });
  });

  it("does not fire while disabled", () => {
    expect(evaluate(rule({ enabled: false }), event(), 10_000)).toMatchObject({
      reason: "disabled",
    });
  });

  it("does not fire for another repository", () => {
    expect(evaluate(rule(), event({ repo: "/other" }), 10_000)).toMatchObject({
      reason: "wrong-repo",
    });
  });

  it("matches kinds as prefixes, like every other kind filter", () => {
    const r = rule({ kinds: ["git."] });
    expect(evaluate(r, event({ kind: "git.branch.switched" }), 10_000).fires).toBe(true);
    expect(evaluate(r, event({ kind: "agent.turn.finished" }), 10_000)).toMatchObject({
      reason: "wrong-kind",
    });
  });

  /// The default that keeps a rule from reacting to agent work whose lineage
  /// Rust cannot tag — the git events the watcher derives have no provenance.
  it("excludes agent-caused events unless the rule opts in", () => {
    expect(evaluate(rule(), event({ actor: "agent" }), 10_000)).toMatchObject({
      reason: "wrong-actor",
    });
    expect(evaluate(rule({ actors: ["agent"] }), event({ actor: "agent" }), 10_000).fires).toBe(
      true,
    );
  });

  /// A rule reacting to its own output is a loop at any depth, so the id check
  /// is independent of the depth cap.
  it("never fires on an event carrying its own id", () => {
    const e = event({ data: { triggeredBy: "r1", triggerDepth: 1 } });
    expect(evaluate(rule(), e, 10_000)).toMatchObject({ reason: "own-lineage" });
  });

  it("refuses anything past the depth cap, whichever rule caused it", () => {
    const e = event({ data: { triggeredBy: "other-rule", triggerDepth: MAX_DEPTH } });
    expect(evaluate(rule(), e, 10_000)).toMatchObject({ reason: "too-deep" });
  });

  it("allows one generation of rule reacting to rule", () => {
    const e = event({ data: { triggeredBy: "other-rule", triggerDepth: 1 } });
    expect(evaluate(rule(), e, 10_000).fires).toBe(true);
  });

  /// Twenty files saved in one second is one intention, not twenty.
  it("rate-limits inside the rule's own interval", () => {
    const r = rule({ lastFiredAt: 10_000, minIntervalMs: 30_000 });
    expect(evaluate(r, event(), 20_000)).toMatchObject({ reason: "rate-limited" });
    expect(evaluate(r, event(), 41_000).fires).toBe(true);
  });
});

describe("lineageOf", () => {
  it("reads a tagged event", () => {
    expect(lineageOf(event({ data: { triggeredBy: "r9", triggerDepth: 2 } }))).toEqual({
      ruleId: "r9",
      depth: 2,
    });
  });

  /// `data` is a free-form bag that anything may write. A garbage value must
  /// not produce a `NaN` depth that compares false against every cap.
  it("treats a malformed or absent bag as no lineage", () => {
    expect(lineageOf(event({ data: null }))).toEqual({ ruleId: null, depth: 0 });
    expect(lineageOf(event({ data: "nonsense" }))).toEqual({ ruleId: null, depth: 0 });
    expect(lineageOf(event({ data: { triggerDepth: "deep" } })).depth).toBe(0);
    expect(lineageOf(event({ data: { triggerDepth: Number.NaN } })).depth).toBe(0);
  });
});

describe("expandPrompt", () => {
  it("expands the event's fields", () => {
    expect(expandPrompt("{{kind}} in {{repo}}: {{summary}} ({{subject}})", event())).toBe(
      "git.commit in /repos/api: Committed “Extract the parser” (Extract the parser)",
    );
  });

  /// A typo that silently produced an empty string would send the agent a
  /// prompt with a hole in it and no way to notice.
  it("leaves an unknown placeholder verbatim", () => {
    expect(expandPrompt("{{summry}}", event())).toBe("{{summry}}");
  });

  it("renders an absent subject as empty rather than as `null`", () => {
    expect(expandPrompt("[{{subject}}]", event({ subject: null }))).toBe("[]");
  });
});

describe("dryRun", () => {
  /// The point is to try a rule *before* turning it on.
  it("evaluates a disabled rule as if it were enabled", () => {
    const hits = dryRun(rule({ enabled: false }), [event()]);
    expect(hits).toHaveLength(1);
    expect(hits[0].prompt).toContain("Extract the parser");
  });

  /// The number of turns it would really have started, not the number of
  /// matching events — otherwise a burst reads as twenty runs.
  it("honours the rate limit across history", () => {
    const events = [
      event({ id: "a", at: 0 }),
      event({ id: "b", at: 1_000 }),
      event({ id: "c", at: 100_000 }),
    ];
    const hits = dryRun(rule({ minIntervalMs: 10_000 }), events);
    expect(hits.map((h) => h.event.id)).toEqual(["a", "c"]);
  });

  it("reports nothing for a rule that matches nothing", () => {
    expect(dryRun(rule({ kinds: ["nothing."] }), [event()])).toEqual([]);
  });

  it("does not mutate the rule it is simulating", () => {
    const r = rule();
    dryRun(r, [event()]);
    expect(r.lastFiredAt).toBeNull();
  });
});

describe("the kill switch", () => {
  it("is off until it is turned on", () => {
    expect(triggersArmed()).toBe(false);
    expect(evaluateBatch([event()], 10_000)).toEqual([]);
  });

  it("stops every rule the moment it goes off", () => {
    const id = addTriggerRule({ repo: REPO, name: "t", kinds: ["git."], agentId: "a", prompt: "p" })!;
    setTriggerRuleEnabled(REPO, id, true);
    setTriggersArmed(true);
    expect(evaluateBatch([event()], 10_000)).toHaveLength(1);

    setTriggersArmed(false);
    expect(evaluateBatch([event()], 10_000)).toEqual([]);
  });

  it("records being turned on and off", () => {
    setTriggersArmed(true);
    setTriggersArmed(false);
    expect(record.mock.calls.map((c) => c[0].kind)).toEqual([
      "trigger.armed",
      "trigger.disarmed",
    ]);
  });
});

describe("evaluateBatch", () => {
  function armedRule(partial: Partial<Parameters<typeof addTriggerRule>[0]> = {}) {
    const id = addTriggerRule({
      repo: REPO,
      name: "Run tests",
      kinds: ["git.commit"],
      agentId: "a1",
      prompt: "{{summary}}",
      ...partial,
    })!;
    setTriggerRuleEnabled(partial.repo ?? REPO, id, true);
    setTriggersArmed(true);
    return id;
  }

  /// Evaluating the rest of a burst after a rule fires can only ever produce
  /// rate-limited verdicts, and doing it anyway invites an off-by-one.
  it("fires a rule at most once per batch", () => {
    armedRule();
    const firings = evaluateBatch([event({ id: "a" }), event({ id: "b" })], 10_000);
    expect(firings).toHaveLength(1);
    expect(firings[0].event.id).toBe("a");
  });

  it("stamps the lineage the resulting turn must carry", () => {
    const id = armedRule();
    const [firing] = evaluateBatch([event()], 10_000);
    expect(firing.lineage).toEqual({ ruleId: id, depth: 1 });
  });

  it("deepens the lineage of an already-triggered event", () => {
    armedRule();
    const [firing] = evaluateBatch(
      [event({ data: { triggeredBy: "someone-else", triggerDepth: 1 } })],
      10_000,
    );
    expect(firing.lineage.depth).toBe(2);
  });

  it("ignores events with no repository", () => {
    armedRule();
    expect(evaluateBatch([event({ repo: null })], 10_000)).toEqual([]);
  });
});

describe("arming the listener", () => {
  it("runs the injected runner and records the firing", () => {
    const id = addTriggerRule({
      repo: REPO,
      name: "Run tests",
      kinds: ["git.commit"],
      agentId: "a1",
      prompt: "{{summary}}",
    })!;
    setTriggerRuleEnabled(REPO, id, true);
    setTriggersArmed(true);

    const runner = vi.fn();
    setTriggerRunner(runner);
    const dispose = armTriggers();
    record.mockReset();

    broadcast?.([event()]);

    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0][0].prompt).toBe("Committed “Extract the parser”");
    expect(record.mock.calls[0][0]).toMatchObject({ kind: "trigger.fired", repo: REPO });

    dispose();
    expect(unsubscribe).toHaveBeenCalled();
  });

  /// The rate limit is only real if firing actually advances the clock.
  it("advances the rule's last-fired time so the limit takes effect", () => {
    const id = addTriggerRule({
      repo: REPO,
      name: "t",
      kinds: ["git.commit"],
      agentId: "a1",
      prompt: "p",
      minIntervalMs: 60_000,
    })!;
    setTriggerRuleEnabled(REPO, id, true);
    setTriggersArmed(true);
    const runner = vi.fn();
    setTriggerRunner(runner);
    armTriggers();

    broadcast?.([event({ id: "a" })]);
    broadcast?.([event({ id: "b" })]);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("does nothing without a runner wired up", () => {
    const id = addTriggerRule({
      repo: REPO,
      name: "t",
      kinds: ["git.commit"],
      agentId: "a1",
      prompt: "p",
    })!;
    setTriggerRuleEnabled(REPO, id, true);
    setTriggersArmed(true);
    armTriggers();
    expect(() => broadcast?.([event()])).not.toThrow();
  });
});

describe("rules", () => {
  /// Something that spawns processes does not begin doing so as a side effect
  /// of being created.
  it("starts a new rule disabled", () => {
    const id = addTriggerRule({ repo: REPO, name: "t", kinds: ["git."], agentId: "a", prompt: "p" })!;
    expect(triggerRules(REPO).find((r) => r.id === id)!.enabled).toBe(false);
  });

  it("refuses a rule with no prompt or no kinds", () => {
    expect(addTriggerRule({ repo: REPO, name: "t", kinds: ["git."], agentId: "a", prompt: " " })).toBeNull();
    expect(addTriggerRule({ repo: REPO, name: "t", kinds: [], agentId: "a", prompt: "p" })).toBeNull();
  });

  it("raises an interval below the floor", () => {
    const id = addTriggerRule({
      repo: REPO,
      name: "t",
      kinds: ["git."],
      agentId: "a",
      prompt: "p",
      minIntervalMs: 10,
    })!;
    expect(triggerRules(REPO).find((r) => r.id === id)!.minIntervalMs).toBe(MIN_INTERVAL_FLOOR_MS);
  });

  it("records enabling and disabling", () => {
    const id = addTriggerRule({ repo: REPO, name: "Run tests", kinds: ["git."], agentId: "a", prompt: "p" })!;
    setTriggerRuleEnabled(REPO, id, true);
    setTriggerRuleEnabled(REPO, id, false);
    expect(record.mock.calls.map((c) => c[0].kind)).toEqual([
      "trigger.rule.enabled",
      "trigger.rule.disabled",
    ]);
  });

  it("removes a rule", () => {
    const id = addTriggerRule({ repo: REPO, name: "t", kinds: ["git."], agentId: "a", prompt: "p" })!;
    removeTriggerRule(REPO, id);
    expect(triggerRules(REPO)).toEqual([]);
  });
});

describe("reviveTriggers", () => {
  /// A rule with no kinds matches every event, which is the single most
  /// dangerous shape this can take — repairing it into something plausible
  /// would be worse than dropping it.
  it("drops a rule with no kinds or no prompt rather than repairing it", () => {
    const revived = reviveTriggers({
      [REPO]: [
        { id: "a", kinds: [], prompt: "p" },
        { id: "b", kinds: ["git."], prompt: "  " },
        { id: "c", kinds: ["git."], prompt: "p" },
      ],
    });
    expect(revived[REPO].map((r) => r.id)).toEqual(["c"]);
  });

  /// A blob that says nothing about `enabled` must not come back armed.
  it("comes back disabled unless the file explicitly said otherwise", () => {
    const revived = reviveTriggers({
      [REPO]: [
        { id: "a", kinds: ["git."], prompt: "p" },
        { id: "b", kinds: ["git."], prompt: "p", enabled: "yes" },
        { id: "c", kinds: ["git."], prompt: "p", enabled: true },
      ],
    });
    expect(revived[REPO].map((r) => r.enabled)).toEqual([false, false, true]);
  });

  it("raises an on-disk interval below the floor", () => {
    const revived = reviveTriggers({
      [REPO]: [{ id: "a", kinds: ["git."], prompt: "p", minIntervalMs: 1 }],
    });
    expect(revived[REPO][0].minIntervalMs).toBe(MIN_INTERVAL_FLOOR_MS);
  });

  it("drops actor values it does not recognise", () => {
    const revived = reviveTriggers({
      [REPO]: [{ id: "a", kinds: ["git."], prompt: "p", actors: ["user", "robot"] }],
    });
    expect(revived[REPO][0].actors).toEqual(["user"]);
  });

  it("survives a blob that is not the shape it expects", () => {
    expect(reviveTriggers(null)).toEqual({});
    expect(reviveTriggers({ [REPO]: "nope" })).toEqual({});
  });
});
