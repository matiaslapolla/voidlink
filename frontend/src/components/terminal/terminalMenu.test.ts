import { describe, expect, it, vi } from "vitest";
import { applicationOwnsMouse, terminalMenuItems, terminalMenuOpensOn } from "./terminalMenu";

describe("applicationOwnsMouse", () => {
  it("is false only for 'none'", () => {
    expect(applicationOwnsMouse("none")).toBe(false);
    for (const mode of ["x10", "vt200", "drag", "any"] as const) {
      expect(applicationOwnsMouse(mode)).toBe(true);
    }
  });
});

describe("terminalMenuOpensOn", () => {
  it("stands aside for a plain right-click, regardless of mouse tracking", () => {
    // Plain right-click pastes now (see `TerminalPane.tsx`'s `onContextMenu`,
    // which applies `applicationOwnsMouse` to decide paste-vs-yield-to-app) —
    // this predicate only answers "does the menu open", and the menu no
    // longer opens on a plain click either way.
    expect(terminalMenuOpensOn({ shiftKey: false })).toBe(false);
  });

  it("opens on Shift+right-click", () => {
    expect(terminalMenuOpensOn({ shiftKey: true })).toBe(true);
  });
});

/// A `TerminalMenuActions` with every required field filled in, so each test
/// only has to override what it's testing.
function actions(overrides: Partial<Parameters<typeof terminalMenuItems>[0]> = {}) {
  return {
    selection: "",
    onCopy: vi.fn(),
    onPaste: vi.fn(),
    onClear: vi.fn(),
    onSearchInFiles: vi.fn(),
    onOpenPath: vi.fn(),
    ...overrides,
  };
}

describe("terminalMenuItems", () => {
  it("disables Copy with a reason when nothing is selected", () => {
    const items = terminalMenuItems(actions());
    const copy = items.find((i) => i.label === "Copy")!;
    expect(copy.disabledReason).toBe("Nothing selected");
  });

  it("enables Copy and passes the selection through when there is one", () => {
    const onCopy = vi.fn();
    const items = terminalMenuItems(actions({ selection: "hello world", onCopy }));
    const copy = items.find((i) => i.label === "Copy")!;
    expect(copy.disabledReason).toBeUndefined();
    copy.onSelect();
    expect(onCopy).toHaveBeenCalledWith("hello world");
  });

  it("always offers Paste and Clear, dispatching to the given callbacks", () => {
    const onPaste = vi.fn();
    const onClear = vi.fn();
    const items = terminalMenuItems(actions({ onPaste, onClear }));
    items.find((i) => i.label === "Paste")!.onSelect();
    items.find((i) => i.label === "Clear")!.onSelect();
    expect(onPaste).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("offers Close terminal only when onClose is given, and runs it", () => {
    const withoutClose = terminalMenuItems(actions());
    expect(withoutClose.some((i) => i.label === "Close terminal")).toBe(false);

    const onClose = vi.fn();
    const withClose = terminalMenuItems(actions({ onClose }));
    const closeRow = withClose.find((i) => i.label === "Close terminal")!;
    expect(closeRow).toBeDefined();
    closeRow.onSelect();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("disables Search selection in files with a reason when nothing is selected", () => {
    const items = terminalMenuItems(actions());
    const row = items.find((i) => i.label === "Search selection in files")!;
    expect(row.disabledReason).toBe("Nothing selected");
  });

  it("enables Search selection in files and passes the selection through", () => {
    const onSearchInFiles = vi.fn();
    const items = terminalMenuItems(actions({ selection: "TODO", onSearchInFiles }));
    const row = items.find((i) => i.label === "Search selection in files")!;
    expect(row.disabledReason).toBeUndefined();
    row.onSelect();
    expect(onSearchInFiles).toHaveBeenCalledWith("TODO");
  });

  it("disables Open path in editor when nothing is selected", () => {
    const items = terminalMenuItems(actions());
    const row = items.find((i) => i.label === "Open path in editor")!;
    expect(row.disabledReason).toBe("Nothing selected");
  });

  it("disables Open path in editor with a different reason when the selection isn't a resolved path", () => {
    const items = terminalMenuItems(actions({ selection: "not a path" }));
    const row = items.find((i) => i.label === "Open path in editor")!;
    expect(row.disabledReason).toBe("Selection is not an existing file path");
  });

  it("enables Open path in editor once the selection resolves, and opens the resolved target", () => {
    const onOpenPath = vi.fn();
    const items = terminalMenuItems(
      actions({ selection: "src/main.rs", openPathTarget: "/repo/src/main.rs", onOpenPath }),
    );
    const row = items.find((i) => i.label === "Open path in editor")!;
    expect(row.disabledReason).toBeUndefined();
    row.onSelect();
    expect(onOpenPath).toHaveBeenCalledWith("/repo/src/main.rs");
  });
});
