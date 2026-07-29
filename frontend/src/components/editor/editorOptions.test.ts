import { describe, expect, it } from "vitest";
import { editorOptions, modelOptions } from "./monaco";
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
    wordWrap: "off",
    wordWrapColumn: 80,
    minimap: false,
    stickyScroll: false,
    bracketPairColorization: false,
    renderWhitespace: "selection",
    indentGuides: true,
    lineNumbers: "on",
    cursorStyle: "line",
    cursorBlinking: "blink",
    smoothScrolling: false,
    scrollBeyondLastLine: false,
    formatOnSave: false,
    trimTrailingWhitespaceOnSave: false,
    insertFinalNewlineOnSave: false,
    autoSave: "off",
    autoSaveDelayMs: 1000,
    vimMode: false,
    lspEnabled: false,
    lspServerPaths: {},
    ...overrides,
  };
}

describe("editorOptions", () => {
  it("keeps the chrome that is VoidLink's rather than the user's", () => {
    const o = editorOptions(base());
    expect(o.automaticLayout).toBe(true);
    expect(o.renderLineHighlight).toBe("line");
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
    });
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
    });
  });
});
