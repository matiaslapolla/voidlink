/// **The shell must not remount anything when a sidebar changes edge.**
///
/// This is the one property in the docking work that a user would lose data
/// over rather than merely be annoyed by. The workbench body owns live PTYs
/// (`App.tsx`'s `workbench` comment says why it is rendered exactly once), and
/// a terminal that is torn down does not come back with its shell, its scroll
/// buffer or the process it was running. So "moving a panel across the window"
/// has to be a *style* change on elements that are already in the DOM, and the
/// assertions below are structural for that reason: same element instances,
/// same mount counts, only `order` different.
///
/// It cannot be checked by reading `AppShell.tsx` alone — the property is a
/// consequence of `sidebars` being a stable array whose `side`/`order` are
/// accessors, and the failure mode (passing a freshly-built array, or moving
/// the content between two lists) type-checks perfectly and looks right on a
/// screenshot until the first terminal dies.
import { describe, expect, it } from "vitest";
import { createSignal } from "solid-js";
import { render, screen } from "@solidjs/testing-library";
import { slotOrder, type DockSide } from "@/store/layout";

import { AppShell, type AppShellSidebar } from "./AppShell";

/// Counts every mount. A remount shows up here even if the DOM ends up looking
/// identical afterwards, which the element-identity assertions alone would miss.
function counted(id: string, onMount: () => void) {
  onMount();
  return <div data-testid={id} />;
}

function mount(order: DockSide[] = ["left", "right"]) {
  const mounts = { workbench: 0, files: 0, git: 0 };
  const [filesSide, setFilesSide] = createSignal<DockSide>(order[0]);
  const [gitSide, setGitSide] = createSignal<DockSide>(order[1]);
  const [filesIndex, setFilesIndex] = createSignal(0);
  const [gitIndex, setGitIndex] = createSignal(1);

  // Built once, exactly as `App.tsx` builds it. A test that rebuilt this array
  // per render would be testing a shell nobody ships.
  const sidebars: AppShellSidebar[] = [
    {
      id: "files",
      side: filesSide,
      order: () => slotOrder(filesSide(), filesIndex()),
      content: counted("files", () => mounts.files++),
    },
    {
      id: "git",
      side: gitSide,
      order: () => slotOrder(gitSide(), gitIndex()),
      content: counted("git", () => mounts.git++),
    },
  ];

  const { container } = render(() => (
    <AppShell
      fill
      titleBar={null}
      sidebars={sidebars}
      main={counted("workbench", () => mounts.workbench++)}
      statusBar={<div data-testid="status" />}
    />
  ));

  const slot = (id: string) =>
    container.querySelector(`[data-sidebar="${id}"]`) as HTMLElement;
  return { mounts, slot, setFilesSide, setGitSide, setFilesIndex, setGitIndex };
}

describe("a sidebar changing edge", () => {
  it("moves the element rather than recreating the subtree", () => {
    const { slot, setFilesSide } = mount();
    const filesSlot = slot("files");
    const filesEl = screen.getByTestId("files");
    const workbenchEl = screen.getByTestId("workbench");

    setFilesSide("right");

    // The very same nodes — not equal-looking replacements. `toBe` is identity.
    expect(slot("files")).toBe(filesSlot);
    expect(screen.getByTestId("files")).toBe(filesEl);
    expect(screen.getByTestId("workbench")).toBe(workbenchEl);
  });

  it("does not remount the workbench body, which owns the live PTYs", () => {
    const { mounts, setFilesSide, setGitSide } = mount();
    expect(mounts.workbench).toBe(1);

    setFilesSide("right");
    setGitSide("left");
    setFilesSide("left");

    expect(mounts.workbench).toBe(1);
    // Nor the panels themselves: a git panel that remounted would refetch the
    // whole repo state on every dock change.
    expect(mounts.files).toBe(1);
    expect(mounts.git).toBe(1);
  });

  it("expresses the move as flex order, with the workbench as the fixed point", () => {
    const { slot, setFilesSide } = mount();
    expect(Number(slot("files").style.order)).toBeLessThan(0);
    expect(Number(slot("git").style.order)).toBeGreaterThan(0);

    setFilesSide("right");

    expect(Number(slot("files").style.order)).toBeGreaterThan(0);
    expect(slot("files").dataset.dock).toBe("right");
  });

  it("reorders two panels sharing an edge without touching the DOM order", () => {
    const { slot, setGitSide, setFilesIndex, setGitIndex } = mount();
    const filesEl = screen.getByTestId("files");

    setGitSide("left");
    setGitIndex(0);
    setFilesIndex(1);

    expect(Number(slot("git").style.order)).toBeLessThan(
      Number(slot("files").style.order),
    );
    // DOM order is unchanged — the slots are still files-then-git — which is
    // precisely why nothing was unmounted to get here.
    const slots = [...document.querySelectorAll("[data-sidebar]")];
    expect(slots.map((el) => (el as HTMLElement).dataset.sidebar)).toEqual([
      "files",
      "git",
    ]);
    expect(screen.getByTestId("files")).toBe(filesEl);
  });
});

describe("island geometry", () => {
  it("gives every panel a slot that collapses when it renders nothing", () => {
    const sidebars: AppShellSidebar[] = [
      {
        id: "files",
        side: () => "left" as DockSide,
        order: () => slotOrder("left", 0),
        // A detached (or zen-hidden) panel renders nothing at all. The slot has
        // to be genuinely empty for `.island-slot:empty` to collapse it, so the
        // assertion is on child count rather than on visibility.
        content: null,
      },
    ];
    const { container } = render(() => (
      <AppShell
        fill
        titleBar={null}
        sidebars={sidebars}
        main={<div data-testid="workbench" />}
        statusBar={<div />}
      />
    ));
    const slot = container.querySelector('[data-sidebar="files"]')!;
    expect(slot.classList.contains("island-slot")).toBe(true);
    expect(slot.childElementCount).toBe(0);
  });
});
