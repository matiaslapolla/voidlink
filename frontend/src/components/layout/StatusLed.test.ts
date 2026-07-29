import { describe, expect, it } from "vitest";
import { highestSignal, terminalSignal } from "./StatusLed";

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
});

describe("terminalSignal", () => {
  /// The state this mapping exists to reach. The old two-bit version had no
  /// "off": an idle unfocused shell got a grey `stale` dot, claiming the value
  /// shown was out of date when it was exactly current, and an idle *focused*
  /// shell got `finished` on a shell where nothing had finished.
  it("returns nothing for an idle shell nobody is looking at", () => {
    expect(terminalSignal({ working: false, focused: false })).toBeUndefined();
  });

  it("shows a quiet idle mark in the tab the user is looking at", () => {
    expect(terminalSignal({ working: false, focused: true })).toBe("idle");
  });

  /// Focus does not change *what* is happening, only whether the quiet state is
  /// worth drawing — so `working` is reported either way. It has to be: a shell
  /// churning in a background pane is exactly what has to escalate.
  it("reports working whether or not the tab is focused", () => {
    expect(terminalSignal({ working: true, focused: true })).toBe("working");
    expect(terminalSignal({ working: true, focused: false })).toBe("working");
  });
});
