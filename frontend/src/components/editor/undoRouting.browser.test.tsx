/// Undo routing, measured against a real Monaco in a real browser.
///
/// This file exists because the thing it asserts is not guessable from the
/// source of either side. Monaco focuses a hidden 1×1 `<textarea>` and feeds
/// keystrokes through it, which makes it look — to `document.execCommand` and
/// to anyone reading the DOM — exactly like a plain editable field with a
/// native undo history. It is not one, and the difference is invisible until
/// something calls `execCommand("undo")` and nothing happens.
///
/// The first test is the measurement: it is what turned "clicking Edit > Undo
/// seems to do nothing" into a fact. Keep it even though `runUndoRedo` no
/// longer calls `execCommand` on this path — the day it looks safe to simplify
/// the router back to one line, this is the test that says why it is not.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { userEvent } from "vitest/browser";
import type * as Monaco from "monaco-editor";
import { loadMonaco } from "./monaco";
import { runUndoRedo } from "./undoRouting";

let monaco: typeof Monaco;
let host: HTMLDivElement;
let editor: Monaco.editor.IStandaloneCodeEditor;
let model: Monaco.editor.ITextModel;

beforeEach(async () => {
  monaco = await loadMonaco();
  host = document.createElement("div");
  host.style.width = "600px";
  host.style.height = "300px";
  document.body.appendChild(host);
  model = monaco.editor.createModel("hello", "plaintext");
  // `occurrencesHighlight: "off"` is teardown hygiene, not a behaviour choice.
  // Monaco's word highlighter runs an async pass per cursor move and cancels it
  // on dispose, and the cancellation surfaces as an unhandled `Canceled`
  // rejection that vitest reports against whichever test happened to be last.
  // The contribution has nothing to do with the undo stack.
  editor = monaco.editor.create(host, { model, occurrencesHighlight: "off" });
});

afterEach(() => {
  editor.dispose();
  model.dispose();
  host.remove();
});

/// Type through the real input path. Monaco's undo stack is built from what
/// arrives at its textarea, so `setValue` or `executeEdits` here would be
/// testing a different mechanism than the one the user drives.
async function type(text: string) {
  editor.focus();
  await userEvent.keyboard(text);
}

describe("undo routing", () => {
  it("is invisible to the browser's own editing history", async () => {
    await type(" world");
    const typed = model.getValue();
    expect(typed).not.toBe("hello");

    document.execCommand("undo");

    // The whole bug in one assertion: the buffer does not move. Monaco's
    // history lives in the model, and `execCommand` never reaches it.
    expect(model.getValue()).toBe(typed);
  });

  it("routes undo to the focused editor", async () => {
    await type(" world");
    expect(model.getValue()).not.toBe("hello");

    expect(runUndoRedo("undo")).toBe("monaco");
    expect(model.getValue()).toBe("hello");
  });

  it("routes redo to the focused editor too", async () => {
    await type(" world");
    const typed = model.getValue();

    runUndoRedo("undo");
    expect(model.getValue()).toBe("hello");

    expect(runUndoRedo("redo")).toBe("monaco");
    expect(model.getValue()).toBe(typed);
  });

  it("falls back to the document when no editor has focus", async () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    // The commit message box, the rename field, the search inputs: all plain
    // elements whose undo history really is the browser's, and all of which
    // would lose Undo entirely if the router sent everything to Monaco.
    expect(runUndoRedo("undo")).toBe("document");
    expect(editor.hasTextFocus()).toBe(false);

    input.remove();
  });
});
