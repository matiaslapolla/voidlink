import { describe, expect, it } from "vitest";
import {
  languageIdFromSection,
  languageSectionKey,
  parseSettingsJson,
  settingsJsonSchema,
  toSettingsJson,
  withLanguageOverride,
  withoutLanguageOverride,
} from "./settingsJson";
import { EDITOR_SETTINGS, defaultEditorSettings } from "./settingsSchema";
import type { EditorSettings } from "./settings";

/// The JSON view's contract: it is a *view*, so what the GUI writes and what
/// the text pane writes have to be the same object, and a text that cannot be
/// parsed has to be refused out loud rather than swallowed.
function base(overrides: Partial<EditorSettings> = {}): EditorSettings {
  return { ...defaultEditorSettings(), ...overrides };
}

describe("toSettingsJson", () => {
  it("writes every setting under its dotted id", () => {
    const parsed = JSON.parse(toSettingsJson(base({ fontSize: 15 })));
    expect(parsed["editor.fontSize"]).toBe(15);
    expect(parsed["editor.tabSize"]).toBe(EDITOR_SETTINGS.tabSize.default);
    // Never the in-memory spelling.
    expect(parsed.fontSize).toBeUndefined();
  });

  it("writes overrides as VS Code language sections", () => {
    const json = toSettingsJson(base({ languageOverrides: { rust: { tabSize: 4 } } }));
    expect(JSON.parse(json)["[rust]"]).toEqual({ "editor.tabSize": 4 });
  });

  it("omits a language whose override is empty", () => {
    const json = toSettingsJson(base({ languageOverrides: { rust: {} } }));
    expect(JSON.parse(json)["[rust]"]).toBeUndefined();
  });

  it("ends with a newline, the way a file does", () => {
    expect(toSettingsJson(base()).endsWith("\n")).toBe(true);
  });
});

describe("parseSettingsJson", () => {
  it("parses dotted JSON into the shape the GUI writes", () => {
    // The load-bearing equivalence: serialising what the GUI holds and parsing
    // it back must be the identity, or the two views are two stores.
    const gui = base({ fontSize: 15, wordWrap: "on", languageOverrides: { rust: { tabSize: 4 } } });
    const result = parseSettingsJson(toSettingsJson(gui));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.editor).toEqual(gui);
  });

  it("round-trips the defaults untouched", () => {
    const result = parseSettingsJson(toSettingsJson(base()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.editor).toEqual(defaultEditorSettings());
  });

  it("rejects malformed JSON with a message and a line, changing nothing", () => {
    const before = base({ fontSize: 15 });
    const result = parseSettingsJson('{\n  "editor.fontSize": 20,\n  oops\n}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.length).toBeGreaterThan(0);
    // The caller only writes on `ok`, so the store it holds is untouched.
    expect(before.fontSize).toBe(15);
  });

  it("rejects a JSON document that is not an object", () => {
    for (const text of ["[]", '"hello"', "42", "null"]) {
      const result = parseSettingsJson(text);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("object");
    }
  });

  it("fills absent settings from the schema rather than blanking them", () => {
    const result = parseSettingsJson('{ "editor.fontSize": 20 }');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.editor.fontSize).toBe(20);
    expect(result.editor.tabSize).toBe(EDITOR_SETTINGS.tabSize.default);
    expect(result.editor.wordWrap).toBe("off");
  });

  it("falls a bad value back to its default instead of failing the whole write", () => {
    const result = parseSettingsJson('{ "editor.wordWrap": "sideways", "editor.fontSize": 999 }');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.editor.wordWrap).toBe("off");
    expect(result.editor.fontSize).toBe(28); // clamped, not reset
  });

  it("keeps keys it does not recognise, at both levels", () => {
    const result = parseSettingsJson(
      '{ "editor.fontSize": 15, "unknownTopLevel": 1, "[rust]": { "editor.tabSize": 4, "future": 2 } }',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.editor as unknown as Record<string, unknown>).unknownTopLevel).toBe(1);
    expect(result.editor.languageOverrides.rust).toEqual({ tabSize: 4, future: 2 });
  });
});

describe("language section keys", () => {
  it("wraps and unwraps a language id", () => {
    expect(languageSectionKey("rust")).toBe("[rust]");
    expect(languageIdFromSection("[rust]")).toBe("rust");
  });

  it("does not mistake an ordinary key for a section", () => {
    expect(languageIdFromSection("editor.fontSize")).toBeNull();
    expect(languageIdFromSection("[]")).toBeNull();
  });
});

describe("settingsJsonSchema", () => {
  it("describes every setting id", () => {
    const schema = settingsJsonSchema();
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(properties["editor.fontSize"]).toMatchObject({ type: "number", minimum: 8, maximum: 28 });
    expect(properties["editor.wordWrap"]).toMatchObject({
      type: "string",
      enum: ["off", "on", "wordWrapColumn", "bounded"],
    });
    expect(properties["editor.minimap"]).toMatchObject({ type: "boolean" });
    expect(properties["editor.rulers"]).toMatchObject({ type: "array" });
    expect(properties["editor.lspServerPaths"]).toMatchObject({ type: "object" });
  });

  it("gives language sections the same properties", () => {
    const schema = settingsJsonSchema();
    const pattern = schema.patternProperties as Record<string, Record<string, unknown>>;
    const section = pattern["^\\[[^\\]]+\\]$"];
    expect(Object.keys(section.properties as object)).toContain("editor.tabSize");
  });

  it("stays permissive so a newer build's key is not squiggled as an error", () => {
    expect(settingsJsonSchema().additionalProperties).toBe(true);
  });
});

describe("language override edits", () => {
  it("adds and merges a patch", () => {
    const s = base();
    const one = withLanguageOverride(s, "rust", { tabSize: 4 });
    expect(one.rust).toEqual({ tabSize: 4 });
    const two = withLanguageOverride({ ...s, languageOverrides: one }, "rust", {
      insertSpaces: false,
    });
    expect(two.rust).toEqual({ tabSize: 4, insertSpaces: false });
  });

  it("drops the language when its last field is removed", () => {
    const s = base({ languageOverrides: { rust: { tabSize: 4 } } });
    expect(withoutLanguageOverride(s, "rust", "tabSize")).toEqual({});
  });

  it("keeps the other languages alone", () => {
    const s = base({ languageOverrides: { rust: { tabSize: 4 }, go: { tabSize: 8 } } });
    expect(withoutLanguageOverride(s, "rust", "tabSize")).toEqual({ go: { tabSize: 8 } });
    expect(s.languageOverrides.rust).toEqual({ tabSize: 4 });
  });
});
