import { describe, expect, it, vi } from "vitest";
import { terminalMenuItems } from "./terminalMenu";

describe("terminalMenuItems", () => {
  it("disables Copy with a reason when nothing is selected", () => {
    const items = terminalMenuItems({
      selection: "",
      onCopy: vi.fn(),
      onPaste: vi.fn(),
      onClear: vi.fn(),
    });
    const copy = items.find((i) => i.label === "Copy")!;
    expect(copy.disabledReason).toBe("Nothing selected");
  });

  it("enables Copy and passes the selection through when there is one", () => {
    const onCopy = vi.fn();
    const items = terminalMenuItems({
      selection: "hello world",
      onCopy,
      onPaste: vi.fn(),
      onClear: vi.fn(),
    });
    const copy = items.find((i) => i.label === "Copy")!;
    expect(copy.disabledReason).toBeUndefined();
    copy.onSelect();
    expect(onCopy).toHaveBeenCalledWith("hello world");
  });

  it("always offers Paste and Clear, dispatching to the given callbacks", () => {
    const onPaste = vi.fn();
    const onClear = vi.fn();
    const items = terminalMenuItems({ selection: "", onCopy: vi.fn(), onPaste, onClear });
    items.find((i) => i.label === "Paste")!.onSelect();
    items.find((i) => i.label === "Clear")!.onSelect();
    expect(onPaste).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("offers Close terminal only when onClose is given, and runs it", () => {
    const withoutClose = terminalMenuItems({
      selection: "",
      onCopy: vi.fn(),
      onPaste: vi.fn(),
      onClear: vi.fn(),
    });
    expect(withoutClose.some((i) => i.label === "Close terminal")).toBe(false);

    const onClose = vi.fn();
    const withClose = terminalMenuItems({
      selection: "",
      onCopy: vi.fn(),
      onPaste: vi.fn(),
      onClear: vi.fn(),
      onClose,
    });
    const closeRow = withClose.find((i) => i.label === "Close terminal")!;
    expect(closeRow).toBeDefined();
    closeRow.onSelect();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
