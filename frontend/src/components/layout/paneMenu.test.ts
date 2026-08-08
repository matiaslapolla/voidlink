import { describe, expect, it, vi } from "vitest";
import { paneMenuItems } from "./paneMenu";

function actions(overrides: Partial<Parameters<typeof paneMenuItems>[0]> = {}) {
  return {
    onSplitRight: vi.fn(),
    onSplitDown: vi.fn(),
    onClosePane: vi.fn(),
    canClosePane: true,
    onResetLayout: vi.fn(),
    canResetLayout: true,
    ...overrides,
  };
}

describe("paneMenuItems", () => {
  it("always offers split right and split down, enabled", () => {
    const items = paneMenuItems(actions());
    expect(items.find((i) => i.label === "Split right")?.disabledReason).toBeUndefined();
    expect(items.find((i) => i.label === "Split down")?.disabledReason).toBeUndefined();
  });

  it("dispatches each row to its own callback", () => {
    const a = actions();
    const items = paneMenuItems(a);
    items.find((i) => i.label === "Split right")!.onSelect();
    items.find((i) => i.label === "Split down")!.onSelect();
    items.find((i) => i.label === "Close pane")!.onSelect();
    items.find((i) => i.label === "Reset the pane layout")!.onSelect();
    expect(a.onSplitRight).toHaveBeenCalledTimes(1);
    expect(a.onSplitDown).toHaveBeenCalledTimes(1);
    expect(a.onClosePane).toHaveBeenCalledTimes(1);
    expect(a.onResetLayout).toHaveBeenCalledTimes(1);
  });

  it("disables Close pane and Reset layout with a reason when there is only one pane", () => {
    const items = paneMenuItems(actions({ canClosePane: false, canResetLayout: false }));
    expect(items.find((i) => i.label === "Close pane")?.disabledReason).toBe(
      "The last pane can't be closed",
    );
    expect(items.find((i) => i.label === "Reset the pane layout")?.disabledReason).toBe(
      "Only one pane is open",
    );
  });
});
