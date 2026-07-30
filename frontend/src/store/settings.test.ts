import { beforeAll, describe, expect, it } from "vitest";
import { editorOptions } from "@/components/editor/monaco";
import type { AppSettings } from "./settings";

/// `store/settings.ts` reads `localStorage` and touches `<html>` at import
/// time, which is the right design for a module that must apply the persisted
/// text size before first paint — and means it cannot simply be imported into
/// the `node` test environment. Two very small stubs are cheaper than pulling
/// in a DOM implementation for a pure-data test.
let parseSettings: (raw: string | null) => AppSettings;
let DEFAULT_SETTINGS: AppSettings;

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
  const mod = await import("./settings");
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

describe("agent roster migration", () => {
  it("builds a one-entry roster from the single agentCommand", () => {
    // Exactly what is on disk for an install that configured the pre-roster
    // agent: an `ai` section with a command and no `agents` key.
    const legacy = JSON.stringify({ ai: { commitCommand: "cc", agentCommand: "  llm run  " } });
    const parsed = parseSettings(legacy);

    expect(parsed.ai.agents).toEqual([
      { id: "default", name: "Repo agent", commandTemplate: "llm run" },
    ]);
    // The fallback field survives the migration — it is what a roster entry
    // with a blank template resolves through.
    expect(parsed.ai.agentCommand).toBe("  llm run  ");
  });

  it("synthesizes a blank entry when no agent was ever configured", () => {
    const parsed = parseSettings(JSON.stringify({ ai: { commitCommand: "cc" } }));
    expect(parsed.ai.agents).toEqual([
      { id: "default", name: "Repo agent", commandTemplate: "" },
    ]);
  });

  it("keeps a persisted roster verbatim", () => {
    const saved = JSON.stringify({
      ai: { agentCommand: "shared", agents: [{ id: "a", name: "Reviewer", commandTemplate: "x" }] },
    });
    expect(parseSettings(saved).ai.agents).toEqual([
      { id: "a", name: "Reviewer", commandTemplate: "x" },
    ]);
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
    expect(parseSettings(saved).ai.agents).toEqual([
      { id: "a", name: "Good", commandTemplate: "x" },
    ]);
  });

  it("falls back to the synthesized entry when every persisted row is malformed", () => {
    const saved = JSON.stringify({ ai: { agentCommand: "llm", agents: [{ nope: true }] } });
    expect(parseSettings(saved).ai.agents).toEqual([
      { id: "default", name: "Repo agent", commandTemplate: "llm" },
    ]);
    // …and for a roster that is not an array at all.
    expect(parseSettings(JSON.stringify({ ai: { agents: {} } })).ai.agents).toHaveLength(1);
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
