import { describe, expect, it, vi } from "vitest";
import type * as Monaco from "monaco-editor";
import {
  EDITOR_ACTIONS,
  editorPaletteActions,
  registerEditorActions,
  runEditorAction,
} from "./editorActions";
import { ACTION_IDS } from "@/commands/actionIds";

/// The smallest object `registerEditorActions` and `runEditorAction` actually
/// touch. A real Monaco editor needs a DOM; the contract under test is "one
/// `addAction` per entry, delegating to the right built-in", which does not.
function fakeEditor(available: string[] = []) {
  const added: Monaco.editor.IActionDescriptor[] = [];
  const ran: string[] = [];
  const disposed: string[] = [];
  const editor = {
    addAction(descriptor: Monaco.editor.IActionDescriptor) {
      added.push(descriptor);
      return { dispose: () => disposed.push(descriptor.id) };
    },
    getAction(id: string) {
      if (!available.includes(id)) return null;
      return { run: () => { ran.push(id); return Promise.resolve(); } };
    },
    focus() {},
  };
  return { editor: editor as unknown as Monaco.editor.IStandaloneCodeEditor, added, ran, disposed };
}

describe("EDITOR_ACTIONS", () => {
  it("has unique, namespaced ids", () => {
    const ids = EDITOR_ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith("editor.")).toBe(true);
  });

  it("delegates to a distinct Monaco built-in per entry", () => {
    const monacoIds = EDITOR_ACTIONS.map((a) => a.monacoId);
    expect(new Set(monacoIds).size).toBe(monacoIds.length);
    for (const id of monacoIds) expect(id.startsWith("editor.action.")).toBe(true);
  });

  it("does not collide with an existing VoidLink action id", () => {
    const existing = new Set<string>(ACTION_IDS);
    for (const def of EDITOR_ACTIONS) {
      // `editor.format-document` is declared in ACTION_IDS because the keymap
      // binds it; the rest must not shadow anything else.
      if (def.id === "editor.format-document") continue;
      expect(existing.has(def.id)).toBe(false);
    }
  });
});

describe("registerEditorActions", () => {
  it("contributes each action to the editor exactly once", () => {
    const { editor, added } = fakeEditor();
    registerEditorActions(editor);
    expect(added.map((a) => a.id)).toEqual(EDITOR_ACTIONS.map((a) => a.id));
  });

  it("is idempotent — a second call adds nothing", () => {
    // `init` can run again after `dispose` in stacked mode, and a Monaco action
    // id registered twice silently replaces the first while leaking its
    // disposable.
    const { editor, added } = fakeEditor();
    registerEditorActions(editor);
    registerEditorActions(editor);
    expect(added.length).toBe(EDITOR_ACTIONS.length);
  });

  it("registers independently per editor", () => {
    const a = fakeEditor();
    const b = fakeEditor();
    registerEditorActions(a.editor);
    registerEditorActions(b.editor);
    expect(a.added.length).toBe(EDITOR_ACTIONS.length);
    expect(b.added.length).toBe(EDITOR_ACTIONS.length);
  });

  it("disposes everything it added, and allows re-registration after", () => {
    const { editor, added, disposed } = fakeEditor();
    registerEditorActions(editor)();
    expect(disposed.length).toBe(EDITOR_ACTIONS.length);
    registerEditorActions(editor);
    expect(added.length).toBe(EDITOR_ACTIONS.length * 2);
  });
});

describe("runEditorAction", () => {
  const format = EDITOR_ACTIONS.find((a) => a.id === "editor.format-document")!;

  it("runs the Monaco built-in and reports success", () => {
    const { editor, ran } = fakeEditor([format.monacoId]);
    expect(runEditorAction(editor, format)).toBe(true);
    expect(ran).toEqual([format.monacoId]);
  });

  it("reports false when the built-in is absent rather than throwing", () => {
    // A language with no formatter registered is the normal case until the
    // LSP bridge lands — not an error to surface.
    const { editor, ran } = fakeEditor([]);
    expect(runEditorAction(editor, format)).toBe(false);
    expect(ran).toEqual([]);
  });

  it("reports false with no editor at all", () => {
    expect(runEditorAction(null, format)).toBe(false);
  });
});

describe("editorPaletteActions", () => {
  it("mirrors the table one-for-one, in the Editor group", () => {
    const actions = editorPaletteActions(() => null);
    expect(actions.map((a) => a.id)).toEqual(EDITOR_ACTIONS.map((a) => a.id));
    for (const a of actions) expect(a.group).toBe("Editor");
  });

  it("greys out every entry while no editor is attached", () => {
    const none = editorPaletteActions(() => null);
    expect(none.every((a) => a.enabled?.() === false)).toBe(true);

    const { editor } = fakeEditor();
    const some = editorPaletteActions(() => editor);
    expect(some.every((a) => a.enabled?.() === true)).toBe(true);
  });

  it("invokes the matching built-in when run", () => {
    const { editor, ran } = fakeEditor(EDITOR_ACTIONS.map((a) => a.monacoId));
    const actions = editorPaletteActions(() => editor);
    const toggle = actions.find((a) => a.id === "editor.toggle-line-comment")!;
    const spy = vi.fn(toggle.run);
    spy();
    expect(ran).toEqual(["editor.action.commentLine"]);
  });
});
