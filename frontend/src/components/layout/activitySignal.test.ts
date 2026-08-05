import { describe, expect, it } from "vitest";
import {
  ACTIVITY_SIGNALS,
  highestSignal,
  ledLabel,
  ledShape,
  signalStyles,
  terminalSignal,
} from "./activitySignal";

describe("highestSignal", () => {
  it("returns nothing for an empty signal set", () => {
    expect(highestSignal([])).toBeUndefined();
    expect(highestSignal([undefined, null])).toBeUndefined();
  });

  /// MASTER.md §7.5.3 rule 2. The ordering exists because a tab with a dirty
  /// buffer *and* a failed process must report the failure — the case a naive
  /// "last signal wins" implementation gets backwards.
  it("applies failed > notify > working > finished > dirty > idle", () => {
    expect(highestSignal(["dirty", "failed"])).toBe("failed");
    expect(highestSignal(["dirty", "working"])).toBe("working");
    expect(highestSignal(["finished", "notify"])).toBe("notify");
    expect(highestSignal(["dirty", "finished"])).toBe("finished");
    expect(highestSignal(["working", "failed", "notify", "dirty"])).toBe("failed");
    expect(highestSignal(["idle", "dirty"])).toBe("dirty");
  });

  /// The single ordering the terminal rework turns on.
  ///
  /// A TUI keeps its shell in the foreground for its whole life, so `working` is
  /// live the entire time Claude Code is open. With `notify` below it — which is
  /// where `bell` sat, under `running` — a completion notification raised from
  /// inside that TUI could never be rendered, which is precisely the event the
  /// user is waiting for.
  it("puts notify above working, so a TUI cannot mask its own notification", () => {
    expect(highestSignal(["working", "notify"])).toBe("notify");
    expect(highestSignal(["notify", "working"])).toBe("notify");
    // A failure still outranks it: an error is not superseded by a chime.
    expect(highestSignal(["working", "notify", "failed"])).toBe("failed");
  });

  /// `idle` is the absence of news, so anything else a tab carries wins.
  it("ranks idle last", () => {
    for (const other of ["failed", "notify", "working", "running", "finished", "dirty", "stale"] as const) {
      expect(highestSignal(["idle", other])).toBe(other);
    }
  });

  it("is order-independent", () => {
    expect(highestSignal(["failed", "dirty"])).toBe(highestSignal(["dirty", "failed"]));
  });

  /// The ordering the agent vocabulary turns on, and the direct analogue of the
  /// `notify` case above. An agent asking for permission keeps its shell in the
  /// foreground for the whole time it is asking, so `working` is live
  /// throughout — rank `waiting` below it and the prompt is unrenderable by
  /// construction.
  it("puts waiting above working, so a live agent cannot mask its own prompt", () => {
    expect(highestSignal(["working", "waiting"])).toBe("waiting");
    expect(highestSignal(["waiting", "working"])).toBe("waiting");
    // Above `notify` too: "answer me" is not superseded by "this finished".
    expect(highestSignal(["waiting", "notify"])).toBe("waiting");
    // But a failure still wins. An error is not a question.
    expect(highestSignal(["waiting", "failed"])).toBe("failed");
  });
});

/// The closed set is only closed if adding a member is impossible to do
/// halfway. These assert over `ACTIVITY_SIGNALS` rather than a hand-written
/// list, so a tenth signal fails here the moment it is declared.
describe("the signal tables", () => {
  it("covers every signal with a style, a pending ring and a rank", () => {
    for (const signal of ACTIVITY_SIGNALS) {
      const style = signalStyles(signal);
      expect(style.fill, signal).toBeTruthy();
      expect(style.tone, signal).toBeTruthy();
      expect(style.pendingRing, signal).toBeTruthy();
      expect(style.rank, signal).toBeGreaterThanOrEqual(0);
    }
  });

  it("gives every signal non-empty screen-reader text", () => {
    for (const signal of ACTIVITY_SIGNALS) {
      expect(ledLabel(signal), signal).toBeTruthy();
      expect(ledLabel(signal, true), signal).toContain(ledLabel(signal));
    }
  });

  it("ranks every signal exactly once", () => {
    const ranks = ACTIVITY_SIGNALS.map((s) => signalStyles(s).rank);
    expect(new Set(ranks).size).toBe(ACTIVITY_SIGNALS.length);
  });

  /// §7.5.3 rule 4: colour is never the only channel. The three agent states
  /// are the ones that earn a shape, and `finished` is the only one that
  /// differs by density — a tick on a board, a dot in a strip.
  it("gives the agent states a shape, not just a hue", () => {
    expect(ledShape("working")).toBe("spinner");
    expect(ledShape("waiting")).toBe("question");
    expect(ledShape("finished", "comfortable")).toBe("check");
    expect(ledShape("finished", "compact")).toBe("dot");
    expect(ledShape("idle", "comfortable")).toBe("dot");
    expect(ledShape("failed", "comfortable")).toBe("dot");
  });
});

describe("terminalSignal", () => {
  /// The state this mapping exists to reach. The old two-bit version had no
  /// "off": an idle unfocused shell got a grey `stale` dot, claiming the value
  /// shown was out of date when it was exactly current, and an idle *focused*
  /// shell got `finished` on a shell where nothing had finished.
  it("returns nothing for an idle shell nobody is looking at", () => {
    expect(terminalSignal({ working: false, agent: true, focused: false })).toBeUndefined();
  });

  it("shows a quiet idle mark in the tab the user is looking at", () => {
    expect(terminalSignal({ working: false, agent: true, focused: true })).toBe("idle");
  });

  /// The plain-shell case, and the one the agent vocabulary added. A `zsh` at
  /// its prompt has nothing to report — which is a *different* answer from
  /// `idle`, the lit-but-quiet state of a recognised agent. Rendering a dot on
  /// every shell in the sidebar is the same as rendering none.
  it("returns nothing at all for a shell that is not a recognised agent", () => {
    expect(terminalSignal({ working: false, agent: false, focused: true })).toBeUndefined();
    expect(terminalSignal({ working: false, agent: false, focused: false })).toBeUndefined();
    // And the default is silence, so a caller that has not been taught about
    // agents cannot accidentally light up every shell.
    expect(terminalSignal({ working: false, focused: true })).toBeUndefined();
  });

  /// `working` is not an agent state. A build churning in a background pane has
  /// to escalate whatever binary is running it.
  it("still reports working for a plain shell", () => {
    expect(terminalSignal({ working: true, agent: false, focused: false })).toBe("working");
  });

  it("reports waiting over working, and only for an agent", () => {
    expect(terminalSignal({ working: true, agent: true, waiting: true, focused: true })).toBe(
      "waiting",
    );
    expect(terminalSignal({ working: false, agent: true, waiting: true, focused: false })).toBe(
      "waiting",
    );
    // `waiting` without `agent` is not a state that can exist; it is ignored
    // rather than trusted, so one careless caller cannot invent it.
    expect(
      terminalSignal({ working: false, agent: false, waiting: true, focused: true }),
    ).toBeUndefined();
  });

  /// Focus does not change *what* is happening, only whether the quiet state is
  /// worth drawing — so `working` is reported either way. It has to be: a shell
  /// churning in a background pane is exactly what has to escalate.
  it("reports working whether or not the tab is focused", () => {
    expect(terminalSignal({ working: true, agent: true, focused: true })).toBe("working");
    expect(terminalSignal({ working: true, agent: true, focused: false })).toBe("working");
  });
});
