import { beforeAll, describe, expect, it } from "vitest";
import {
  EDITOR_SETTINGS,
  EDITOR_SETTING_LIST,
  SETTING_SECTIONS,
  coerceSettingValue,
  defaultEditorSettings,
  isModified,
  parseEditorSettings,
  settingById,
  settingByKey,
  settingsBySection,
} from "./settingsSchema";
import type { AppSettings } from "./settings";

/// The schema is the source of truth for the defaults, the parse and the
/// rendering. These are the properties that make that claim true rather than
/// aspirational — chiefly that the table and `EditorSettings` cannot drift, and
/// that a persisted blob survives a round-trip whichever build wrote it.
///
/// `store/settings.ts` reads `localStorage` and touches `<html>` at import
/// time, so it is imported lazily behind the same two stubs `settings.test.ts`
/// uses. Everything in `settingsSchema.ts` itself is import-safe in node.
let DEFAULT_SETTINGS: AppSettings;

beforeAll(async () => {
  const store = new Map<string, string>();
  Object.assign(globalThis, {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    document: { documentElement: { style: {}, setAttribute() {} } },
  });
  DEFAULT_SETTINGS = (await import("./settings")).DEFAULT_SETTINGS;
});

describe("the schema and EditorSettings agree", () => {
  it("gives every schema entry the default the store ships", () => {
    for (const s of EDITOR_SETTING_LIST) {
      expect(
        (DEFAULT_SETTINGS.editor as unknown as Record<string, unknown>)[s.key],
      ).toEqual(s.default);
    }
  });

  it("covers every EditorSettings field, and invents none", () => {
    // The compile-time half of this lives in `settingsSchema.ts` — the table is
    // declared `satisfies` a mapped type over `keyof EditorCoreSettings`, so a
    // field added without an entry fails to build. This is the runtime half,
    // which additionally catches the one key the mapped type cannot see:
    // `languageOverrides`, which is the override map rather than a setting.
    const stored = Object.keys(DEFAULT_SETTINGS.editor).sort();
    const declared = [...EDITOR_SETTING_LIST.map((s) => s.key as string), "languageOverrides"]
      .sort();
    expect(stored).toEqual(declared);
  });

  it("names every id `editor.<key>` and keeps ids unique", () => {
    const ids = EDITOR_SETTING_LIST.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of EDITOR_SETTING_LIST) expect(s.id).toBe(`editor.${s.key}`);
  });

  it("gives every entry a label, a description and a declared section", () => {
    for (const s of EDITOR_SETTING_LIST) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
      expect(SETTING_SECTIONS).toContain(s.section);
    }
  });

  it("puts every entry in exactly one rendered section", () => {
    const rendered = settingsBySection().flatMap((g) => g.settings);
    expect(rendered).toHaveLength(EDITOR_SETTING_LIST.length);
  });

  it("gives every enum entry a default that is one of its own members", () => {
    for (const s of EDITOR_SETTING_LIST) {
      if (s.kind !== "enum") continue;
      expect(s.members.map((m) => m.value)).toContain(s.default);
      expect(s.members.length).toBeGreaterThan(1);
    }
  });

  it("gives every number entry a default inside its own range", () => {
    for (const s of EDITOR_SETTING_LIST) {
      if (s.kind !== "number") continue;
      expect(s.min).toBeLessThan(s.max);
      expect(s.default).toBeGreaterThanOrEqual(s.min);
      expect(s.default).toBeLessThanOrEqual(s.max);
    }
  });

  it("hands out a fresh copy of every mutable default", () => {
    const a = defaultEditorSettings();
    const b = defaultEditorSettings();
    a.rulers.push(80);
    a.lspServerPaths["rust-analyzer"] = "/tmp/ra";
    expect(b.rulers).toEqual([]);
    expect(b.lspServerPaths).toEqual({});
    expect(EDITOR_SETTINGS.rulers.default).toEqual([]);
  });

  it("looks entries up by either spelling", () => {
    expect(settingById("editor.fontSize")?.key).toBe("fontSize");
    expect(settingByKey("fontSize")?.id).toBe("editor.fontSize");
    expect(settingById("editor.nope")).toBeUndefined();
    expect(settingByKey("nope")).toBeUndefined();
  });
});

describe("coerceSettingValue", () => {
  it("accepts a valid enum member and rejects one that no longer exists", () => {
    expect(coerceSettingValue(EDITOR_SETTINGS.wordWrap, "bounded")).toBe("bounded");
    // Monaco 0.55 spelling, added in this slice.
    expect(coerceSettingValue(EDITOR_SETTINGS.wordWrap, "wordWrapColumn")).toBe("wordWrapColumn");
    expect(coerceSettingValue(EDITOR_SETTINGS.renderWhitespace, "trailing")).toBe("trailing");
    expect(coerceSettingValue(EDITOR_SETTINGS.wordWrap, "sideways")).toBeUndefined();
    expect(coerceSettingValue(EDITOR_SETTINGS.wordWrap, 3)).toBeUndefined();
  });

  it("clamps an out-of-range number instead of discarding it", () => {
    expect(coerceSettingValue(EDITOR_SETTINGS.fontSize, 400)).toBe(28);
    expect(coerceSettingValue(EDITOR_SETTINGS.fontSize, -5)).toBe(8);
    expect(coerceSettingValue(EDITOR_SETTINGS.fontSize, 15)).toBe(15);
    expect(coerceSettingValue(EDITOR_SETTINGS.fontSize, "15")).toBeUndefined();
    expect(coerceSettingValue(EDITOR_SETTINGS.fontSize, Number.NaN)).toBeUndefined();
  });

  it("normalises a ruler list and drops what is not a number", () => {
    expect(coerceSettingValue(EDITOR_SETTINGS.rulers, [120, 80, 80, "x", null])).toEqual([80, 120]);
    expect(coerceSettingValue(EDITOR_SETTINGS.rulers, 80)).toBeUndefined();
  });

  it("keeps only the string values of a path map", () => {
    expect(
      coerceSettingValue(EDITOR_SETTINGS.lspServerPaths, { ra: "/bin/ra", bad: 7 }),
    ).toEqual({ ra: "/bin/ra" });
    expect(coerceSettingValue(EDITOR_SETTINGS.lspServerPaths, [])).toBeUndefined();
  });

  it("type-checks booleans and strings", () => {
    expect(coerceSettingValue(EDITOR_SETTINGS.minimap, true)).toBe(true);
    expect(coerceSettingValue(EDITOR_SETTINGS.minimap, "true")).toBeUndefined();
    expect(coerceSettingValue(EDITOR_SETTINGS.fontFamily, "Iosevka")).toBe("Iosevka");
    expect(coerceSettingValue(EDITOR_SETTINGS.fontFamily, 12)).toBeUndefined();
  });
});

describe("isModified", () => {
  it("is false for every default", () => {
    const d = defaultEditorSettings() as unknown as Record<string, unknown>;
    for (const s of EDITOR_SETTING_LIST) expect(isModified(s, d[s.key])).toBe(false);
  });

  it("is true once a value moves off its default", () => {
    expect(isModified(EDITOR_SETTINGS.fontSize, 15)).toBe(true);
    expect(isModified(EDITOR_SETTINGS.wordWrap, "on")).toBe(true);
    expect(isModified(EDITOR_SETTINGS.rulers, [80])).toBe(true);
  });

  it("does not count a blank LSP path as a change", () => {
    // Every row in the language-servers section renders as an empty field; the
    // act of touching one and clearing it must not leave a permanent dot.
    expect(isModified(EDITOR_SETTINGS.lspServerPaths, { "rust-analyzer": "" })).toBe(false);
    expect(isModified(EDITOR_SETTINGS.lspServerPaths, { "rust-analyzer": "/bin/ra" })).toBe(true);
  });
});

describe("parseEditorSettings", () => {
  it("fills every key from the schema for an absent payload", () => {
    expect(parseEditorSettings(undefined)).toEqual(DEFAULT_SETTINGS.editor);
    expect(parseEditorSettings(null)).toEqual(DEFAULT_SETTINGS.editor);
    expect(parseEditorSettings("nonsense")).toEqual(DEFAULT_SETTINGS.editor);
  });

  it("keeps what was saved and defaults the rest", () => {
    const parsed = parseEditorSettings({ fontSize: 20, wordWrap: "on" });
    expect(parsed.fontSize).toBe(20);
    expect(parsed.wordWrap).toBe("on");
    expect(parsed.tabSize).toBe(EDITOR_SETTINGS.tabSize.default);
  });

  it("falls back to the default for a value that no longer validates", () => {
    const parsed = parseEditorSettings({ wordWrap: "sideways", minimap: "yes" });
    expect(parsed.wordWrap).toBe("off");
    expect(parsed.minimap).toBe(false);
  });

  it("clamps rather than resets an out-of-range number", () => {
    expect(parseEditorSettings({ fontSize: 999 }).fontSize).toBe(28);
  });

  it("survives a round-trip with keys it has never heard of", () => {
    // The forward-compatibility rule: a config written by a newer build and
    // opened by an older one must not lose fields.
    const fromTheFuture = {
      fontSize: 16,
      "editor.somethingNewInTheNextRelease": { deeply: ["nested", 1, true] },
      futureFlag: "keep me",
    };
    const parsed = parseEditorSettings(fromTheFuture) as unknown as Record<string, unknown>;
    expect(parsed.futureFlag).toBe("keep me");
    expect(parsed["editor.somethingNewInTheNextRelease"]).toEqual({
      deeply: ["nested", 1, true],
    });

    const again = parseEditorSettings(
      JSON.parse(JSON.stringify(parsed)),
    ) as unknown as Record<string, unknown>;
    expect(again.futureFlag).toBe("keep me");
    expect(again.fontSize).toBe(16);
  });

  it("validates language overrides and drops the members that are gone", () => {
    const parsed = parseEditorSettings({
      languageOverrides: {
        rust: { tabSize: 4, wordWrap: "sideways" },
        typescript: { tabSize: 2 },
        // An empty patch is not an override; it should not survive as one.
        python: {},
        json: "not an object",
      },
    });
    expect(parsed.languageOverrides.rust).toEqual({ tabSize: 4 });
    expect(parsed.languageOverrides.typescript).toEqual({ tabSize: 2 });
    expect(parsed.languageOverrides.python).toBeUndefined();
    expect(parsed.languageOverrides.json).toBeUndefined();
  });

  it("carries an unknown key inside an override through too", () => {
    const parsed = parseEditorSettings({
      languageOverrides: { rust: { fromTheFuture: 1 } },
    });
    expect(parsed.languageOverrides.rust).toEqual({ fromTheFuture: 1 });
  });
});
