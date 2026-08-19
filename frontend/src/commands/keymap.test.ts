import { describe, expect, it } from "vitest";
import { chordId, formatChord, matches, type Chord, type KeyEventLike } from "@/commands/keys";
import {
  KEYMAP,
  KEYMAP_GROUPS,
  chordsOf,
  primaryChordFor,
  validateKeymap,
  validateKeymapAgainstCatalog,
  validateKeymapShape,
} from "@/commands/keymap";
import { ACTION_IDS } from "@/commands/actionIds";

/// Minimal stand-in for a real KeyboardEvent. The matcher is written against
/// `KeyEventLike` precisely so these tests need no DOM.
function ev(key: string, mods: Partial<Omit<KeyEventLike, "key">> = {}): KeyEventLike {
  return {
    key,
    metaKey: mods.metaKey ?? false,
    ctrlKey: mods.ctrlKey ?? false,
    shiftKey: mods.shiftKey ?? false,
    altKey: mods.altKey ?? false,
  };
}

describe("matches", () => {
  const cmdK: Chord = { meta: true, key: "k" };

  it("matches the platform modifier as either Cmd or Ctrl", () => {
    expect(matches(cmdK, ev("k", { metaKey: true }))).toBe(true);
    expect(matches(cmdK, ev("k", { ctrlKey: true }))).toBe(true);
  });

  it("requires the modifier when the chord asks for it", () => {
    expect(matches(cmdK, ev("k"))).toBe(false);
  });

  it("rejects extra modifiers the chord did not declare", () => {
    expect(matches(cmdK, ev("k", { metaKey: true, shiftKey: true }))).toBe(false);
    expect(matches(cmdK, ev("k", { metaKey: true, altKey: true }))).toBe(false);
  });

  it("compares the key case-insensitively", () => {
    expect(matches(cmdK, ev("K", { metaKey: true }))).toBe(true);
  });

  it("distinguishes chords that differ only by a modifier", () => {
    const cmdShiftT: Chord = { meta: true, shift: true, key: "t" };
    const cmdT: Chord = { meta: true, key: "t" };
    const pressed = ev("t", { metaKey: true, shiftKey: true });
    expect(matches(cmdShiftT, pressed)).toBe(true);
    expect(matches(cmdT, pressed)).toBe(false);
  });

  it("matches multi-character key names like arrows", () => {
    const cmdAltRight: Chord = { meta: true, alt: true, key: "ArrowRight" };
    expect(matches(cmdAltRight, ev("ArrowRight", { metaKey: true, altKey: true }))).toBe(true);
    expect(matches(cmdAltRight, ev("ArrowLeft", { metaKey: true, altKey: true }))).toBe(false);
  });

  it("matches a chord with no modifiers only when none are held", () => {
    const esc: Chord = { key: "Escape" };
    expect(matches(esc, ev("Escape"))).toBe(true);
    expect(matches(esc, ev("Escape", { metaKey: true }))).toBe(false);
  });
});

describe("formatChord", () => {
  it("renders macOS glyphs with no separator", () => {
    expect(formatChord({ meta: true, shift: true, key: "p" }, true)).toBe("⌘⇧P");
  });

  it("renders words joined by + everywhere else", () => {
    expect(formatChord({ meta: true, shift: true, key: "p" }, false)).toBe("Ctrl+Shift+P");
  });

  it("orders modifiers meta then alt then shift", () => {
    expect(formatChord({ meta: true, alt: true, shift: true, key: "b" }, true)).toBe("⌘⌥⇧B");
    expect(formatChord({ meta: true, alt: true, shift: true, key: "b" }, false)).toBe(
      "Ctrl+Alt+Shift+B",
    );
  });

  it("renders arrows as glyphs on both platforms", () => {
    expect(formatChord({ meta: true, alt: true, key: "ArrowRight" }, true)).toBe("⌘⌥→");
    expect(formatChord({ meta: true, alt: true, key: "ArrowRight" }, false)).toBe("Ctrl+Alt+→");
  });

  it("maps shifted punctuation back to the physical key", () => {
    // Shift+/ reports "?" and Shift+backquote reports "~" on a US layout; the
    // label should still name the key the user presses.
    expect(formatChord({ meta: true, shift: true, key: "?" }, true)).toBe("⌘⇧/");
    expect(formatChord({ meta: true, shift: true, key: "~" }, true)).toBe("⌘⇧`");
  });

  it("leaves digits and punctuation alone", () => {
    expect(formatChord({ meta: true, key: "1" }, true)).toBe("⌘1");
    expect(formatChord({ meta: true, key: "," }, true)).toBe("⌘,");
    expect(formatChord({ meta: true, key: "\\" }, true)).toBe("⌘\\");
  });
});

describe("chordId", () => {
  it("is stable regardless of how the object was written", () => {
    expect(chordId({ key: "b", shift: true, meta: true })).toBe(
      chordId({ meta: true, shift: true, key: "B" }),
    );
  });

  it("separates chords that differ only by a modifier", () => {
    expect(chordId({ meta: true, key: "t" })).not.toBe(chordId({ meta: true, shift: true, key: "t" }));
  });
});

describe("KEYMAP integrity", () => {
  it("binds no chord twice and no action twice", () => {
    expect(validateKeymapShape()).toEqual([]);
  });

  it("references only declared actions", () => {
    expect(validateKeymapAgainstCatalog()).toEqual([]);
  });

  it("reports an unknown action id instead of ignoring it", () => {
    // Drop one id the keymap uses; validation must notice.
    const truncated = ACTION_IDS.filter((id) => id !== "palette.open");
    const problems = validateKeymap(truncated);
    expect(problems).toHaveLength(1);
    expect(problems[0].kind).toBe("unknown-action");
    expect(problems[0].detail).toContain("palette.open");
  });

  it("uses only declared groups", () => {
    for (const entry of KEYMAP) {
      expect(KEYMAP_GROUPS).toContain(entry.group);
    }
  });

  it("keeps the shortcuts the app shipped with", () => {
    // Regression guard: widening coverage must not silently remap anything.
    //
    // Two entries here were remapped on purpose, for cmux parity: ⌘T moved
    // from `workspace.new` to `terminal.new`, and `workspace.new` took ⌘N.
    // Both keep their old chord as an alternate. If you are here because this
    // test failed, the remap you just made was *not* one of those two.
    const expected: Record<string, Chord> = {
      "palette.open": { meta: true, key: "k" },
      "file.open": { meta: true, key: "p" },
      "tab.close": { meta: true, key: "w" },
      "tab.reopen-last": { meta: true, shift: true, key: "t" },
      "terminal.repeat-last": { meta: true, shift: true, key: "r" },
      "terminal.new": { meta: true, key: "t" },
      "workspace.new": { meta: true, key: "n" },
      "workspace.next": { meta: true, shift: true, key: "ArrowRight" },
      "workspace.prev": { meta: true, shift: true, key: "ArrowLeft" },
      "ui.navigate-back": { meta: true, alt: true, key: "ArrowLeft" },
      "ui.navigate-forward": { meta: true, alt: true, key: "ArrowRight" },
      "ui.toggle-left-sidebar": { meta: true, key: "b" },
      "ui.toggle-git-sidebar": { meta: true, key: "j" },
      "ui.swap-sidebars": { meta: true, key: "\\" },
      "view.toggle-blame": { meta: true, alt: true, key: "b" },
      "git.ai-draft-commit": { meta: true, shift: true, key: "m" },
      "agent.toggle": { meta: true, shift: true, key: "a" },
      "file.save": { meta: true, key: "s" },
    };
    for (const [actionId, chord] of Object.entries(expected)) {
      const actual = primaryChordFor(actionId);
      expect(actual, `${actionId} lost its binding`).toBeDefined();
      expect(chordId(actual!), `${actionId} was remapped`).toBe(chordId(chord));
    }
  });

  it("still binds ⌘1-⌘9 to the nine workspace slots", () => {
    for (let i = 1; i <= 9; i++) {
      const chord = primaryChordFor(`workspace.select.${i}`);
      expect(chord, `workspace ${i}`).toBeDefined();
      expect(chordId(chord!)).toBe(chordId({ meta: true, key: String(i) }));
    }
  });

  it("binds ⌘⌥1-⌘⌥9 to the nine tab slots, and ⌘⌥0 to the last", () => {
    // ⌘1-⌘9 are the workspace slots, so jump-to-tab-N takes the ⌥ row. ⌥ alone
    // would not match on macOS — it remaps `event.key` — but ⌘⌥ does.
    for (let i = 1; i <= 9; i++) {
      const chord = primaryChordFor(`tab.select.${i}`);
      expect(chord, `tab ${i}`).toBeDefined();
      expect(chordId(chord!)).toBe(chordId({ meta: true, alt: true, key: String(i) }));
    }
    expect(chordId(primaryChordFor("tab.select.last")!)).toBe(
      chordId({ meta: true, alt: true, key: "0" }),
    );
  });

  it("cycles the MRU on Ctrl+Tab in both directions", () => {
    expect(chordId(primaryChordFor("tab.mru-next")!)).toBe(chordId({ meta: true, key: "Tab" }));
    expect(chordId(primaryChordFor("tab.mru-prev")!)).toBe(
      chordId({ meta: true, shift: true, key: "Tab" }),
    );
  });

  it("leaves tab.next/tab.prev palette-only, and gives their chords to navigate-back/forward", () => {
    // Document-order stepping was the fourth model for moving between tabs,
    // beside MRU cycling, jump-to-N and back/forward. It is the one nobody
    // reaches for once MRU exists, and it was holding two chord pairs.
    //
    // Palette-only is a supported state, not a broken one: the actions stay
    // registered, and `primaryChordFor` returning `undefined` renders as an
    // entry with no accelerator. If this fails because someone re-bound them,
    // the question to answer first is which of the other three models they
    // intend to remove.
    expect(primaryChordFor("tab.next")).toBeUndefined();
    expect(primaryChordFor("tab.prev")).toBeUndefined();

    // Still reachable — that is the half of the decision that makes the other
    // half safe.
    expect(ACTION_IDS).toContain("tab.next");
    expect(ACTION_IDS).toContain("tab.prev");

    // And the arrows now describe the motion they actually perform.
    expect(chordId(primaryChordFor("ui.navigate-back")!)).toBe(
      chordId({ meta: true, alt: true, key: "ArrowLeft" }),
    );
    expect(chordId(primaryChordFor("ui.navigate-forward")!)).toBe(
      chordId({ meta: true, alt: true, key: "ArrowRight" }),
    );
  });

  it("leaves bare ⌘Z/⌘⇧Z unclaimed, so Monaco's own undo/redo binding gets them", () => {
    // Regression guard for the "Cmd+Z sometimes doesn't undo" report. The
    // suspect was this table — a global binding here would swallow the chord
    // in the capture-phase listener before Monaco ever saw it, the same way
    // every other entry with a `scope` note explains. It turned out not to be:
    // nothing in KEYMAP has ever claimed bare `z`, `ui.zen` binds ⌘⌥Z (an
    // extra modifier), and this test would already fail if that changed.
    //
    // The actual interception was one layer up, in the native Edit menu
    // (`src-tauri/src/menu.rs`): its Undo/Redo items hardwired the same
    // accelerators, and AppKit resolves a menu accelerator before the keydown
    // reaches the webview at all — this table, and the capture-phase handler
    // built from it, never had a chance to run either way. That is a fact
    // about window chrome outside anything vitest/jsdom models, so it has no
    // failing-before/passing-after test here; `menu.rs`'s doc comment and the
    // `voidlink://menu-undo-redo` listener in `main.tsx` are the fix, and
    // "type, save, switch tabs, Cmd+Z" is what actually verifies it.
    for (const entry of KEYMAP) {
      for (const chord of chordsOf(entry)) {
        if (chord.key.toLowerCase() !== "z") continue;
        expect(chord.shift || chord.alt, `${entry.actionId} binds bare ${chordId(chord)}`).toBe(
          true,
        );
      }
    }
  });

  it("gives every new binding a modifier beyond the platform key, or a scope", () => {
    // Bare ⌘<letter> is also Ctrl+<letter>, which is a readline binding in any
    // shell. The pre-existing bare chords are grandfathered; anything else has
    // to carry Shift/Alt or declare a scope that stands down in a terminal.
    const grandfathered = new Set([
      "meta+k",
      "meta+p",
      "meta+w",
      "meta+t",
      "meta+n",
      "meta+b",
      "meta+j",
      "meta+\\",
      "meta+,",
      ...Array.from({ length: 9 }, (_, i) => `meta+${i + 1}`),
      // Ctrl+Tab is not a readline binding — the rule above is about bare
      // ⌘<letter>, which is Ctrl+<letter> and therefore a shell chord. Tab is
      // not a letter, and Ctrl+Tab is the tab switcher everywhere.
      "meta+tab",
    ]);
    for (const entry of KEYMAP) {
      for (const chord of chordsOf(entry)) {
        const id = chordId(chord);
        if (grandfathered.has(id)) continue;
        const guarded = chord.shift || chord.alt || (chord.scope && chord.scope !== "global");
        expect(guarded, `${entry.actionId} binds bare ${id} with no scope`).toBeTruthy();
      }
    }
  });
});
