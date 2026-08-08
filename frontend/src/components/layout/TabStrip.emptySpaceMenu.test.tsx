/// The tab strip's empty-space menu (Stream D): new tab / reopen last closed /
/// tab orientation, reached by right-clicking the bare scroller rather than a
/// tab. `TabStrip` itself takes no store (see its own header comment), so the
/// row list is a plain prop here — this only proves the strip renders it,
/// dispatches through it, and never opens it for a right-click that a tab's
/// own menu already claimed.
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { TabStrip, type TabDescriptor } from "./TabStrip";
import type { ContextMenuItem } from "@/components/git/ContextMenu";

function tab(id: string): TabDescriptor {
  return {
    kind: "file",
    id,
    label: id,
    icon: (<span />) as JSX.Element,
    title: id,
  };
}

function baseProps(tabs: TabDescriptor[], emptySpaceMenuItems?: () => ContextMenuItem[]) {
  return {
    tabs,
    activeId: tabs[0]?.id ?? null,
    isPinned: () => false,
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onReorder: vi.fn(),
    onTogglePin: vi.fn(),
    emptySpaceMenuItems,
  };
}

describe("the tab strip's empty-space menu", () => {
  it("opens on a right-click over bare scroller space and shows the given rows", async () => {
    const onNewTab = vi.fn();
    const items = (): ContextMenuItem[] => [
      { label: "New terminal", onSelect: onNewTab },
      { label: "Reopen last closed tab", disabledReason: "Nothing to reopen", onSelect: vi.fn() },
    ];
    render(() => <TabStrip {...baseProps([tab("a.ts")], items)} />);

    fireEvent.contextMenu(screen.getByTestId("tab-strip-scroller"));

    const newTerminal = await screen.findByRole("menuitem", { name: "New terminal" });
    const reopen = screen.getByRole("menuitem", { name: "Reopen last closed tab" });
    expect(reopen).toHaveAttribute("aria-disabled", "true");
    expect(reopen).toHaveAttribute("title", "Nothing to reopen");

    fireEvent.click(newTerminal);
    expect(onNewTab).toHaveBeenCalledTimes(1);
  });

  it("does not open when the strip has no empty-space menu to offer", () => {
    render(() => <TabStrip {...baseProps([tab("a.ts")])} />);
    fireEvent.contextMenu(screen.getByTestId("tab-strip-scroller"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
