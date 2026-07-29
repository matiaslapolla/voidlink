import { describe, expect, it } from "vitest";
import { editorOptions, modelOptions } from "./monaco";
import { effectiveEditorSettings } from "@/store/settingsSchema";
import type { EditorSettings } from "@/store/settings";

/// The settings→Monaco contract, tested without a DOM. `monaco.ts` only
/// *type*-imports Monaco and the store, so this file costs no browser.
///
/// Deliberately a literal rather than `DEFAULT_SETTINGS`: this suite is about
/// the mapping, and reading the defaults from the store would let a default
/// change hide a mapping regression. The defaults-fidelity case lives in
/// `store/settings.test.ts`, where it belongs.
function base(overrides: Partial<EditorSettings> = {}): EditorSettings {
  return {
    fontFamily: "'Geist Mono Variable', 'Geist Mono', monospace",
    fontSize: 13,
    lineHeight: 0,
    fontLigatures: false,
    tabSize: 4,
    insertSpaces: true,
    detectIndentation: false,
    trimAutoWhitespace: true,
    wordWrap: "off",
    wordWrapColumn: 80,
    wrappingIndent: "same",
    minimap: false,
    stickyScroll: false,
    bracketPairColorization: false,
    renderWhitespace: "selection",
    renderFinalNewline: "on",
    rulers: [],
    indentGuides: true,
    bracketPairGuides: false,
    lineNumbers: "on",
    renderLineHighlight: "line",
    folding: true,
    foldingStrategy: "auto",
    showFoldingControls: "mouseover",
    cursorStyle: "line",
    cursorBlinking: "blink",
    cursorSurroundingLines: 0,
    multiCursorModifier: "alt",
    smoothScrolling: false,
    scrollBeyondLastLine: false,
    mouseWheelZoom: false,
    scrollbarVerticalSize: 14,
    scrollbarHorizontalSize: 12,
    suggestOnTriggerCharacters: true,
    quickSuggestions: true,
    acceptSuggestionOnEnter: "on",
    snippetSuggestions: "inline",
    inlayHints: true,
    parameterHints: true,
    occurrencesHighlight: "singleFile",
    selectionHighlight: true,
    unicodeHighlight: true,
    autoClosingBrackets: "languageDefined",
    autoSurround: "languageDefined",
    linkedEditing: false,
    formatOnSave: false,
    trimTrailingWhitespaceOnSave: false,
    insertFinalNewlineOnSave: false,
    autoSave: "off",
    autoSaveDelayMs: 1000,
    vimMode: false,
    lspEnabled: false,
    lspServerPaths: {},
    languageOverrides: {},
    ...overrides,
  };
}

describe("editorOptions", () => {
  it("keeps the chrome that is VoidLink's rather than the user's", () => {
    // `renderLineHighlight` used to live here and is now a setting whose
    // default is the value the chrome hardcoded — same pixels, one more knob.
    const o = editorOptions(base());
    expect(o.automaticLayout).toBe(true);
    expect(o.overviewRulerBorder).toBe(false);
    expect(o.hideCursorInOverviewRuler).toBe(true);
    expect(o.padding).toEqual({ top: 8, bottom: 8 });
  });

  it("maps the flat settings onto Monaco's nested option objects", () => {
    // These four are the ones whose shape changed across Monaco versions and
    // where passing a bare boolean silently does nothing.
    expect(editorOptions(base({ minimap: true })).minimap).toEqual({ enabled: true });
    expect(editorOptions(base({ stickyScroll: true })).stickyScroll).toEqual({ enabled: true });
    expect(editorOptions(base({ bracketPairColorization: true })).bracketPairColorization).toEqual({
      enabled: true,
    });
    expect(editorOptions(base({ indentGuides: false })).guides).toEqual({
      indentation: false,
      highlightActiveIndentation: false,
      bracketPairs: false,
    });
  });

  it("reproduces Monaco's own defaults for the options it now exposes", () => {
    // The upgrade contract for the settings added after the pane shipped: with
    // every new field at its default, `editorOptions` must emit exactly what
    // Monaco 0.55 would have used on its own — otherwise turning a hardcoded
    // behaviour into a setting silently changes it for everyone.
    const o = editorOptions(base());
    expect(o.quickSuggestions).toEqual({ other: "on", comments: "off", strings: "off" });
    expect(o.inlayHints).toEqual({ enabled: "on" });
    expect(o.parameterHints).toEqual({ enabled: true });
    expect(o.unicodeHighlight).toEqual({
      ambiguousCharacters: true,
      invisibleCharacters: true,
    });
    expect(o.scrollbar).toEqual({ verticalScrollbarSize: 14, horizontalScrollbarSize: 12 });
    expect(o.rulers).toEqual([]);
    expect(o.folding).toBe(true);
    expect(o.foldingStrategy).toBe("auto");
    expect(o.showFoldingControls).toBe("mouseover");
    expect(o.occurrencesHighlight).toBe("singleFile");
    expect(o.multiCursorModifier).toBe("alt");
    expect(o.autoClosingBrackets).toBe("languageDefined");
    expect(o.autoSurround).toBe("languageDefined");
    expect(o.wrappingIndent).toBe("same");
  });

  it("switches quick suggestions without switching them on in comments or strings", () => {
    expect(editorOptions(base({ quickSuggestions: false })).quickSuggestions).toEqual({
      other: "off",
      comments: "off",
      strings: "off",
    });
  });

  it("copies the rulers array rather than handing Monaco the store's own", () => {
    const rulers = [80, 120];
    const o = editorOptions(base({ rulers }));
    expect(o.rulers).toEqual([80, 120]);
    expect(o.rulers).not.toBe(rulers);
  });

  it("maps each scalar setting to the Monaco key of the same meaning", () => {
    const o = editorOptions(
      base({
        fontFamily: "Iosevka",
        fontSize: 15,
        lineHeight: 1.6,
        fontLigatures: true,
        wordWrap: "bounded",
        wordWrapColumn: 100,
        renderWhitespace: "all",
        lineNumbers: "relative",
        cursorStyle: "block",
        cursorBlinking: "phase",
        smoothScrolling: true,
        scrollBeyondLastLine: true,
      }),
    );
    expect(o.fontFamily).toBe("Iosevka");
    expect(o.fontSize).toBe(15);
    expect(o.lineHeight).toBe(1.6);
    expect(o.fontLigatures).toBe(true);
    expect(o.wordWrap).toBe("bounded");
    expect(o.wordWrapColumn).toBe(100);
    expect(o.renderWhitespace).toBe("all");
    expect(o.lineNumbers).toBe("relative");
    expect(o.cursorStyle).toBe("block");
    expect(o.cursorBlinking).toBe("phase");
    expect(o.smoothScrolling).toBe(true);
    expect(o.scrollBeyondLastLine).toBe(true);
  });

  it("keeps the save-time settings out of the Monaco options entirely", () => {
    // `formatOnSave` and friends are consumed by the save pipeline, not by
    // Monaco. Leaking them into `updateOptions` would be a silent no-op that
    // reads like it works.
    const o = editorOptions(
      base({
        formatOnSave: true,
        trimTrailingWhitespaceOnSave: true,
        insertFinalNewlineOnSave: true,
        autoSave: "afterDelay",
        autoSaveDelayMs: 500,
      }),
    ) as Record<string, unknown>;
    for (const key of [
      "formatOnSave",
      "trimTrailingWhitespaceOnSave",
      "insertFinalNewlineOnSave",
      "autoSave",
      "autoSaveDelayMs",
    ]) {
      expect(o[key]).toBeUndefined();
    }
  });

  it("routes indentation to the model, not the editor", () => {
    // Monaco keeps `tabSize` / `insertSpaces` on the text model; passing them
    // to `editor.updateOptions` does nothing at all.
    const o = editorOptions(base({ tabSize: 2, insertSpaces: false })) as Record<string, unknown>;
    expect(o.tabSize).toBeUndefined();
    expect(o.insertSpaces).toBeUndefined();
    expect(modelOptions(base({ tabSize: 2, insertSpaces: false }))).toEqual({
      tabSize: 2,
      insertSpaces: false,
      trimAutoWhitespace: true,
    });
  });
});

describe("effectiveEditorSettings", () => {
  it("returns the globals unchanged when there is no override", () => {
    const s = base({ tabSize: 2 });
    expect(effectiveEditorSettings(s, "rust")).toBe(s);
    expect(effectiveEditorSettings(s, null)).toBe(s);
    expect(effectiveEditorSettings(s, undefined)).toBe(s);
  });

  it("falls back to the globals for a language nobody configured", () => {
    const s = base({ tabSize: 2, languageOverrides: { rust: { tabSize: 4 } } });
    expect(effectiveEditorSettings(s, "typescript")).toBe(s);
    expect(effectiveEditorSettings(s, "typescript").tabSize).toBe(2);
  });

  it("lets an override win per field, and only per field", () => {
    const s = base({
      tabSize: 2,
      insertSpaces: true,
      fontSize: 13,
      languageOverrides: { rust: { tabSize: 4, insertSpaces: false } },
    });
    const rust = effectiveEditorSettings(s, "rust");
    expect(rust.tabSize).toBe(4);
    expect(rust.insertSpaces).toBe(false);
    // Untouched by the patch, so the global still applies.
    expect(rust.fontSize).toBe(13);
    expect(rust.wordWrap).toBe("off");
    // …and resolving must not mutate the globals it resolved from.
    expect(s.tabSize).toBe(2);
  });

  it("keeps the override map itself off the resolved object", () => {
    // An override cannot carry overrides — resolution is one level deep by
    // construction, so a patched copy still sees the same map.
    const s = base({ languageOverrides: { rust: { tabSize: 4 } } });
    expect(effectiveEditorSettings(s, "rust").languageOverrides).toEqual({
      rust: { tabSize: 4 },
    });
  });

  it("composes with modelOptions and editorOptions", () => {
    const s = base({
      tabSize: 2,
      wordWrap: "off",
      languageOverrides: { rust: { tabSize: 4, wordWrap: "on" } },
    });
    expect(modelOptions(effectiveEditorSettings(s, "rust"))).toEqual({
      tabSize: 4,
      insertSpaces: true,
      trimAutoWhitespace: true,
    });
    expect(modelOptions(effectiveEditorSettings(s, "typescript")).tabSize).toBe(2);
    expect(editorOptions(effectiveEditorSettings(s, "rust")).wordWrap).toBe("on");
    expect(editorOptions(effectiveEditorSettings(s, "typescript")).wordWrap).toBe("off");
  });
});
