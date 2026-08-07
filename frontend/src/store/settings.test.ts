import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { editorOptions } from "@/components/editor/monaco";
import type { AppSettings } from "./settings";

/// `store/settings.ts` reads `localStorage` and touches `<html>` at import
/// time, which is the right design for a module that must apply the persisted
/// text size before first paint — and means it cannot simply be imported into
/// the `node` test environment. Two very small stubs are cheaper than pulling
/// in a DOM implementation for a pure-data test.
let parseSettings: (raw: string | null) => AppSettings;
let DEFAULT_SETTINGS: AppSettings;
let mod: typeof import("./settings");

beforeAll(async () => {
  const store = new Map<string, string>();
  Object.assign(globalThis, {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    document: {
      documentElement: { style: {}, setAttribute() {} },
    },
  });
  mod = await import("./settings");
  parseSettings = mod.parseSettings;
  DEFAULT_SETTINGS = mod.DEFAULT_SETTINGS;
});

describe("parseSettings", () => {
  it("fills in the editor section for a payload saved before it existed", () => {
    // Exactly what is on disk for every existing install: terminal and ui
    // present, no `editor` key at all.
    const legacy = JSON.stringify({
      ui: { textSize: "sm", density: "compact" },
      terminal: { fontSize: 15 },
    });
    const parsed = parseSettings(legacy);

    expect(parsed.editor).toEqual(DEFAULT_SETTINGS.editor);
    // …without clobbering what *was* saved.
    expect(parsed.ui.textSize).toBe("sm");
    expect(parsed.terminal.fontSize).toBe(15);
    // …and without dropping the keys the old payload never had.
    expect(parsed.ui.showIgnoredFiles).toBe(DEFAULT_SETTINGS.ui.showIgnoredFiles);
    // The tab orientation is the newest of those, and it is the one whose
    // absence would be *visible*: an install that upgraded into a vertical
    // strip and a relocated file explorer without asking would read as the
    // app having rearranged itself overnight.
    expect(parsed.ui.tabOrientation).toBe("horizontal");
    expect(parsed.ui.verticalTabWidth).toBe(DEFAULT_SETTINGS.ui.verticalTabWidth);
  });

  it("fills in individual editor keys added after the section shipped", () => {
    const partial = JSON.stringify({ editor: { fontSize: 20 } });
    const parsed = parseSettings(partial);
    expect(parsed.editor.fontSize).toBe(20);
    expect(parsed.editor.tabSize).toBe(DEFAULT_SETTINGS.editor.tabSize);
    expect(parsed.editor.autoSave).toBe("off");
  });

  it("falls back to defaults for absent or corrupt storage", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("{not json")).toEqual(DEFAULT_SETTINGS);
  });
});

describe("experimental flags", () => {
  /// The forward-compatibility rule stated for the newest section: every blob
  /// on disk today predates it, and every one of them has to boot with the
  /// experiments off. A flag that arrives switched on is a feature the user
  /// never agreed to.
  it("revives an older blob without the section to both flags off", () => {
    const legacy = JSON.stringify({
      ui: { textSize: "sm" },
      terminal: { fontSize: 15 },
      editor: { fontSize: 20 },
    });
    const parsed = parseSettings(legacy);
    expect(parsed.experimental).toEqual({ agentDashboard: false, showIdleAgents: false });
    // …without disturbing what the old payload did say.
    expect(parsed.ui.textSize).toBe("sm");
    expect(parsed.editor.fontSize).toBe(20);
  });

  it("revives a payload holding only one of the two flags", () => {
    const parsed = parseSettings(JSON.stringify({ experimental: { agentDashboard: true } }));
    expect(parsed.experimental.agentDashboard).toBe(true);
    expect(parsed.experimental.showIdleAgents).toBe(false);
  });

  /// GUI → JSON → GUI. The dialog writes the store, the store is serialised to
  /// the one storage key, and the next boot parses it back — so a flag that
  /// does not survive `JSON.stringify` round-tripping is a toggle that resets
  /// itself overnight.
  it("survives the GUI to JSON to GUI round trip", () => {
    for (const experimental of [
      { agentDashboard: true, showIdleAgents: true },
      { agentDashboard: true, showIdleAgents: false },
      { agentDashboard: false, showIdleAgents: true },
      { agentDashboard: false, showIdleAgents: false },
    ]) {
      const saved = { ...DEFAULT_SETTINGS, experimental };
      const revived = parseSettings(JSON.stringify(saved));
      expect(revived.experimental).toEqual(experimental);
      // The whole object, not just the section: a new top-level key that is
      // not threaded through `parseSettings` comes back `undefined`, and that
      // is exactly the bug this asserts against.
      expect(revived).toEqual(saved);
    }
  });

  /// This is user-editable JSON on disk. A truthy string must not be able to
  /// switch an experiment on — the one direction a default-off flag must never
  /// fall.
  it("treats a non-boolean as off", () => {
    const saved = JSON.stringify({
      experimental: { agentDashboard: "yes", showIdleAgents: 1 },
    });
    expect(parseSettings(saved).experimental).toEqual({
      agentDashboard: false,
      showIdleAgents: false,
    });
  });
});

describe("agent roster migration", () => {
  it("builds a one-entry roster from the single agentCommand", () => {
    // Exactly what is on disk for an install that configured the pre-roster
    // agent: an `ai` section with a command and no `agents` key.
    const legacy = JSON.stringify({ ai: { commitCommand: "cc", agentCommand: "  llm run  " } });
    const parsed = parseSettings(legacy);

    expect(parsed.ai.agents).toEqual([
      { id: "default", name: "Repo agent", commandTemplate: "llm run", color: "chart-1" },
    ]);
    // The fallback field survives the migration — it is what a roster entry
    // with a blank template resolves through.
    expect(parsed.ai.agentCommand).toBe("  llm run  ");
  });

  it("synthesizes a blank entry when no agent was ever configured", () => {
    const parsed = parseSettings(JSON.stringify({ ai: { commitCommand: "cc" } }));
    expect(parsed.ai.agents).toEqual([
      { id: "default", name: "Repo agent", commandTemplate: "", color: "chart-1" },
    ]);
  });

  it("keeps a persisted roster verbatim", () => {
    const saved = JSON.stringify({
      ai: { agentCommand: "shared", agents: [{ id: "a", name: "Reviewer", commandTemplate: "x" }] },
    });
    // `toMatchObject`: the colour is repaired in rather than persisted here,
    // and it has its own test below. What "verbatim" claims is that the three
    // fields the user set come back untouched.
    expect(parseSettings(saved).ai.agents).toMatchObject([
      { id: "a", name: "Reviewer", commandTemplate: "x" },
    ]);
    // A roster written before agents had a spec stays hand-written. Filling one
    // in would silently convert every existing agent into a `claude` command.
    expect(parseSettings(saved).ai.agents[0].claude).toBeUndefined();
  });

  it("drops malformed rows instead of throwing, and dedupes ids keeping the first", () => {
    const saved = JSON.stringify({
      ai: {
        agents: [
          { id: "a", name: "Good", commandTemplate: "x" },
          { id: "a", name: "Shadow", commandTemplate: "y" },
          { id: "", name: "No id", commandTemplate: "z" },
          { id: "n", name: 7, commandTemplate: "z" },
          { id: "t", name: "No template" },
          "nonsense",
          null,
        ],
      },
    });
    expect(parseSettings(saved).ai.agents).toMatchObject([
      { id: "a", name: "Good", commandTemplate: "x" },
    ]);
    expect(parseSettings(saved).ai.agents).toHaveLength(1);
  });

  it("falls back to the synthesized entry when every persisted row is malformed", () => {
    const saved = JSON.stringify({ ai: { agentCommand: "llm", agents: [{ nope: true }] } });
    expect(parseSettings(saved).ai.agents).toEqual([
      { id: "default", name: "Repo agent", commandTemplate: "llm", color: "chart-1" },
    ]);
    // …and for a roster that is not an array at all.
    expect(parseSettings(JSON.stringify({ ai: { agents: {} } })).ai.agents).toHaveLength(1);
  });

  /// The colour is not a preference the user has ever set on any roster on
  /// disk, so every one of them arrives without it. An absent or unknown token
  /// renders as *no* colour rather than as a wrong one — a chip with no fill —
  /// which is why it is repaired rather than passed through.
  it("gives every persisted agent a colour, repairing a token it does not know", () => {
    const saved = JSON.stringify({
      ai: {
        agents: [
          { id: "a", name: "A", commandTemplate: "" },
          { id: "b", name: "B", commandTemplate: "", color: "chart-4" },
          { id: "c", name: "C", commandTemplate: "", color: "puce" },
        ],
      },
    });
    const agents = parseSettings(saved).ai.agents;
    expect(agents.map((a) => a.color)).toEqual(["chart-1", "chart-4", "chart-1"]);
  });

  /// A spec on disk is what makes an entry a *composed* agent rather than a
  /// hand-written command, so it has to survive the round trip — and a spec
  /// with a bad field has to survive it too, minus that field. Anything else
  /// turns one hand-edited character in Settings → JSON into a lost agent.
  it("revives a composed agent, and only drops the fields it cannot vouch for", () => {
    const saved = JSON.stringify({
      ai: {
        agents: [
          {
            id: "a",
            name: "Reviewer",
            commandTemplate: "",
            claude: { model: "opus", permissionMode: "plan", effort: "nope" },
          },
        ],
      },
    });
    const spec = parseSettings(saved).ai.agents[0].claude;
    expect(spec).toMatchObject({ model: "opus", permissionMode: "plan", effort: "" });
    // And the fields the payload never mentioned come back at their defaults
    // rather than as `undefined`, which is what every form control binds to.
    expect(spec?.systemPromptMode).toBe("append");
    expect(spec?.continueSession).toBe(false);
  });

  it("never hands the store a reference to the defaults array", () => {
    const parsed = parseSettings(null);
    expect(parsed.ai.agents).not.toBe(DEFAULT_SETTINGS.ai.agents);
    expect(parsed.ai.agents).toEqual(DEFAULT_SETTINGS.ai.agents);
  });
});

describe("editor defaults", () => {
  it("reproduce the hardcoded options the editor shipped with", () => {
    // The upgrade contract: turning `SHARED_EDITOR_OPTIONS` into a derivation
    // must not move the editor for anyone. These five values are what the
    // constant actually set; the rest were Monaco's own defaults.
    const o = editorOptions(DEFAULT_SETTINGS.editor);
    expect(o.fontSize).toBe(13);
    expect(o.fontFamily).toBe("'Geist Mono Variable', 'Geist Mono', monospace");
    expect(o.minimap).toEqual({ enabled: false });
    expect(o.scrollBeyondLastLine).toBe(false);
    expect(o.renderLineHighlight).toBe("line");
  });

  it("default to Monaco's own behaviour for everything the constant left alone", () => {
    const d = DEFAULT_SETTINGS.editor;
    expect(d.lineHeight).toBe(0); // 0 = derive from font size
    expect(d.renderWhitespace).toBe("selection");
    expect(d.wordWrap).toBe("off");
    expect(d.stickyScroll).toBe(false);
    expect(d.bracketPairColorization).toBe(false);
    expect(d.cursorBlinking).toBe("blink");
  });

  it("ship the save pipeline off, so no upgrade rewrites a file unasked", () => {
    const d = DEFAULT_SETTINGS.editor;
    expect(d.autoSave).toBe("off");
    expect(d.formatOnSave).toBe(false);
    expect(d.trimTrailingWhitespaceOnSave).toBe(false);
    expect(d.insertFinalNewlineOnSave).toBe(false);
  });
});

/// What runs when the user has configured nothing — which, now that Settings →
/// AI has no command box, is every fresh install.
///
/// This used to resolve to `""` and every AI action in the app was a no-op
/// behind a "configure a command" toast. The chain still has to prefer a stored
/// command, because the boxes are gone from the dialog but not from the JSON
/// pane, and an install that had `ollama run llama3.2` must not be switched to
/// a different vendor by an upgrade.
describe("the built-in claude -p fallbacks", () => {
  const setAi = (patch: Partial<AppSettings["ai"]>) => mod.useSettings().updateAi(patch);

  beforeEach(() => setAi({ commitCommand: "", agentCommand: "" }));

  it("drafts commit messages with the built-in command when nothing is set", () => {
    expect(mod.resolveCommitCommand()).toBe(mod.DEFAULT_COMMIT_COMMAND);
    // Print mode and no tools — enough to be safe against a user's repository
    // without asking, and nothing beyond that. Every additional flag is a way
    // to fail on an older `claude`, which is a real machine and not a
    // hypothetical one.
    expect(mod.DEFAULT_COMMIT_COMMAND).toContain("claude -p");
    expect(mod.DEFAULT_COMMIT_COMMAND).toContain("--tools ''");
    expect(mod.DEFAULT_COMMIT_COMMAND).not.toContain("--no-session-persistence");
    expect(mod.DEFAULT_AGENT_COMMAND).not.toContain("--no-session-persistence");
  });

  it("still lets a stored command win, so no upgrade retargets a vendor", () => {
    setAi({ commitCommand: "  ollama run llama3.2  " });
    expect(mod.resolveCommitCommand()).toBe("ollama run llama3.2");
  });

  it("walks the agent chain and lands on the built-in rather than on nothing", () => {
    const entry = { id: "a", name: "A", commandTemplate: "", color: "chart-1" as const };
    expect(mod.resolveAgentCommand(entry)).toBe(mod.DEFAULT_AGENT_COMMAND);

    setAi({ commitCommand: "commit-cli" });
    expect(mod.resolveAgentCommand(entry)).toBe("commit-cli");

    setAi({ agentCommand: "shared-cli" });
    expect(mod.resolveAgentCommand(entry)).toBe("shared-cli");

    expect(mod.resolveAgentCommand({ ...entry, commandTemplate: "own-cli" })).toBe("own-cli");
  });
});

/// Background image, opacity and fit (Stream E) — validated field by field
/// like `experimental` above, not merged, because a hand-edited or stale
/// `surfaceOpacity` has to be clamped rather than handed to `color-mix()` as
/// `150%` or `-4%`, and a stale `backgroundFit` has to fall back rather than
/// reach `index.css` as a value no `data-bg-fit` selector matches.
describe("background image + opacity settings", () => {
  it("defaults to no image, full opacity, cover fit when the key is absent", () => {
    const parsed = parseSettings(JSON.stringify({ terminal: { fontSize: 15 } }));
    expect(parsed.ui.backgroundImage).toBeNull();
    expect(parsed.ui.surfaceOpacity).toBe(100);
    expect(parsed.ui.backgroundFit).toBe("cover");
  });

  it("round-trips a saved path, opacity and fit", () => {
    const saved = {
      ...DEFAULT_SETTINGS,
      ui: { ...DEFAULT_SETTINGS.ui, backgroundImage: "/Users/me/wallpaper.jpg", surfaceOpacity: 55, backgroundFit: "tile" as const },
    };
    const revived = parseSettings(JSON.stringify(saved));
    expect(revived.ui.backgroundImage).toBe("/Users/me/wallpaper.jpg");
    expect(revived.ui.surfaceOpacity).toBe(55);
    expect(revived.ui.backgroundFit).toBe("tile");
  });

  it("clamps an out-of-range opacity into the slider's bounds", () => {
    expect(parseSettings(JSON.stringify({ ui: { surfaceOpacity: 150 } })).ui.surfaceOpacity).toBe(100);
    // Below the floor (`SURFACE_OPACITY_MIN`), not below zero — the scrim's
    // AA guarantee only holds down to that floor. See `index.css`.
    expect(parseSettings(JSON.stringify({ ui: { surfaceOpacity: -4 } })).ui.surfaceOpacity).toBe(20);
    expect(parseSettings(JSON.stringify({ ui: { surfaceOpacity: "62" } })).ui.surfaceOpacity).toBe(100);
  });

  it("falls back to null for a non-string or blank image path", () => {
    expect(parseSettings(JSON.stringify({ ui: { backgroundImage: 42 } })).ui.backgroundImage).toBeNull();
    expect(parseSettings(JSON.stringify({ ui: { backgroundImage: "" } })).ui.backgroundImage).toBeNull();
    expect(parseSettings(JSON.stringify({ ui: { backgroundImage: "  " } })).ui.backgroundImage).toBeNull();
  });

  it("falls back to the default fit for an unknown value", () => {
    expect(parseSettings(JSON.stringify({ ui: { backgroundFit: "stretch" } })).ui.backgroundFit).toBe(
      "cover",
    );
    expect(parseSettings(JSON.stringify({ ui: { backgroundFit: 1 } })).ui.backgroundFit).toBe("cover");
  });
});
