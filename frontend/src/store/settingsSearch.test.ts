import { describe, expect, it } from "vitest";
import { groupHits, modifiedCount, searchSettings } from "./settingsSearch";
import { EDITOR_SETTING_LIST, defaultEditorSettings } from "./settingsSchema";
import type { EditorSettings } from "./settings";

function base(overrides: Partial<EditorSettings> = {}): EditorSettings {
  return { ...defaultEditorSettings(), ...overrides };
}

const ids = (settings: EditorSettings, query: string, modifiedOnly = false) =>
  searchSettings({ query, modifiedOnly }, settings).map((h) => h.setting.id);

describe("searchSettings", () => {
  it("returns the whole table, in declaration order, for an empty query", () => {
    const hits = searchSettings({ query: "", modifiedOnly: false }, base());
    expect(hits).toHaveLength(EDITOR_SETTING_LIST.length);
    expect(hits.map((h) => h.setting.id)).toEqual(EDITOR_SETTING_LIST.map((s) => s.id));
  });

  it("matches by dotted id", () => {
    expect(ids(base(), "editor.fontSize")).toContain("editor.fontSize");
    expect(ids(base(), "fontsize")).toContain("editor.fontSize");
  });

  it("matches by label", () => {
    expect(ids(base(), "Sticky scroll")).toContain("editor.stickyScroll");
    expect(ids(base(), "Wrap column")).toContain("editor.wordWrapColumn");
  });

  it("matches by description", () => {
    // "monaco-vim" appears only in the Vim mode entry's description.
    const hits = searchSettings({ query: "monaco-vim", modifiedOnly: false }, base());
    expect(hits.map((h) => h.setting.id)).toEqual(["editor.vimMode"]);
    expect(hits[0].field).toBe("description");
  });

  it("matches by enum member, and says which member matched", () => {
    const hits = searchSettings({ query: "deepIndent", modifiedOnly: false }, base());
    expect(hits[0].setting.id).toBe("editor.wrappingIndent");
    expect(hits[0].field).toBe("member");
    expect(hits[0].member).toBe("Deep");

    // A member's *label* works too — the user has only ever seen that one.
    const byLabel = searchSettings({ query: "Relative", modifiedOnly: false }, base());
    expect(byLabel.map((h) => h.setting.id)).toContain("editor.lineNumbers");
  });

  it("returns matched character ranges for highlighting", () => {
    const hits = searchSettings({ query: "sticky", modifiedOnly: false }, base());
    const hit = hits.find((h) => h.setting.id === "editor.stickyScroll");
    expect(hit?.ranges.length).toBeGreaterThan(0);
  });

  it("returns nothing for a query that matches nothing", () => {
    expect(ids(base(), "zzzzqqqq")).toEqual([]);
  });

  it("prefers the setting's own fields over a same-named enum member", () => {
    // "Line numbers" is a setting; "Line" is a cursor-style member. Typing
    // "line numbers" must not land on the cursor.
    expect(ids(base(), "line numbers")[0]).toBe("editor.lineNumbers");
  });
});

describe("the modified filter", () => {
  it("returns exactly the non-default entries", () => {
    const settings = base({ fontSize: 15, wordWrap: "on" });
    expect(ids(settings, "", true).sort()).toEqual(
      ["editor.fontSize", "editor.wordWrap"].sort(),
    );
  });

  it("returns nothing when nothing has been changed", () => {
    expect(ids(base(), "", true)).toEqual([]);
    expect(modifiedCount(base())).toBe(0);
  });

  it("composes with the query", () => {
    // The shared scorer falls back to a subsequence match, so a short query can
    // legitimately reach a long description — `fontSize` is asserted to be
    // *first*, not alone. `sticky` is the real conjunction case: it matches a
    // setting that is at its default, so the modified filter must exclude it.
    const settings = base({ fontSize: 15, wordWrap: "on" });
    expect(ids(settings, "font size", true)).toEqual(["editor.fontSize"]);
    expect(ids(settings, "sticky", true)).toEqual([]);
    expect(ids(settings, "sticky", false)).toContain("editor.stickyScroll");
  });

  it("marks each hit with whether it is modified", () => {
    const hits = searchSettings({ query: "", modifiedOnly: false }, base({ fontSize: 15 }));
    expect(hits.find((h) => h.setting.id === "editor.fontSize")?.modified).toBe(true);
    expect(hits.find((h) => h.setting.id === "editor.tabSize")?.modified).toBe(false);
  });

  it("counts what the chip promises", () => {
    expect(modifiedCount(base({ fontSize: 15, minimap: true }))).toBe(2);
  });
});

describe("groupHits", () => {
  it("keeps the table's section order and drops empty sections", () => {
    const grouped = groupHits(searchSettings({ query: "", modifiedOnly: false }, base()));
    expect(grouped[0].section).toBe("Font");
    expect(grouped.every((g) => g.hits.length > 0)).toBe(true);
  });

  it("returns only the sections a filtered result landed in", () => {
    const grouped = groupHits(
      searchSettings({ query: "", modifiedOnly: true }, base({ fontSize: 15 })),
    );
    expect(grouped).toHaveLength(1);
    expect(grouped[0].section).toBe("Font");
  });
});
